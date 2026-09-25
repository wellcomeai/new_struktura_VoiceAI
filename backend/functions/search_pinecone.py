# backend/functions/search_pinecone.py
"""
Функция для поиска в векторной базе данных Pinecone.
"""
import os
import json
import re
import asyncio
import requests
from typing import Dict, Any, Optional, List

from backend.core.logging import get_logger
from backend.functions.base import FunctionBase
from backend.functions.registry import register_function

logger = get_logger(__name__)

# Сколько текста базы знаний отдаём модели за один вызов функции — суммарно
# по всем найденным фрагментам. До этого лимита не было вообще: размер ответа
# определялся нарезкой базы, а она рубит текст только по пустой строке, так
# что база, вставленная одним куском, уезжала в модель целиком.
# Было 1000: первый фрагмент (~1000 символов при нарезке базы) съедал весь
# бюджет, и до модели доходил один кусок — часто не тот (например, шапка со
# справочником синонимов вместо прайса).
MAX_RESULT_CHARS = 3500

# Потолок на один фрагмент: самый релевантный кусок не должен вытеснять
# остальные, чтобы модель получала 3–4 фрагмента, а не один.
MAX_FRAGMENT_CHARS = 1200

# Порог релевантности (cosine, text-embedding-3-small). Pinecone всегда отдаёт
# top_k ближайших, даже совсем не по теме; ниже порога фрагмент отбрасываем.
# Релевантные совпадения на реальных базах — 0.45–0.7, мусор — до ~0.2.
MIN_SCORE = 0.25

# Что говорим модели, если по запросу ничего релевантного нет.
NOT_FOUND_MESSAGE = (
    "В базе знаний нет информации по этому запросу. Не придумывай ответ: "
    "скажи клиенту, что уточнишь, или переформулируй запрос и поищи ещё раз."
)

# Огрызок короче этого в ответ не кладём: пользы от него нет, а место в
# бюджете он занимает. Поэтому последний фрагмент либо влезает осмысленным
# куском, либо не добавляется вовсе.
MIN_FRAGMENT_CHARS = 200

# Границы top_k. Параметр приходит от модели, и без потолка она может
# запросить хоть сотню фрагментов.
TOP_K_DEFAULT, TOP_K_MIN, TOP_K_MAX = 3, 1, 10


def _clamp_top_k(value: Any) -> int:
    """top_k из аргументов модели → целое в допустимых границах."""
    try:
        top_k = int(value)
    except (TypeError, ValueError):
        return TOP_K_DEFAULT
    return max(TOP_K_MIN, min(TOP_K_MAX, top_k))


def _trim(text: str, limit: int) -> str:
    """Обрезать текст до limit символов по границе предложения или слова."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    # Предпочитаем конец предложения, иначе конец слова — рвать слово посередине
    # незачем, модель потом это зачитывает вслух.
    for sep in (". ", "! ", "? ", "\n", " "):
        pos = cut.rfind(sep)
        if pos >= limit // 2:
            return cut[:pos + len(sep)].strip()
    return cut.strip()


def extract_namespace_from_prompt(prompt: str) -> Optional[str]:
    """
    Извлекает namespace Pinecone из системного промпта ассистента.
    """
    if not prompt:
        return None
        
    # Ищем namespace с помощью регулярного выражения
    # Паттерн 1: "Pinecone namespace: my_namespace"
    pattern1 = r'Pinecone\s+namespace:\s*([a-zA-Z0-9_-]+)'
    # Паттерн 2: "namespace: my_namespace"
    pattern2 = r'namespace:\s*([a-zA-Z0-9_-]+)'
    
    # Проверяем шаблоны по убыванию специфичности
    for pattern in [pattern1, pattern2]:
        matches = re.findall(pattern, prompt, re.IGNORECASE)
        if matches:
            return matches[0]
            
    return None

# (connect, read) таймауты HTTP-запросов к OpenAI и Pinecone
HTTP_TIMEOUT = (5, 20)


def _embed_and_query_sync(query: str, openai_api_key: str, pinecone_api_key: str, namespace: str, top_k: int):
    """
    Эмбеддинг запроса через OpenAI и поиск в Pinecone. Синхронно (requests),
    поэтому вызывается только через asyncio.to_thread. Возвращает (error, results):
    error — словарь {"error": ...} для ответа модели, results — JSON ответа Pinecone.
    """
    embed_response = requests.post(
        "https://api.openai.com/v1/embeddings",
        headers={
            "Authorization": f"Bearer {openai_api_key}",
            "Content-Type": "application/json"
        },
        json={
            "input": query,
            # Должно совпадать с моделью при создании базы
            # (PineconeService.create_or_update_knowledge_base), иначе
            # вектора окажутся в разных пространствах и поиск будет нерелевантным.
            "model": "text-embedding-3-small"
        },
        timeout=HTTP_TIMEOUT,
    )
    if embed_response.status_code != 200:
        logger.error(f"Error creating embedding: {embed_response.text}")
        return {"error": f"Failed to create embedding: {embed_response.status_code}"}, None

    embedding = embed_response.json().get("data", [{}])[0].get("embedding", [])
    if not embedding:
        return {"error": "Failed to generate embedding for query"}, None

    pinecone_url = "https://voicufi-gpr1sqd.svc.aped-4627-b74a.pinecone.io/query"
    pinecone_response = requests.post(
        pinecone_url,
        headers={
            "Api-Key": pinecone_api_key,
            "Content-Type": "application/json"
        },
        json={
            "vector": embedding,
            "namespace": namespace,
            "topK": top_k,
            "includeMetadata": True
        },
        timeout=HTTP_TIMEOUT,
    )
    if pinecone_response.status_code != 200:
        logger.error(f"Error from Pinecone: {pinecone_response.text}")
        return {"error": f"Pinecone query failed: {pinecone_response.status_code}"}, None

    return None, pinecone_response.json()


@register_function
class PineconeSearchFunction(FunctionBase):
    """Функция для поиска в векторной базе данных Pinecone"""
    
    @classmethod
    def get_name(cls) -> str:
        return "search_pinecone"
    
    @classmethod
    def get_display_name(cls) -> str:
        return "Поиск в Pinecone (векторная БД)"
    
    @classmethod
    def get_description(cls) -> str:
        return "Ищет похожие документы в Pinecone векторной базе данных"
    
    @classmethod
    def get_parameters(cls) -> Dict[str, Any]:
        # namespace НЕ выносим в параметры: его выбирает сервер
        # (из AgentConfig.kb_namespace или системного промпта). Иначе модель
        # галлюцинирует namespace (например имя индекса) и поиск ничего не находит.
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Поисковый запрос для векторного поиска"
                },
                "top_k": {
                    "type": "integer",
                    "description": (
                        f"Количество результатов для возврата "
                        f"({TOP_K_MIN}–{TOP_K_MAX}, по умолчанию {TOP_K_DEFAULT})"
                    ),
                    "default": TOP_K_DEFAULT,
                    "minimum": TOP_K_MIN,
                    "maximum": TOP_K_MAX,
                }
            },
            "required": ["query"]
        }
    
    @classmethod
    def get_example_prompt(cls) -> str:
        return """
<p>Ты можешь использовать функцию <code>search_pinecone</code> для поиска релевантной информации в векторной базе данных.</p>

<p><strong>Что такое Pinecone?</strong></p>
<p>Векторная база данных для семантического поиска. Позволяет находить похожие документы по смыслу, а не по точному совпадению слов.</p>

<p><strong>Когда использовать:</strong></p>
<ul>
    <li>Пользователь задает вопрос о продуктах, услугах, документации</li>
    <li>Нужно найти релевантную информацию из большой базы знаний</li>
    <li>Требуется контекст для более точного ответа</li>
    <li>Поиск по FAQ, инструкциям, каталогам</li>
</ul>

<p><strong>Настройка в промпте:</strong></p>
<p>Укажи в системном промпте namespace Pinecone:</p>
<pre>Pinecone namespace: my_knowledge_base</pre>

<p><strong>Параметры функции:</strong></p>
<ul>
    <li><code>namespace</code> — имя namespace в Pinecone (можно указать в промпте)</li>
    <li><code>query</code> — поисковый запрос пользователя или его перефразировка</li>
    <li><code>top_k</code> — количество результатов (по умолчанию 3, можно 5-10)</li>
</ul>

<p><strong>Пример вызова:</strong></p>
<pre>{
  "namespace": "my_knowledge_base",
  "query": "Как работает векторный поиск?",
  "top_k": 5
}</pre>

<p><strong>Результат:</strong></p>
<pre>{
  "success": true,
  "query": "Как работает векторный поиск?",
  "namespace": "my_knowledge_base",
  "results": [
    {
      "id": "doc_123",
      "score": 0.92,
      "metadata": {
        "text": "Векторный поиск использует...",
        "title": "Введение в поиск",
        "category": "Документация"
      }
    },
    ...
  ],
  "total": 5
}</pre>

<p><strong>💡 Совет:</strong> После получения результатов используй информацию из <code>metadata</code> для формирования более точного и информативного ответа пользователю.</p>

<p><strong>⚙️ Требования:</strong></p>
<ul>
    <li>Переменная окружения <code>PINECONE_API_KEY</code> должна быть настроена</li>
    <li>OpenAI API ключ для создания эмбеддингов</li>
</ul>
"""
        
    @staticmethod
    async def execute(arguments: Dict[str, Any], context: Dict[str, Any] = None) -> Dict[str, Any]:
        """
        Выполняет векторный поиск в Pinecone.
        """
        context = context or {}
        assistant_config = context.get("assistant_config")
        
        try:
            query = arguments.get("query")
            top_k = _clamp_top_k(arguments.get("top_k", TOP_K_DEFAULT))

            # Проверка обязательных параметров
            if not query:
                return {"error": "Query is required"}

            # ВАЖНО: namespace резолвим на СЕРВЕРЕ, а не из аргументов модели.
            # Модель часто галлюцинирует namespace (например имя индекса
            # "voicyfy"), из-за чего поиск идёт в несуществующем namespace и
            # ничего не находит. Поэтому приоритет:
            #   1) AgentConfig.kb_namespace (агент обзвона хранит namespace у себя)
            #   2) namespace из системного промпта (отдельные ассистенты)
            #   3) аргумент модели — только как legacy-фолбэк
            namespace = None

            # 1. AgentConfig.kb_namespace по id голосового ассистента
            if assistant_config and getattr(assistant_config, "id", None):
                try:
                    from backend.db.session import get_db
                    from backend.models.agent_config import AgentConfig
                    from sqlalchemy import or_

                    _db = getattr(assistant_config, "db_session", None)
                    _own = False
                    if _db is None:
                        _db = next(get_db())
                        _own = True
                    try:
                        a_id = assistant_config.id
                        agent = _db.query(AgentConfig).filter(
                            or_(
                                AgentConfig.openai_assistant_id == a_id,
                                AgentConfig.gemini_assistant_id == a_id,
                                AgentConfig.cartesia_assistant_id == a_id,
                                AgentConfig.yandex_assistant_id == a_id,
                                AgentConfig.cascade_assistant_id == a_id,
                                AgentConfig.fish_assistant_id == a_id,
                            )
                        ).first()
                        if agent and agent.kb_namespace:
                            namespace = agent.kb_namespace
                            logger.info(f"Namespace взят из AgentConfig: {namespace}")
                    finally:
                        if _own:
                            _db.close()
                except Exception as e:
                    logger.warning(f"Не удалось получить namespace из AgentConfig: {e}")

            # 2. Из системного промпта ассистента
            if not namespace and assistant_config:
                if hasattr(assistant_config, "system_prompt") and assistant_config.system_prompt:
                    namespace = extract_namespace_from_prompt(assistant_config.system_prompt)
                    if namespace:
                        logger.info(f"Извлечен namespace из промпта: {namespace}")

            # 3. Legacy-фолбэк — аргумент модели
            if not namespace:
                namespace = arguments.get("namespace")

            # Проверка на наличие namespace
            if not namespace:
                return {"error": "Namespace is required"}
            
            # Получение ключа Pinecone из переменных окружения
            pinecone_api_key = os.environ.get("PINECONE_API_KEY")
            if not pinecone_api_key:
                logger.error("PINECONE_API_KEY not found in environment variables")
                return {"error": "Pinecone API key not configured"}
            
            # Создаем эмбеддинг через OpenAI API
            openai_api_key = None
            if assistant_config and hasattr(assistant_config, "user_id"):
                # Импортируем здесь, чтобы избежать циклических импортов
                from backend.models.user import User
                
                # Получаем сессию базы данных
                db_session = getattr(assistant_config, 'db_session', None)
                own_session = db_session is None
                if own_session:
                    # Своя сессия — обязательно закрываем, иначе соединение утекает из пула
                    from backend.db.session import SessionLocal
                    db_session = SessionLocal()
                try:
                    # Получаем пользователя и его API ключ
                    user = db_session.query(User).get(assistant_config.user_id)
                    if user and user.openai_api_key:
                        openai_api_key = user.openai_api_key
                finally:
                    if own_session:
                        db_session.close()
            
            if not openai_api_key:
                # Попытка использовать ключ из переменных окружения
                openai_api_key = os.environ.get("OPENAI_API_KEY")
                if not openai_api_key:
                    return {"error": "OpenAI API key not available"}
            
            # Создаем эмбеддинг через OpenAI API
            # Два HTTP-запроса (OpenAI + Pinecone) — в отдельном потоке и с таймаутами.
            # Раньше они шли синхронно внутри async-функции и без таймаута: зависший
            # ответ останавливал весь процесс (все звонки и виджеты) до перезапуска.
            error, results = await asyncio.to_thread(
                _embed_and_query_sync, query, openai_api_key, pinecone_api_key, namespace, top_k
            )
            if error:
                return error
            
            # Форматируем результаты и укладываемся в бюджет MAX_RESULT_CHARS.
            # Фрагменты идут от самого релевантного к менее релевантным (так их
            # отдаёт Pinecone), поэтому просто набираем, пока есть место.
            formatted_results = []
            budget = MAX_RESULT_CHARS
            truncated = False
            matches = results.get("matches", []) or []
            below_threshold = 0

            for match in matches:
                score = match.get("score") or 0
                if score < MIN_SCORE:
                    below_threshold += 1
                    continue

                metadata = dict(match.get("metadata") or {})
                text = metadata.get("text") or ""

                if text:
                    if budget < MIN_FRAGMENT_CHARS:
                        truncated = True
                        break
                    limit = min(MAX_FRAGMENT_CHARS, budget)
                    if len(text) > limit:
                        text = _trim(text, limit)
                        truncated = True
                    metadata["text"] = text
                    budget -= len(text)

                formatted_results.append({
                    "id": match.get("id"),
                    "score": score,
                    "metadata": metadata,
                })

            chars_returned = MAX_RESULT_CHARS - budget
            scores = ",".join(f"{(m.get('score') or 0):.2f}" for m in matches)
            logger.info(
                f"[PINECONE] namespace={namespace} top_k={top_k} "
                f"matches={len(matches)} scores=[{scores}] "
                f"below_threshold={below_threshold} "
                f"returned={len(formatted_results)} chars={chars_returned}"
                + (" (обрезано)" if truncated else "")
            )

            response = {
                "success": True,
                "query": query,
                "namespace": namespace,
                "results": formatted_results,
                "total": len(formatted_results),
                "chars_returned": chars_returned,
                "truncated": truncated,
            }
            if not formatted_results:
                response["found"] = False
                response["message"] = NOT_FOUND_MESSAGE
            return response
            
        except Exception as e:
            logger.error(f"Error in search_pinecone: {str(e)}")
            return {"error": f"Search failed: {str(e)}"}

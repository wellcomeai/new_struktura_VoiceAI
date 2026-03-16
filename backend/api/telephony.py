"""
API Endpoints для страницы "Телефония".

Обеспечивает полный цикл работы с партнёрской телефонией Voximplant:
- Подключение телефонии (создание дочернего аккаунта)
- Верификация аккаунта
- Биллинг и пополнение баланса
- Покупка и управление номерами
- Привязка номеров к ассистентам
- Конфигурация для сценариев Voximplant
- Исходящие звонки (outbound calls)
- Service Account для JWT авторизации (secure records)
- Получение данных звонка по session ID

Routes:
    POST   /api/telephony/setup              - Подключить телефонию
    GET    /api/telephony/status             - Статус подключения
    GET    /api/telephony/verification-url   - Ссылка на верификацию
    GET    /api/telephony/billing-url        - Ссылка на биллинг
    GET    /api/telephony/balance            - Баланс аккаунта
    GET    /api/telephony/available-numbers  - Доступные номера для покупки
    POST   /api/telephony/buy-number         - Купить номер
    GET    /api/telephony/my-numbers         - Мои номера
    POST   /api/telephony/bind-assistant     - Привязать номер к ассистенту
    GET    /api/telephony/config             - Конфиг для сценария (публичный, inbound)
    GET    /api/telephony/outbound-config    - Конфиг для исходящего сценария (публичный)
    GET    /api/telephony/call/{id}          - Получить данные звонка по Voximplant session ID
    POST   /api/telephony/start-outbound-call - Запустить исходящий звонок
    POST   /api/telephony/public/call        - Публичный эндпоинт для исходящих звонков
    GET    /api/telephony/call-history       - История звонков (последние N)
    POST   /api/telephony/register-webhook   - Зарегистрировать webhook
    GET    /api/telephony/scenarios          - Список сценариев аккаунта
    POST   /api/telephony/setup-scenarios    - Настроить сценарии
    POST   /api/telephony/repair-numbers     - Починить номера с отсутствующим phone_id
    POST   /api/telephony/admin/update-all-scenarios - 🔐 Обновить сценарии у всех аккаунтов
    POST   /api/telephony/admin/setup-outbound-rules - 🔐 Создать outbound rules для всех аккаунтов
    POST   /api/telephony/admin/setup-service-accounts - 🔐 Создать Service Account для всех аккаунтов
    POST   /api/telephony/admin/setup-cartesia-scenarios - 🔐 Скопировать Cartesia сценарии на все аккаунты

✅ v1.0: Базовый функционал партнёрской интеграции
✅ v1.1: Исправлен регистр enum (lowercase)
✅ v1.2: Исправлен webhook для приёма callbacks от Voximplant
✅ v1.7: Автоматическая регистрация webhook при создании аккаунта
✅ v1.8: Автоматическое создание приложения и копирование сценариев при setup_telephony
✅ v1.9: Создание Rule при покупке номера, смена сценария при bind_assistant
✅ v2.0: Исправлен setup_scenarios - использует существующее приложение если оно уже есть
✅ v2.1: Валидация phone_id, защита от записи "None" в БД, endpoint repair-numbers
✅ v2.2: Расширенный /config - функции, язык, thinking, единый api_key
✅ v2.3: Admin endpoint для массового обновления сценариев
✅ v2.4: bind_assistant - DELETE + RECREATE Rule (SetRuleInfo не меняет сценарий)
✅ v3.0: OUTBOUND CALLS - полная поддержка исходящих звонков:
         - Сохранение vox_rule_ids при setup_telephony
         - Endpoint /start-outbound-call для запуска исходящих
         - Endpoint /outbound-config для конфига исходящих сценариев
         - Admin endpoint /admin/setup-outbound-rules для миграции
✅ v3.1: PHONE INFO - добавлена информация о номерах из Voximplant API:
         - phone_next_renewal - дата следующей оплаты
         - phone_price - стоимость аренды номера в месяц
✅ v3.2: SERVICE ACCOUNT - JWT авторизация для secure записей:
         - Автоматическое создание Service Account при setup_telephony
         - Admin endpoint /admin/setup-service-accounts для миграции
         - Сохранение vox_service_account_id и vox_service_account_key
✅ v3.3: PUBLIC CALL SESSION IDS - возврат session_ids в ответе /public/call
✅ v3.4: PUBLIC CALL LOOKUP - получение данных звонка по session_history_id
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status, Body
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone, timedelta
import uuid
import json

from backend.db.session import get_db
from backend.core.dependencies import get_current_user
from backend.core.logging import get_logger
from backend.core.config import settings
from backend.models.user import User
from backend.models.voximplant_child import (
    VoximplantChildAccount,
    VoximplantPhoneNumber,
    VoximplantVerificationStatus
)
from backend.services.voximplant_partner import (
    VoximplantPartnerService,
    get_voximplant_partner_service,
    SIP_PROVIDER_IPS,
    SIP_PROVIDER_PROXIES,
)
from backend.api.voximplant import build_functions_for_openai

logger = get_logger(__name__)

router = APIRouter()

# ChatForYou Bot для анализа логов
CHATFORYOU_BOT_ID = "57344"
CHATFORYOU_BOT_TOKEN = "mpdLoMqXNo9dPVdDYxDxZj1HX605dsda"
CHATFORYOU_API_URL = f"https://api.chatforyou.ru/api/v1.0/ask/{CHATFORYOU_BOT_TOKEN}"


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def get_scenario_key(assistant_type: str, direction: str) -> str:
    """
    Возвращает ключ сценария в vox_scenario_ids.
    direction: 'inbound' или 'outbound'
    """
    if assistant_type == "cartesia":
        return f"cartesia_{direction}"  # cartesia_inbound / cartesia_outbound
    return f"{direction}_{assistant_type}"  # inbound_openai / outbound_gemini


def validate_phone_id(phone_id: any) -> Optional[str]:
    """
    Валидация phone_id - защита от записи "None" в БД.

    Args:
        phone_id: Значение phone_id из API

    Returns:
        Валидный phone_id как строка или None
    """
    if phone_id is None:
        return None
    
    phone_id_str = str(phone_id)
    
    # Проверяем на невалидные значения
    invalid_values = ("None", "null", "", "undefined")
    if phone_id_str in invalid_values:
        return None
    
    return phone_id_str


def normalize_phone_number(phone: str) -> str:
    """Нормализация номера телефона - только цифры."""
    return ''.join(filter(str.isdigit, phone))


def find_assistant_by_id(db: Session, assistant_id: uuid.UUID) -> tuple[Any, str, uuid.UUID]:
    """
    Найти ассистента по UUID в обеих таблицах.
    
    Args:
        db: Сессия БД
        assistant_id: UUID ассистента
        
    Returns:
        tuple[assistant, assistant_type, user_id] или raises HTTPException
    """
    # Сначала ищем в OpenAI
    from backend.models.assistant import AssistantConfig
    assistant = db.query(AssistantConfig).filter(
        AssistantConfig.id == assistant_id
    ).first()
    
    if assistant:
        return assistant, "openai", assistant.user_id
    
    # Если не нашли - ищем в Gemini
    from backend.models.gemini_assistant import GeminiAssistantConfig
    assistant = db.query(GeminiAssistantConfig).filter(
        GeminiAssistantConfig.id == assistant_id
    ).first()

    if assistant:
        return assistant, "gemini", assistant.user_id

    # Если не нашли - ищем в Cartesia
    from backend.models.cartesia_assistant import CartesiaAssistantConfig
    assistant = db.query(CartesiaAssistantConfig).filter(
        CartesiaAssistantConfig.id == assistant_id
    ).first()

    if assistant:
        return assistant, "cartesia", assistant.user_id

    return None, None, None


# =============================================================================
# PYDANTIC SCHEMAS
# =============================================================================

class TelephonySetupRequest(BaseModel):
    """Запрос на подключение телефонии"""
    verification_type: str = Field(
        default="legal_entity",
        description="Тип верификации: individual, legal_entity, entrepreneur"
    )


class TelephonySetupResponse(BaseModel):
    """Ответ на подключение телефонии"""
    success: bool
    message: str
    account_id: Optional[str] = None
    verification_url: Optional[str] = None
    scenarios_copied: Optional[int] = None
    outbound_rules_created: Optional[int] = None
    service_account_created: Optional[bool] = None  # 🆕 v3.2


class TelephonyStatusResponse(BaseModel):
    """Статус телефонии"""
    is_connected: bool
    verification_status: str
    is_verified: bool
    balance: Optional[float] = None
    numbers_count: int = 0
    account_id: Optional[str] = None
    has_scenarios: bool = False
    has_outbound_rules: bool = False
    can_make_outbound_calls: bool = False
    has_service_account: bool = False  # 🆕 v3.2


class PhoneNumberInfo(BaseModel):
    """Информация о номере для покупки"""
    phone_number: str
    phone_price: Optional[float] = None
    phone_installation_price: Optional[float] = None
    region: Optional[str] = None


class AvailableNumbersResponse(BaseModel):
    """Список доступных номеров"""
    success: bool
    numbers: List[PhoneNumberInfo]
    total: int


class BuyNumberRequest(BaseModel):
    """Запрос на покупку номера"""
    phone_number: str


class BuyNumberResponse(BaseModel):
    """Ответ на покупку номера"""
    success: bool
    message: str
    phone_id: Optional[str] = None
    phone_number: Optional[str] = None


class MyNumberInfo(BaseModel):
    """Информация о моём номере"""
    id: str
    phone_number: str
    phone_region: Optional[str] = None
    assistant_type: Optional[str] = None
    assistant_id: Optional[str] = None
    assistant_name: Optional[str] = None
    first_phrase: Optional[str] = None
    is_active: bool
    phone_next_renewal: Optional[str] = None
    phone_price: Optional[float] = None


class BindAssistantRequest(BaseModel):
    """Запрос на привязку ассистента к номеру"""
    phone_number_id: str
    assistant_type: str
    assistant_id: str
    first_phrase: Optional[str] = None


class SipConnectRequest(BaseModel):
    """Запрос на подключение SIP транка"""
    provider: str           # "novofon" | "mango" | "sipuni" | "other"
    sip_proxy: str          # автозаполняется для известных, вводится вручную для "other"
    sip_login: str
    sip_password: str
    phone_number: str       # номер клиента у SIP провайдера (для входящих)
    assistant_id: str
    assistant_type: str     # "gemini" | "openai" | "cartesia"
    first_phrase: Optional[str] = None
    custom_proxy: Optional[str] = None  # только для provider="other"


# Словарь инструкций для провайдеров
SIP_PROVIDER_INSTRUCTIONS = {
    "novofon": "В кабинете Новофон перейдите в SIP URI / SIP Trunk и добавьте адрес терминации, указанный выше.",
    "mango":   "В Манго Офис перейдите в Настройки → Безопасность, добавьте IP Voximplant в whitelist. Затем в разделе 'Обработка звонков' настройте переадресацию на указанный адрес.",
    "sipuni":  "В кабинете Sipuni укажите адрес терминации в настройках SIP транка.",
    "other":   "Укажите адрес терминации как SIP URI для входящих звонков в кабинете вашего провайдера.",
}


class ScenarioConfigResponse(BaseModel):
    """Конфиг для сценария Voximplant"""
    success: bool
    assistant_type: Optional[str] = None
    assistant_id: Optional[str] = None
    assistant_name: Optional[str] = None
    api_key: Optional[str] = None
    system_prompt: Optional[str] = None
    first_phrase: Optional[str] = None
    voice: Optional[str] = None
    language: Optional[str] = None
    functions: Optional[List[Dict]] = None
    google_sheet_id: Optional[str] = None
    model: Optional[str] = None
    enable_thinking: Optional[bool] = None
    thinking_budget: Optional[int] = None
    # Cartesia-specific
    cartesia_voice_id: Optional[str] = None
    voice_speed: Optional[float] = None
    cartesia_api_key: Optional[str] = None


class StartOutboundCallRequest(BaseModel):
    """Запрос на запуск исходящего звонка"""
    phone_number_id: str = Field(..., description="UUID номера для caller_id (с какого звоним)")
    target_phones: List[str] = Field(..., min_length=1, max_length=50, description="Список номеров для обзвона (до 50)")
    assistant_id: str = Field(..., description="UUID ассистента")
    assistant_type: str = Field(..., description="Тип ассистента: openai или gemini")
    first_phrase: Optional[str] = Field(None, description="Первая фраза (опционально)")
    mute_duration_ms: int = Field(default=3000, ge=0, le=10000, description="Время мьюта микрофона клиента (мс)")
    task: Optional[str] = Field(None, description="Задача/контекст для звонка (инжектируется в начало промпта)")


class StartOutboundCallResponse(BaseModel):
    """Ответ на запуск исходящих звонков"""
    success: bool
    message: str
    total_requested: int
    started: int
    failed: int
    results: List[Dict[str, Any]]


class OutboundConfigResponse(BaseModel):
    """Конфиг для исходящего сценария Voximplant"""
    success: bool
    assistant_type: Optional[str] = None
    assistant_id: Optional[str] = None
    assistant_name: Optional[str] = None
    api_key: Optional[str] = None
    system_prompt: Optional[str] = None
    first_phrase: Optional[str] = None
    voice: Optional[str] = None
    language: Optional[str] = None
    functions: Optional[List[Dict]] = None
    google_sheet_id: Optional[str] = None
    model: Optional[str] = None
    enable_thinking: Optional[bool] = None
    thinking_budget: Optional[int] = None
    # Cartesia-specific
    cartesia_voice_id: Optional[str] = None
    voice_speed: Optional[float] = None
    cartesia_api_key: Optional[str] = None


class PublicCallRequest(BaseModel):
    """Запрос на запуск исходящего звонка через публичный API."""
    assistant_id: str = Field(..., description="UUID ассистента (служит ключом доступа)")
    target_phones: List[str] = Field(..., min_length=1, max_length=50, description="Список номеров для обзвона (до 50)")
    caller_phone: Optional[str] = Field(None, description="Номер для caller_id. Если не указан - берётся первый доступный")
    first_phrase: Optional[str] = Field(None, description="Первая фраза (опционально)")
    mute_duration_ms: int = Field(default=3000, ge=0, le=10000, description="Время мьюта микрофона клиента (мс)")
    task: Optional[str] = Field(None, description="Задача/контекст для звонка (инжектируется в начало промпта)")


class PublicCallResponse(BaseModel):
    """Ответ на запуск исходящих звонков через публичный API."""
    success: bool
    message: str
    started: int = 0
    failed: int = 0
    session_ids: List[str] = []  # 🆕 v3.3: ID сессий запущенных звонков от Voximplant


class CallHistoryItem(BaseModel):
    """Один звонок из истории"""
    session_id: str
    start_date: str
    rule_name: Optional[str] = None
    duration: int = 0
    finish_reason: Optional[str] = None
    caller_number: Optional[str] = None
    target_number: Optional[str] = None
    call_duration: int = 0
    call_cost: float = 0
    websocket_cost: float = 0
    total_cost: float = 0
    record_url: Optional[str] = None
    log_url: Optional[str] = None
    assistant_type: Optional[str] = None
    custom_greeting: Optional[str] = None
    is_incoming: Optional[bool] = None


class CallHistoryResponse(BaseModel):
    """Ответ с историей звонков"""
    success: bool
    calls: List[CallHistoryItem]
    total: int


class AnalyzeLogRequest(BaseModel):
    """Запрос на анализ лога через ИИ"""
    log_url: Optional[str] = Field(None, description="URL лога звонка (только для первого запроса)")
    chat_id: str = Field(..., description="Уникальный ID чата для сессии")
    message: Optional[str] = Field(None, description="Сообщение пользователя (для продолжения диалога)")


class AnalyzeLogResponse(BaseModel):
    """Ответ от ИИ-бота"""
    success: bool
    response: Optional[str] = None
    error: Optional[str] = None
    usage: Optional[Dict[str, int]] = None


# =============================================================================
# ENDPOINTS: ДОСТУПНЫЕ НОМЕРА ДЛЯ CALLER ID
# =============================================================================

@router.get("/my-phone-numbers")
async def get_available_phone_numbers(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получить список доступных номеров телефона для исходящих звонков.
    Используется для выбора caller_id при создании задачи.

    Возвращает:
    - phone_numbers: Список номеров с информацией об активности
    """
    try:
        # Находим дочерний аккаунт пользователя
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == current_user.id
        ).first()

        if not child_account:
            return {"phone_numbers": [], "total": 0}

        # Получаем все номера
        phone_numbers = db.query(VoximplantPhoneNumber).filter(
            VoximplantPhoneNumber.child_account_id == child_account.id
        ).order_by(VoximplantPhoneNumber.purchased_at).all()

        result = []
        for pn in phone_numbers:
            result.append({
                "phone_number": pn.phone_number,
                "is_active": pn.is_active,
                "phone_region": pn.phone_region,
                "assistant_type": pn.assistant_type,
                "expires_at": pn.expires_at.isoformat() if pn.expires_at else None
            })

        return {
            "phone_numbers": result,
            "total": len(result)
        }

    except Exception as e:
        logger.error(f"Error getting phone numbers: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get phone numbers: {str(e)}"
        )


# =============================================================================
# ENDPOINTS: ПОДКЛЮЧЕНИЕ И СТАТУС
# =============================================================================

@router.post("/setup", response_model=TelephonySetupResponse)
async def setup_telephony(
    request: TelephonySetupRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Подключить телефонию.
    
    Создаёт дочерний аккаунт Voximplant для пользователя.
    Возвращает ссылку на верификацию.
    
    **Процесс v3.2:**
    1. Проверяем, нет ли уже аккаунта
    2. Создаём/клонируем дочерний аккаунт
    3. Создаём SubUser для верификации/биллинга
    4. Получаем приложение и правило (если клонировали)
    5. Создаём Application и копируем сценарии с родителя
    6. Создаём Rules для outbound сценариев
    7. 🆕 Создаём Service Account для JWT авторизации (secure records)
    8. Сохраняем в БД (включая vox_rule_ids и service account)
    9. Регистрируем webhook для обновлений статуса
    10. Возвращаем ссылку на верификацию
    """
    try:
        logger.info(f"[TELEPHONY] Setup request from user {current_user.id}")
        
        # Проверяем, есть ли уже аккаунт у пользователя
        existing = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == current_user.id
        ).first()
        
        if existing:
            logger.info(f"[TELEPHONY] User {current_user.id} already has account {existing.vox_account_id}")
            
            # Если аккаунт уже есть, возвращаем ссылку на верификацию
            service = get_voximplant_partner_service()
            
            verification_url = None
            if existing.vox_subuser_login and existing.vox_subuser_password:
                verification = await service.get_verification_url(
                    child_account_id=existing.vox_account_id,
                    child_api_key=existing.vox_api_key,
                    subuser_login=existing.vox_subuser_login,
                    subuser_password=existing.vox_subuser_password,
                    verification_type=request.verification_type
                )
                verification_url = verification.get("url") if verification.get("success") else None
            
            return TelephonySetupResponse(
                success=True,
                message="Телефония уже подключена. Пройдите верификацию.",
                account_id=existing.vox_account_id,
                verification_url=verification_url
            )
        
        # Создаём новый дочерний аккаунт
        service = get_voximplant_partner_service()
        
        # Генерируем уникальное имя аккаунта
        timestamp = int(datetime.now().timestamp())
        account_name = f"vf{str(current_user.id)[:6]}{str(timestamp)[-6:]}"
        
        # =====================================================================
        # 1. Создаём аккаунт
        # =====================================================================
        logger.info(f"[TELEPHONY] Creating child account: {account_name}")
        unique_email = service.generate_unique_email(current_user.email, str(current_user.id))
        account_result = await service.create_child_account(
            account_name=account_name,
            account_email=unique_email,
            use_template=False
        )
        
        if not account_result.get("success"):
            logger.error(f"[TELEPHONY] Failed to create account: {account_result}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, 
                detail=account_result.get("error", "Не удалось создать аккаунт")
            )
        
        logger.info(f"[TELEPHONY] ✅ Account created: {account_result['account_id']}")
        
        # =====================================================================
        # 2. Создаём SubUser для верификации/биллинга
        # =====================================================================
        subuser_name = f"admin{timestamp}"
        
        subuser_result = await service.create_subuser(
            child_account_id=account_result["account_id"],
            child_api_key=account_result["api_key"],
            subuser_name=subuser_name,
            roles=["Accountant", "Verifier"]
        )
        
        if not subuser_result.get("success"):
            logger.warning(f"[TELEPHONY] Failed to create subuser: {subuser_result}")
        else:
            logger.info(f"[TELEPHONY] ✅ Subuser created: {subuser_name}")
        
        # =====================================================================
        # 3. Получаем приложение и правило (если клонировали) - ОБРАТНАЯ СОВМЕСТИМОСТЬ
        # =====================================================================
        apps_result = await service.get_applications(
            child_account_id=account_result["account_id"],
            child_api_key=account_result["api_key"]
        )
        
        app_id = None
        app_name = None
        rule_id = None
        scenario_ids = {}
        rule_ids = {}
        scenarios_copied = 0
        outbound_rules_created = 0
        
        if apps_result.get("success") and apps_result.get("applications"):
            app = apps_result["applications"][0]
            app_id = str(app.get("application_id"))
            app_name = app.get("application_name")
            
            # Получаем правила
            rules_result = await service.get_rules(
                child_account_id=account_result["account_id"],
                child_api_key=account_result["api_key"],
                application_id=app_id
            )
            
            if rules_result.get("success") and rules_result.get("rules"):
                rule_id = str(rules_result["rules"][0].get("rule_id"))
            
            logger.info(f"[TELEPHONY] Found cloned app: {app_id}, rule: {rule_id}")
        
        # =====================================================================
        # 4. Если нет приложения - создаём и копируем сценарии + outbound rules
        # =====================================================================
        if not app_id:
            try:
                setup_result = await service.setup_child_account_scenarios(
                    child_account_id=account_result["account_id"],
                    child_api_key=account_result["api_key"],
                    application_name="voicyfy"
                )
                
                if setup_result.get("success"):
                    app_id = str(setup_result.get("application_id"))
                    app_name = setup_result.get("application_name")
                    scenario_ids = setup_result.get("scenario_ids", {})
                    rule_ids = setup_result.get("rule_ids", {})
                    scenarios_copied = setup_result.get("scenarios_copied", 0)
                    outbound_rules_created = setup_result.get("outbound_rules_created", 0)
                    
                    logger.info(f"[TELEPHONY] ✅ Scenarios setup complete:")
                    logger.info(f"[TELEPHONY]    App: {app_id}")
                    logger.info(f"[TELEPHONY]    Scenarios: {list(scenario_ids.keys())}")
                    logger.info(f"[TELEPHONY]    Outbound Rules: {list(rule_ids.keys())}")
                else:
                    logger.warning(f"[TELEPHONY] ⚠️ Failed to setup scenarios: {setup_result.get('error')}")
            except Exception as e:
                logger.warning(f"[TELEPHONY] ⚠️ Scenarios setup failed: {e}")
        
        # =====================================================================
        # 5. 🆕 v3.2: Создаём Service Account для JWT авторизации (secure records)
        # =====================================================================
        service_account_id = None
        service_account_key = None
        service_account_created = False
        
        try:
            logger.info(f"[TELEPHONY] Creating Service Account for JWT authorization...")
            
            sa_result = await service.setup_service_account(
                child_account_id=account_result["account_id"],
                child_api_key=account_result["api_key"]
            )
            
            if sa_result.get("success"):
                service_account_id = sa_result.get("service_account_id")
                service_account_key = sa_result.get("service_account_key")
                service_account_created = True
                logger.info(f"[TELEPHONY] ✅ Service Account created: {service_account_id}")
            else:
                logger.warning(f"[TELEPHONY] ⚠️ Failed to create Service Account: {sa_result.get('error')}")
        except Exception as e:
            logger.warning(f"[TELEPHONY] ⚠️ Service Account creation failed: {e}")
        
        # =====================================================================
        # 6. Сохраняем в БД
        # =====================================================================
        child_account = VoximplantChildAccount(
            user_id=current_user.id,
            vox_account_id=account_result["account_id"],
            vox_account_name=account_result["account_name"],
            vox_account_email=account_result["account_email"],
            vox_api_key=account_result["api_key"],
            vox_subuser_login=subuser_result.get("subuser_name") if subuser_result.get("success") else None,
            vox_subuser_password=subuser_result.get("subuser_password") if subuser_result.get("success") else None,
            vox_application_id=app_id,
            vox_application_name=app_name,
            vox_rule_id=rule_id,
            vox_scenario_ids=scenario_ids,
            vox_rule_ids=rule_ids,
            # 🆕 v3.2: Service Account для JWT авторизации
            vox_service_account_id=service_account_id,
            vox_service_account_key=service_account_key,
            verification_status=VoximplantVerificationStatus.not_started,
        )
        
        db.add(child_account)
        db.commit()
        db.refresh(child_account)
        
        logger.info(f"[TELEPHONY] ✅ Child account saved to DB: {child_account.id}")
        
        # =====================================================================
        # 7. Регистрируем webhook для автоматических обновлений статуса
        # =====================================================================
        try:
            callback_result = await service.set_account_callback(
                child_account_id=account_result["account_id"],
                child_api_key=account_result["api_key"]
            )
            if callback_result.get("success"):
                logger.info(f"[TELEPHONY] ✅ Webhook registered for account {account_result['account_id']}")
            else:
                logger.warning(f"[TELEPHONY] ⚠️ Failed to register webhook: {callback_result.get('error')}")
        except Exception as e:
            logger.warning(f"[TELEPHONY] ⚠️ Webhook registration failed: {e}")
        
        # =====================================================================
        # 8. Получаем ссылку на верификацию
        # =====================================================================
        verification_url = None
        if subuser_result.get("success"):
            verification = await service.get_verification_url(
                child_account_id=account_result["account_id"],
                child_api_key=account_result["api_key"],
                subuser_login=subuser_result["subuser_name"],
                subuser_password=subuser_result["subuser_password"],
                verification_type=request.verification_type
            )
            verification_url = verification.get("url") if verification.get("success") else None
        
        return TelephonySetupResponse(
            success=True,
            message="Телефония подключена! Пройдите верификацию для покупки номеров.",
            account_id=account_result["account_id"],
            verification_url=verification_url,
            scenarios_copied=scenarios_copied,
            outbound_rules_created=outbound_rules_created,
            service_account_created=service_account_created  # 🆕 v3.2
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY] Error setting up telephony: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail=str(e)
        )


@router.get("/status", response_model=TelephonyStatusResponse)
async def get_telephony_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Получить статус телефонии пользователя.
    
    Возвращает:
    - Подключена ли телефония
    - Статус верификации
    - Баланс
    - Количество номеров
    - Есть ли сценарии
    - Есть ли outbound rules, можно ли делать исходящие
    - 🆕 v3.2: Есть ли Service Account
    """
    try:
        logger.info(f"[TELEPHONY] Status request from user {current_user.id}")
        
        # Ищем аккаунт пользователя
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == current_user.id
        ).first()
        
        if not child_account:
            return TelephonyStatusResponse(
                is_connected=False,
                verification_status="not_connected",
                is_verified=False,
                numbers_count=0,
                has_scenarios=False,
                has_outbound_rules=False,
                can_make_outbound_calls=False,
                has_service_account=False
            )
        
        # Получаем актуальный статус из Voximplant
        service = get_voximplant_partner_service()
        
        status_result = await service.check_verification_status(
            child_account_id=child_account.vox_account_id,
            child_api_key=child_account.vox_api_key
        )
        
        balance_result = await service.get_account_balance(
            child_account_id=child_account.vox_account_id,
            child_api_key=child_account.vox_api_key
        )
        
        # Обновляем статус в БД если изменился
        if status_result.get("success"):
            vox_status = status_result.get("verification_status", "NOT_STARTED")
            
            status_mapping = {
                "AWAITING_DOCUMENTS_UPLOADING": VoximplantVerificationStatus.awaiting_documents,
                "AWAITING_AGREEMENT_UPLOADING": VoximplantVerificationStatus.awaiting_agreement,
                "AWAITING_VERIFICATION": VoximplantVerificationStatus.awaiting_verification,
                "WAITING_FOR_CONFIRMATION_DOCUMENTS": VoximplantVerificationStatus.awaiting_verification,
                "VERIFIED": VoximplantVerificationStatus.verified,
                "REJECTED": VoximplantVerificationStatus.rejected,
            }
            
            if vox_status in status_mapping:
                new_status = status_mapping[vox_status]
                if child_account.verification_status != new_status:
                    child_account.verification_status = new_status
                    if new_status == VoximplantVerificationStatus.verified and not child_account.verified_at:
                        child_account.verified_at = datetime.now(timezone.utc)
                    db.commit()
                    logger.info(f"[TELEPHONY] ✅ Status updated in DB: {new_status}")
        
        # Считаем номера
        numbers_count = len(child_account.phone_numbers) if child_account.phone_numbers else 0
        
        # Проверяем наличие сценариев
        has_scenarios = bool(child_account.vox_scenario_ids and len(child_account.vox_scenario_ids) > 0)
        
        # Проверяем наличие outbound rules
        has_outbound_rules = bool(child_account.vox_rule_ids and len(child_account.vox_rule_ids) > 0)
        
        # 🆕 v3.2: Проверяем наличие Service Account
        has_service_account = bool(child_account.vox_service_account_id and child_account.vox_service_account_key)
        
        # Можно ли делать исходящие звонки
        can_make_outbound_calls = (
            child_account.is_verified 
            and child_account.is_active 
            and numbers_count > 0 
            and has_outbound_rules
        )
        
        return TelephonyStatusResponse(
            is_connected=True,
            verification_status=child_account.verification_status.value,
            is_verified=child_account.is_verified,
            balance=balance_result.get("balance") if balance_result.get("success") else None,
            numbers_count=numbers_count,
            account_id=child_account.vox_account_id,
            has_scenarios=has_scenarios,
            has_outbound_rules=has_outbound_rules,
            can_make_outbound_calls=can_make_outbound_calls,
            has_service_account=has_service_account  # 🆕 v3.2
        )
        
    except Exception as e:
        logger.error(f"[TELEPHONY] Error getting status: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail=str(e)
        )


# =============================================================================
# ENDPOINTS: ВЕРИФИКАЦИЯ И БИЛЛИНГ
# =============================================================================

@router.get("/verification-url")
async def get_verification_url(
    verification_type: str = Query(default="legal_entity"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Получить ссылку на страницу верификации.
    
    Args:
        verification_type: individual, legal_entity, entrepreneur
    """
    try:
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == current_user.id
        ).first()
        
        if not child_account:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, 
                detail="Телефония не подключена"
            )
        
        if not child_account.vox_subuser_login:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, 
                detail="SubUser не создан"
            )
        
        service = get_voximplant_partner_service()
        
        result = await service.get_verification_url(
            child_account_id=child_account.vox_account_id,
            child_api_key=child_account.vox_api_key,
            subuser_login=child_account.vox_subuser_login,
            subuser_password=child_account.vox_subuser_password,
            verification_type=verification_type
        )
        
        if not result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, 
                detail=result.get("error", "Не удалось получить ссылку")
            )
        
        return {"url": result["url"]}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY] Error getting verification URL: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail=str(e)
        )


@router.get("/billing-url")
async def get_billing_url(
    start_page: str = Query(default="card"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Получить ссылку на страницу биллинга.
    
    Args:
        start_page: card, transactions, docs, rates, pay_history
    """
    try:
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == current_user.id
        ).first()
        
        if not child_account:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, 
                detail="Телефония не подключена"
            )
        
        service = get_voximplant_partner_service()
        
        result = await service.get_billing_url(
            child_account_id=child_account.vox_account_id,
            child_api_key=child_account.vox_api_key,
            start_page=start_page
        )
        
        return {"url": result["url"]}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY] Error getting billing URL: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail=str(e)
        )


@router.get("/balance")
async def get_balance(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Получить баланс аккаунта."""
    try:
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == current_user.id
        ).first()
        
        if not child_account:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, 
                detail="Телефония не подключена"
            )
        
        service = get_voximplant_partner_service()
        
        result = await service.get_account_balance(
            child_account_id=child_account.vox_account_id,
            child_api_key=child_account.vox_api_key
        )
        
        if not result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, 
                detail=result.get("error")
            )
        
        return {
            "balance": result["balance"],
            "currency": result["currency"]
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY] Error getting balance: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail=str(e)
        )


# =============================================================================
# ИСТОРИЯ ЗВОНКОВ
# =============================================================================

@router.get("/call-history", response_model=CallHistoryResponse)
async def get_call_history(
    count: int = Query(default=5, ge=1, le=20, description="Количество записей"),
    from_date: Optional[str] = Query(default=None, description="Дата начала YYYY-MM-DD"),
    to_date: Optional[str] = Query(default=None, description="Дата конца YYYY-MM-DD"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Получить историю звонков из Voximplant GetCallHistory API.

    Возвращает последние N звонков с информацией о стоимости,
    длительности, ссылками на записи и логи.
    """
    try:
        # 1. Получить VoximplantChildAccount текущего пользователя
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == current_user.id
        ).first()

        if not child_account:
            return CallHistoryResponse(success=True, calls=[], total=0)

        # 2. Определить даты (по умолчанию: последние 7 дней)
        if not from_date:
            from_date_dt = datetime.now(timezone.utc) - timedelta(days=7)
            from_date = from_date_dt.strftime("%Y-%m-%d")
        if not to_date:
            to_date_dt = datetime.now(timezone.utc) + timedelta(days=1)
            to_date = to_date_dt.strftime("%Y-%m-%d")

        # 3. HTTP запрос к Voximplant API
        import httpx

        vox_url = "https://api.voximplant.com/platform_api/GetCallHistory"
        params = {
            "account_id": child_account.vox_account_id,
            "api_key": child_account.vox_api_key,
            "from_date": f"{from_date} 00:00:00",
            "to_date": f"{to_date} 23:59:59",
            "count": count,
            "with_calls": "true",
            "desc_order": "true",
        }

        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(vox_url, params=params)
            response.raise_for_status()
            data = response.json()

            # Fallback через мастер-аккаунт при Authorization failed (code 100)
            if "error" in data and data.get("error", {}).get("code") == 100:
                logger.warning(
                    f"[TELEPHONY] GetCallHistory: child api_key failed (code 100) "
                    f"for account {child_account.vox_account_id}, trying parent..."
                )
                params = {
                    "account_id": settings.VOXIMPLANT_PARENT_ACCOUNT_ID,
                    "api_key": settings.VOXIMPLANT_PARENT_API_KEY,
                    "child_account_id": child_account.vox_account_id,
                    "from_date": f"{from_date} 00:00:00",
                    "to_date": f"{to_date} 23:59:59",
                    "count": count,
                    "with_calls": "true",
                    "desc_order": "true",
                }
                response = await client.get(vox_url, params=params)
                response.raise_for_status()
                data = response.json()

        # 4. Парсинг результатов
        calls = []
        for session in data.get("result", []):
            # Парсим custom_data (JSON строка)
            custom_data = {}
            try:
                custom_data = json.loads(session.get("custom_data", "{}") or "{}")
            except (json.JSONDecodeError, TypeError):
                pass

            # Данные первого call-leg
            call_leg = session.get("calls", [{}])[0] if session.get("calls") else {}

            # Суммируем websocket cost из other_resource_usage
            ws_cost = sum(
                r.get("cost", 0)
                for r in session.get("other_resource_usage", [])
                if r.get("resource_type") == "WEBSOCKET_AUDIO"
            )

            call_cost = call_leg.get("cost", 0) or 0

            calls.append(CallHistoryItem(
                session_id=str(session.get("call_session_history_id", "")),
                start_date=session.get("start_date", ""),
                rule_name=session.get("rule_name"),
                duration=session.get("duration", 0),
                finish_reason=session.get("finish_reason"),
                caller_number=call_leg.get("local_number"),
                target_number=call_leg.get("remote_number"),
                call_duration=call_leg.get("duration", 0),
                call_cost=round(call_cost, 2),
                websocket_cost=round(ws_cost, 2),
                total_cost=round(call_cost + ws_cost, 2),
                record_url=call_leg.get("record_url"),
                log_url=session.get("log_file_url"),
                assistant_type=custom_data.get("assistant_type"),
                custom_greeting=custom_data.get("custom_greeting"),
                is_incoming=call_leg.get("incoming"),
            ))

        logger.info(f"[TELEPHONY] Call history returned {len(calls)} calls for user {current_user.id}")
        return CallHistoryResponse(success=True, calls=calls, total=len(calls))

    except Exception as e:
        logger.warning(f"[TELEPHONY] Error getting call history: {e}")
        # НЕ бросаем 500 — возвращаем пустой список, чтобы страница не ломалась
        return CallHistoryResponse(success=True, calls=[], total=0)


# =============================================================================
# АНАЛИЗ ЛОГА ЗВОНКА ЧЕРЕЗ ИИ
# =============================================================================

@router.post("/analyze-log", response_model=AnalyzeLogResponse)
async def analyze_call_log(
    request: AnalyzeLogRequest,
    current_user: User = Depends(get_current_user),
):
    """
    Анализ лога звонка через ИИ-бота chatforyou.ru.

    Первый запрос: передать log_url — бэкенд скачает лог и отправит боту.
    Последующие запросы: передать message — продолжение диалога в рамках сессии.
    """
    import httpx

    try:
        # Определяем текст сообщения для бота
        if request.log_url:
            # Первый запрос — скачиваем лог
            try:
                async with httpx.AsyncClient(timeout=15.0) as client:
                    log_response = await client.get(request.log_url)
                    log_response.raise_for_status()
                    log_text = log_response.text
            except httpx.TimeoutException:
                return AnalyzeLogResponse(
                    success=False,
                    error="Таймаут при скачивании лога звонка"
                )
            except Exception as e:
                logger.warning(f"[TELEPHONY] Failed to download log: {e}")
                return AnalyzeLogResponse(
                    success=False,
                    error=f"Не удалось скачать лог звонка: {str(e)}"
                )

            bot_message = f"Проанализируй лог звонка:\n\n{log_text}"

        elif request.message:
            # Продолжение диалога
            bot_message = request.message

        else:
            return AnalyzeLogResponse(
                success=False,
                error="Необходимо передать log_url или message"
            )

        # Отправляем запрос к chatforyou.ru
        payload = {
            "bot_id": CHATFORYOU_BOT_ID,
            "chat_id": request.chat_id,
            "message": bot_message,
        }

        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                bot_response = await client.post(
                    CHATFORYOU_API_URL,
                    json=payload,
                )
                bot_response.raise_for_status()
                bot_data = bot_response.json()
        except httpx.TimeoutException:
            return AnalyzeLogResponse(
                success=False,
                error="Таймаут ожидания ответа от ИИ-бота"
            )
        except Exception as e:
            logger.error(f"[TELEPHONY] ChatForYou API error: {e}", exc_info=True)
            return AnalyzeLogResponse(
                success=False,
                error=f"Ошибка при запросе к ИИ-боту: {str(e)}"
            )

        # Обработка ответа
        if "error" in bot_data:
            return AnalyzeLogResponse(
                success=False,
                error=bot_data["error"]
            )

        return AnalyzeLogResponse(
            success=True,
            response=bot_data.get("done"),
            usage=bot_data.get("usage"),
        )

    except Exception as e:
        logger.error(f"[TELEPHONY] Analyze log error: {e}", exc_info=True)
        return AnalyzeLogResponse(
            success=False,
            error=f"Внутренняя ошибка: {str(e)}"
        )


# =============================================================================
# РЕГИСТРАЦИЯ WEBHOOK
# =============================================================================

@router.post("/register-webhook")
async def register_webhook(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Зарегистрировать webhook для получения обновлений статуса верификации.
    """
    try:
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == current_user.id
        ).first()
        
        if not child_account:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, 
                detail="Телефония не подключена"
            )
        
        service = get_voximplant_partner_service()
        
        result = await service.set_account_callback(
            child_account_id=child_account.vox_account_id,
            child_api_key=child_account.vox_api_key
        )
        
        if not result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, 
                detail=result.get("error", "Не удалось зарегистрировать webhook")
            )
        
        logger.info(f"[TELEPHONY] ✅ Webhook registered for user {current_user.id}")
        
        return {
            "success": True,
            "message": "Webhook успешно зарегистрирован"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY] Error registering webhook: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail=str(e)
        )


@router.get("/webhook-status")
async def get_webhook_status(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Проверить статус webhook для аккаунта."""
    try:
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == current_user.id
        ).first()
        
        if not child_account:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, 
                detail="Телефония не подключена"
            )
        
        service = get_voximplant_partner_service()
        
        result = await service.get_account_callback(
            child_account_id=child_account.vox_account_id,
            child_api_key=child_account.vox_api_key
        )
        
        if not result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, 
                detail=result.get("error", "Не удалось получить статус webhook")
            )
        
        return {
            "success": True,
            "callback_info": result.get("callback_info", {})
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY] Error getting webhook status: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail=str(e)
        )


# =============================================================================
# ENDPOINTS: ТЕЛЕФОННЫЕ НОМЕРА
# =============================================================================

@router.get("/phone-regions")
async def get_phone_regions(
    category: Optional[str] = Query(default="GEOGRAPHIC", description="GEOGRAPHIC, MOBILE, TOLLFREE"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Получить список доступных регионов для покупки номеров."""
    try:
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == current_user.id
        ).first()
        
        if not child_account:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, 
                detail="Телефония не подключена"
            )
        
        service = get_voximplant_partner_service()
        
        result = await service.get_phone_regions(
            child_account_id=child_account.vox_account_id,
            child_api_key=child_account.vox_api_key,
            category=category
        )
        
        if not result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, 
                detail=result.get("error")
            )
        
        return {
            "success": True,
            "regions": result["regions"],
            "total": result["total"]
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY] Error getting phone regions: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail=str(e)
        )


@router.get("/available-numbers", response_model=AvailableNumbersResponse)
async def get_available_numbers(
    region_id: Optional[int] = Query(default=None, description="ID региона из /phone-regions"),
    category: Optional[str] = Query(default=None, description="GEOGRAPHIC, MOBILE, TOLLFREE"),
    count: int = Query(default=30, le=100),
    offset: int = Query(default=0, ge=0, description="Смещение для пагинации"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Получить список доступных номеров для покупки."""
    try:
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == current_user.id
        ).first()
        
        if not child_account:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, 
                detail="Телефония не подключена"
            )
        
        if not child_account.is_verified:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, 
                detail="Аккаунт не верифицирован. Пройдите верификацию для покупки номеров."
            )
        
        service = get_voximplant_partner_service()
        
        result = await service.get_available_numbers(
            child_account_id=child_account.vox_account_id,
            child_api_key=child_account.vox_api_key,
            region_id=region_id if region_id and region_id > 0 else None,
            category=category,
            count=count,
            offset=offset
        )
        
        if not result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, 
                detail=result.get("error")
            )
        
        return AvailableNumbersResponse(
            success=True,
            numbers=[
                PhoneNumberInfo(
                    phone_number=n["phone_number"],
                    phone_price=n.get("phone_price"),
                    phone_installation_price=n.get("phone_installation_price"),
                    region=n.get("phone_region_name")
                )
                for n in result["numbers"]
            ],
            total=result["total"]
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY] Error getting available numbers: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail=str(e)
        )


@router.post("/buy-number", response_model=BuyNumberResponse)
async def buy_phone_number(
    request: BuyNumberRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Купить телефонный номер.
    
    Требуется верифицированный аккаунт и достаточный баланс.
    """
    try:
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == current_user.id
        ).first()
        
        if not child_account:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, 
                detail="Телефония не подключена"
            )
        
        if not child_account.can_buy_numbers:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, 
                detail="Аккаунт не верифицирован или неактивен"
            )
        
        service = get_voximplant_partner_service()
        
        # =====================================================================
        # 1. Покупаем номер
        # =====================================================================
        buy_result = await service.buy_phone_number(
            child_account_id=child_account.vox_account_id,
            child_api_key=child_account.vox_api_key,
            phone_number=request.phone_number
        )
        
        if not buy_result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, 
                detail=buy_result.get("error")
            )
        
        # Валидация phone_id
        raw_phone_id = buy_result.get("phone_id")
        phone_id = validate_phone_id(raw_phone_id)
        
        if not phone_id:
            logger.error(f"[TELEPHONY] ❌ Invalid phone_id received from Voximplant: {raw_phone_id}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
                detail=f"Voximplant вернул невалидный phone_id: {raw_phone_id}"
            )
        
        logger.info(f"[TELEPHONY] ✅ Phone purchased: {request.phone_number} (id: {phone_id})")
        
        # =====================================================================
        # 2. Привязываем к приложению
        # =====================================================================
        rule_id = None
        
        if child_account.vox_application_id:
            if child_account.vox_rule_id:
                await service.bind_phone_to_application(
                    child_account_id=child_account.vox_account_id,
                    child_api_key=child_account.vox_api_key,
                    phone_id=phone_id,
                    application_id=child_account.vox_application_id,
                    rule_id=child_account.vox_rule_id
                )
                rule_id = child_account.vox_rule_id
                logger.info(f"[TELEPHONY] ✅ Phone bound with existing rule {rule_id}")
            else:
                bind_result = await service.bind_phone_to_application(
                    child_account_id=child_account.vox_account_id,
                    child_api_key=child_account.vox_api_key,
                    phone_id=phone_id,
                    application_id=child_account.vox_application_id
                )
                
                if bind_result.get("success"):
                    logger.info(f"[TELEPHONY] ✅ Phone bound to application {child_account.vox_application_id}")
                
                # =====================================================================
                # 3. Создаём Rule для номера
                # =====================================================================
                default_scenario = "inbound_gemini"
                scenario_id = child_account.get_scenario_id(default_scenario) if child_account.vox_scenario_ids else None
                
                if scenario_id:
                    phone_pattern = normalize_phone_number(request.phone_number)
                    rule_name = f"inbound_{phone_pattern}"
                    
                    rule_result = await service.add_rule(
                        child_account_id=child_account.vox_account_id,
                        child_api_key=child_account.vox_api_key,
                        application_id=child_account.vox_application_id,
                        rule_name=rule_name,
                        rule_pattern=phone_pattern,
                        scenario_id=scenario_id
                    )
                    
                    if rule_result.get("success"):
                        rule_id = str(rule_result.get("rule_id"))
                        logger.info(f"[TELEPHONY] ✅ Rule created: {rule_name} (id: {rule_id})")
                    else:
                        logger.warning(f"[TELEPHONY] ⚠️ Failed to create rule: {rule_result.get('error')}")
                else:
                    logger.warning(f"[TELEPHONY] ⚠️ Scenario '{default_scenario}' not found, skipping rule creation")
        
        # =====================================================================
        # 4. Сохраняем в БД
        # =====================================================================
        phone_record = VoximplantPhoneNumber(
            child_account_id=child_account.id,
            phone_number=request.phone_number,
            phone_number_id=phone_id,
            vox_rule_id=rule_id,
            caller_id=request.phone_number,
        )
        
        db.add(phone_record)
        db.commit()
        db.refresh(phone_record)
        
        logger.info(f"[TELEPHONY] ✅ Phone number purchased: {request.phone_number}")
        
        return BuyNumberResponse(
            success=True,
            message="Номер успешно куплен",
            phone_id=phone_id,
            phone_number=request.phone_number
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY] Error buying number: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail=str(e)
        )


@router.get("/my-numbers")
async def get_my_numbers(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Получить список моих номеров.
    
    Возвращает дополнительную информацию из Voximplant API:
    - phone_next_renewal: дата следующей оплаты (YYYY-MM-DD)
    - phone_price: стоимость аренды номера в месяц
    """
    try:
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == current_user.id
        ).first()
        
        if not child_account:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, 
                detail="Телефония не подключена"
            )
        
        numbers = child_account.phone_numbers if child_account else []
        
        # =====================================================================
        # Получаем актуальные данные из Voximplant API
        # =====================================================================
        vox_map = {}
        try:
            service = get_voximplant_partner_service()
            vox_result = await service.get_phone_numbers(
                child_account_id=child_account.vox_account_id,
                child_api_key=child_account.vox_api_key
            )
            if vox_result.get("success"):
                for n in vox_result.get("numbers", []):
                    # Нормализуем номер для сопоставления (берём последние 10 цифр)
                    phone = normalize_phone_number(n.get("phone_number", ""))
                    if phone:
                        vox_map[phone] = n
                        # Также добавляем по последним 10 цифрам для надёжности
                        if len(phone) > 10:
                            vox_map[phone[-10:]] = n
                logger.info(f"[TELEPHONY] Loaded {len(vox_result.get('numbers', []))} numbers from Voximplant API")
        except Exception as e:
            logger.warning(f"[TELEPHONY] Failed to fetch Voximplant data: {e}")
        
        result = []
        for num in numbers:
            # Получаем имя ассистента если привязан
            assistant_name = None
            if num.assistant_id and num.assistant_type:
                if num.assistant_type == "openai":
                    from backend.models.assistant import AssistantConfig
                    assistant = db.query(AssistantConfig).filter(
                        AssistantConfig.id == num.assistant_id
                    ).first()
                    assistant_name = assistant.name if assistant else None
                elif num.assistant_type == "gemini":
                    from backend.models.gemini_assistant import GeminiAssistantConfig
                    assistant = db.query(GeminiAssistantConfig).filter(
                        GeminiAssistantConfig.id == num.assistant_id
                    ).first()
                    assistant_name = assistant.name if assistant else None
                elif num.assistant_type == "cartesia":
                    from backend.models.cartesia_assistant import CartesiaAssistantConfig
                    assistant = db.query(CartesiaAssistantConfig).filter(
                        CartesiaAssistantConfig.id == num.assistant_id
                    ).first()
                    assistant_name = assistant.name if assistant else None

            # Получаем данные из Voximplant по нормализованному номеру
            normalized = normalize_phone_number(num.phone_number)
            vox_info = vox_map.get(normalized) or vox_map.get(normalized[-10:] if len(normalized) > 10 else normalized, {})
            
            result.append(MyNumberInfo(
                id=str(num.id),
                phone_number=num.phone_number,
                phone_region=num.phone_region,
                assistant_type=num.assistant_type,
                assistant_id=str(num.assistant_id) if num.assistant_id else None,
                assistant_name=assistant_name,
                first_phrase=num.first_phrase,
                is_active=num.is_active,
                phone_next_renewal=vox_info.get("phone_next_renewal"),
                phone_price=vox_info.get("phone_price"),
            ))
        
        return {"numbers": result, "total": len(result)}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY] Error getting my numbers: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail=str(e)
        )


@router.post("/bind-assistant")
async def bind_assistant_to_number(
    request: BindAssistantRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Привязать ассистента к номеру телефона.
    
    После привязки входящие звонки на этот номер будут обрабатываться
    указанным ассистентом.
    """
    try:
        # Находим номер
        phone_record = db.query(VoximplantPhoneNumber).filter(
            VoximplantPhoneNumber.id == uuid.UUID(request.phone_number_id)
        ).first()
        
        if not phone_record:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, 
                detail="Номер не найден"
            )
        
        # Проверяем, что номер принадлежит пользователю
        child_account = phone_record.child_account
        if child_account.user_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, 
                detail="Нет доступа к этому номеру"
            )
        
        # Проверяем существование ассистента
        assistant_uuid = uuid.UUID(request.assistant_id)
        
        if request.assistant_type == "openai":
            from backend.models.assistant import AssistantConfig
            assistant = db.query(AssistantConfig).filter(
                AssistantConfig.id == assistant_uuid,
                AssistantConfig.user_id == current_user.id
            ).first()
        elif request.assistant_type == "gemini":
            from backend.models.gemini_assistant import GeminiAssistantConfig
            assistant = db.query(GeminiAssistantConfig).filter(
                GeminiAssistantConfig.id == assistant_uuid,
                GeminiAssistantConfig.user_id == current_user.id
            ).first()
        elif request.assistant_type == "cartesia":
            from backend.models.cartesia_assistant import CartesiaAssistantConfig
            assistant = db.query(CartesiaAssistantConfig).filter(
                CartesiaAssistantConfig.id == assistant_uuid,
                CartesiaAssistantConfig.user_id == current_user.id
            ).first()
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Неверный тип ассистента. Используйте 'openai', 'gemini' или 'cartesia'"
            )

        if not assistant:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Ассистент не найден"
            )

        # =====================================================================
        # Обновляем Rule в Voximplant (DELETE + RECREATE)
        # =====================================================================
        if phone_record.vox_rule_id and child_account.vox_scenario_ids:
            scenario_name = get_scenario_key(request.assistant_type, "inbound")
            scenario_id = child_account.get_scenario_id(scenario_name)
            
            if scenario_id:
                service = get_voximplant_partner_service()
                
                # Удаляем старый Rule
                delete_result = await service.delete_rule(
                    child_account_id=child_account.vox_account_id,
                    child_api_key=child_account.vox_api_key,
                    rule_id=phone_record.vox_rule_id
                )
                
                if delete_result.get("success"):
                    logger.info(f"[TELEPHONY] ✅ Old rule deleted: {phone_record.vox_rule_id}")
                    
                    # Создаём новый Rule с правильным сценарием
                    phone_pattern = normalize_phone_number(phone_record.phone_number)
                    
                    new_rule_result = await service.add_rule(
                        child_account_id=child_account.vox_account_id,
                        child_api_key=child_account.vox_api_key,
                        application_id=child_account.vox_application_id,
                        rule_name=f"inbound_{phone_pattern}",
                        rule_pattern=phone_pattern,
                        scenario_id=scenario_id
                    )
                    
                    if new_rule_result.get("success"):
                        phone_record.vox_rule_id = str(new_rule_result.get("rule_id"))
                        logger.info(f"[TELEPHONY] ✅ New rule created: {phone_record.vox_rule_id} -> {scenario_name}")
                    else:
                        logger.error(f"[TELEPHONY] ❌ Failed to create new rule: {new_rule_result.get('error')}")
                else:
                    logger.error(f"[TELEPHONY] ❌ Failed to delete old rule: {delete_result.get('error')}")
            else:
                logger.warning(f"[TELEPHONY] ⚠️ Scenario '{scenario_name}' not found in account")
        
        # Обновляем привязку в БД
        phone_record.assistant_type = request.assistant_type
        phone_record.assistant_id = assistant_uuid
        phone_record.first_phrase = request.first_phrase
        
        db.commit()
        
        logger.info(f"[TELEPHONY] ✅ Assistant {request.assistant_id} bound to {phone_record.phone_number}")
        
        return {
            "success": True,
            "message": f"Ассистент '{assistant.name}' привязан к номеру {phone_record.phone_number}"
        }
        
    except HTTPException:
        raise
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, 
            detail="Неверный формат UUID"
        )
    except Exception as e:
        logger.error(f"[TELEPHONY] Error binding assistant: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail=str(e)
        )


# =============================================================================
# УПРАВЛЕНИЕ СЦЕНАРИЯМИ
# =============================================================================

@router.get("/scenarios")
async def get_account_scenarios(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Получить список сценариев и правил аккаунта."""
    try:
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == current_user.id
        ).first()
        
        if not child_account:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, 
                detail="Телефония не подключена"
            )
        
        return {
            "success": True,
            "scenario_ids": child_account.vox_scenario_ids or {},
            "rule_ids": child_account.vox_rule_ids or {},
            "application_id": child_account.vox_application_id,
            "application_name": child_account.vox_application_name,
            "has_service_account": bool(child_account.vox_service_account_id)  # 🆕 v3.2
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY] Error getting scenarios: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail=str(e)
        )


@router.post("/setup-scenarios")
async def setup_scenarios(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Создать приложение и скопировать сценарии.
    
    Также создаёт Rules для outbound сценариев.
    """
    try:
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == current_user.id
        ).first()
        
        if not child_account:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, 
                detail="Телефония не подключена"
            )
        
        # Проверяем, есть ли уже сценарии
        if child_account.vox_scenario_ids and len(child_account.vox_scenario_ids) > 0:
            # Проверяем, есть ли outbound rules
            if child_account.vox_rule_ids and len(child_account.vox_rule_ids) > 0:
                return {
                    "success": True,
                    "message": "Сценарии и правила уже настроены",
                    "scenario_ids": child_account.vox_scenario_ids,
                    "rule_ids": child_account.vox_rule_ids,
                    "scenarios_copied": 0,
                    "outbound_rules_created": 0
                }
            else:
                # Сценарии есть, но нет outbound rules - создаём их
                service = get_voximplant_partner_service()
                
                outbound_result = await service.setup_outbound_rules(
                    child_account_id=child_account.vox_account_id,
                    child_api_key=child_account.vox_api_key,
                    application_id=child_account.vox_application_id,
                    scenario_ids=child_account.vox_scenario_ids
                )
                
                if outbound_result.get("success"):
                    child_account.vox_rule_ids = outbound_result.get("rule_ids", {})
                    db.commit()
                    
                    return {
                        "success": True,
                        "message": f"Созданы правила для исходящих звонков",
                        "scenario_ids": child_account.vox_scenario_ids,
                        "rule_ids": child_account.vox_rule_ids,
                        "scenarios_copied": 0,
                        "outbound_rules_created": len(child_account.vox_rule_ids)
                    }
                else:
                    return {
                        "success": False,
                        "message": f"Не удалось создать outbound rules: {outbound_result.get('errors')}",
                        "scenario_ids": child_account.vox_scenario_ids,
                        "rule_ids": {}
                    }
        
        service = get_voximplant_partner_service()
        
        # Полная настройка (сценарии + outbound rules)
        setup_result = await service.setup_child_account_scenarios(
            child_account_id=child_account.vox_account_id,
            child_api_key=child_account.vox_api_key,
            application_name="voicyfy"
        )
        
        if not setup_result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Не удалось настроить сценарии: {setup_result.get('error')}"
            )
        
        # Обновляем в БД
        child_account.vox_application_id = str(setup_result.get("application_id"))
        child_account.vox_application_name = setup_result.get("application_name")
        child_account.vox_scenario_ids = setup_result.get("scenario_ids", {})
        child_account.vox_rule_ids = setup_result.get("rule_ids", {})
        db.commit()
        
        logger.info(f"[TELEPHONY] ✅ Scenarios and rules setup for user {current_user.id}")
        
        return {
            "success": True,
            "message": f"Скопировано {setup_result.get('scenarios_copied', 0)} сценариев, создано {setup_result.get('outbound_rules_created', 0)} правил",
            "application_id": child_account.vox_application_id,
            "scenario_ids": child_account.vox_scenario_ids,
            "rule_ids": child_account.vox_rule_ids,
            "scenarios_copied": setup_result.get("scenarios_copied", 0),
            "outbound_rules_created": setup_result.get("outbound_rules_created", 0),
            "errors": setup_result.get("errors")
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY] Error setting up scenarios: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail=str(e)
        )


# =============================================================================
# REPAIR ENDPOINT
# =============================================================================

@router.post("/repair-numbers")
async def repair_phone_numbers(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Починить номера с отсутствующим phone_id и привязать к приложению."""
    try:
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == current_user.id
        ).first()
        
        if not child_account:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Телефония не подключена"
            )
        
        service = get_voximplant_partner_service()
        
        # Получаем все номера из Voximplant
        vox_numbers_result = await service.get_phone_numbers(
            child_account_id=child_account.vox_account_id,
            child_api_key=child_account.vox_api_key
        )
        
        if not vox_numbers_result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Не удалось получить номера из Voximplant: {vox_numbers_result.get('error')}"
            )
        
        vox_numbers = vox_numbers_result.get("numbers", [])
        
        # Создаём маппинг номер -> данные из Voximplant
        vox_map = {}
        for num in vox_numbers:
            normalized = normalize_phone_number(num.get("phone_number", ""))
            vox_map[normalized] = num
            vox_map[normalized[-10:]] = num
        
        logger.info(f"[TELEPHONY] Voximplant numbers: {list(vox_map.keys())}")
        
        db_numbers = child_account.phone_numbers or []
        
        repaired = []
        errors = []
        
        for phone_record in db_numbers:
            needs_repair = False
            repair_actions = []
            
            if not phone_record.phone_number_id or phone_record.phone_number_id in ("None", "null", ""):
                needs_repair = True
                repair_actions.append("fix_phone_id")
            
            if not needs_repair:
                continue
            
            logger.info(f"[TELEPHONY] Repairing {phone_record.phone_number}: {repair_actions}")
            
            normalized_phone = normalize_phone_number(phone_record.phone_number)
            vox_data = vox_map.get(normalized_phone) or vox_map.get(normalized_phone[-10:])
            
            if not vox_data:
                errors.append(f"{phone_record.phone_number}: не найден в Voximplant")
                logger.warning(f"[TELEPHONY] ⚠️ {phone_record.phone_number} not found in Voximplant")
                continue
            
            phone_id = vox_data.get("phone_id")
            if not phone_id:
                errors.append(f"{phone_record.phone_number}: нет phone_id в Voximplant")
                continue
            
            phone_id_str = str(phone_id)
            
            phone_record.phone_number_id = phone_id_str
            logger.info(f"[TELEPHONY] ✅ Fixed phone_number_id: {phone_id_str}")
            
            if child_account.vox_application_id:
                current_app_id = vox_data.get("application_id")
                
                if not current_app_id:
                    bind_result = await service.bind_phone_to_application(
                        child_account_id=child_account.vox_account_id,
                        child_api_key=child_account.vox_api_key,
                        phone_id=phone_id_str,
                        application_id=child_account.vox_application_id
                    )
                    
                    if bind_result.get("success"):
                        logger.info(f"[TELEPHONY] ✅ Bound to application {child_account.vox_application_id}")
                        repair_actions.append("bound_to_app")
                    else:
                        errors.append(f"{phone_record.phone_number}: ошибка привязки - {bind_result.get('error')}")
                else:
                    logger.info(f"[TELEPHONY] Already bound to app {current_app_id}")
                
                if not phone_record.vox_rule_id and child_account.vox_scenario_ids:
                    default_scenario = "inbound_gemini"
                    scenario_id = child_account.get_scenario_id(default_scenario)
                    
                    if scenario_id:
                        phone_pattern = normalize_phone_number(phone_record.phone_number)
                        rule_name = f"inbound_{phone_pattern}"
                        
                        rule_result = await service.add_rule(
                            child_account_id=child_account.vox_account_id,
                            child_api_key=child_account.vox_api_key,
                            application_id=child_account.vox_application_id,
                            rule_name=rule_name,
                            rule_pattern=phone_pattern,
                            scenario_id=scenario_id
                        )
                        
                        if rule_result.get("success"):
                            phone_record.vox_rule_id = str(rule_result.get("rule_id"))
                            logger.info(f"[TELEPHONY] ✅ Created rule: {rule_name}")
                            repair_actions.append("created_rule")
                        else:
                            errors.append(f"{phone_record.phone_number}: ошибка создания rule - {rule_result.get('error')}")
            
            repaired.append({
                "phone_number": phone_record.phone_number,
                "phone_id": phone_id_str,
                "actions": repair_actions
            })
        
        db.commit()
        
        logger.info(f"[TELEPHONY] ✅ Repair complete: {len(repaired)} fixed, {len(errors)} errors")
        
        return {
            "success": True,
            "message": f"Починено {len(repaired)} номеров",
            "repaired": repaired,
            "errors": errors if errors else None,
            "total_checked": len(db_numbers)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY] Repair error: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


# =============================================================================
# 🆕 v3.4: PUBLIC CALL LOOKUP - получение данных звонка по session_history_id
# =============================================================================

@router.get("/call/{session_history_id}")
async def get_call_by_session_history_id(
    session_history_id: str,
    db: Session = Depends(get_db),
):
    """
    Получить данные звонка по Voximplant call_session_history_id.
    
    ⚠️ Это ПУБЛИЧНЫЙ endpoint - НЕ требует авторизации.
    call_session_history_id — это ID сессии Voximplant, который генерируется
    автоматически и служит неявным ключом доступа.
    
    GET /api/telephony/call/4382022730
    """
    try:
        # =====================================================================
        # 1. Валидация входного параметра
        # =====================================================================
        if not session_history_id or not session_history_id.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="session_history_id не может быть пустым"
            )
        
        session_history_id = session_history_id.strip()
        
        logger.info(f"[TELEPHONY-CALL-LOOKUP] Looking up call session: {session_history_id}")
        
        # =====================================================================
        # 2. Поиск записей в таблице conversations
        # =====================================================================
        from backend.models.conversation import Conversation
        from sqlalchemy import text
        
        conversations = db.query(Conversation).filter(
            text("client_info->>'call_session_history_id' = :sid")
        ).params(sid=session_history_id).order_by(Conversation.created_at.asc()).all()
        
        if not conversations:
            logger.warning(f"[TELEPHONY-CALL-LOOKUP] No conversations found for session: {session_history_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Звонок с session_history_id={session_history_id} не найден"
            )
        
        logger.info(f"[TELEPHONY-CALL-LOOKUP] Found {len(conversations)} conversation records")
        
        # =====================================================================
        # 3. Собираем structured dialog с дедупликацией
        # =====================================================================
        dialog = []
        seen_keys = set()
        
        for conv in conversations:
            client_info = conv.client_info or {}
            conv_dialog = client_info.get("dialog")
            
            if conv_dialog and isinstance(conv_dialog, list):
                # Используем structured dialog из client_info
                for entry in conv_dialog:
                    role = entry.get("role", "")
                    text_val = entry.get("text", "")
                    ts = entry.get("ts")
                    
                    # Дедупликация по ключу role:text:ts
                    dedup_key = f"{role}:{text_val}:{ts}"
                    if dedup_key not in seen_keys:
                        seen_keys.add(dedup_key)
                        dialog.append({
                            "role": role,
                            "text": text_val,
                            "ts": ts
                        })
            else:
                # Fallback на поля user_message / assistant_message
                if conv.user_message:
                    dedup_key = f"user:{conv.user_message}:None"
                    if dedup_key not in seen_keys:
                        seen_keys.add(dedup_key)
                        dialog.append({
                            "role": "user",
                            "text": conv.user_message,
                            "ts": None
                        })
                
                if conv.assistant_message:
                    dedup_key = f"assistant:{conv.assistant_message}:None"
                    if dedup_key not in seen_keys:
                        seen_keys.add(dedup_key)
                        dialog.append({
                            "role": "assistant",
                            "text": conv.assistant_message,
                            "ts": None
                        })
        
        # =====================================================================
        # 4. Получаем информацию об ассистенте
        # =====================================================================
        first_conv = conversations[0]
        assistant_id = first_conv.assistant_id
        assistant_name = None
        assistant_type = None
        
        if assistant_id:
            assistant, a_type, _ = find_assistant_by_id(db, assistant_id)
            if assistant:
                assistant_name = assistant.name
                assistant_type = a_type
        
        # =====================================================================
        # 5. Собираем метаданные (первое непустое значение из всех записей)
        # =====================================================================
        record_url = None
        call_cost = None
        call_duration = None
        caller_number = None
        call_direction = None
        session_id = None
        
        invalid_phone_values = {"unknown", "null", "none", ""}
        
        for conv in conversations:
            ci = conv.client_info or {}
            
            if not record_url and ci.get("record_url"):
                record_url = ci["record_url"]
            
            if call_cost is None and ci.get("call_cost") is not None:
                call_cost = ci["call_cost"]
            
            if call_duration is None and ci.get("call_duration") is not None:
                call_duration = ci["call_duration"]
            
            if not caller_number and ci.get("caller_number"):
                raw_caller = str(ci["caller_number"]).strip()
                if raw_caller.lower() not in invalid_phone_values:
                    caller_number = raw_caller
            
            if not call_direction and ci.get("call_direction"):
                call_direction = ci["call_direction"]
            
            if not session_id and ci.get("session_id"):
                session_id = ci["session_id"]
        
        # =====================================================================
        # 6. Формируем ответ
        # =====================================================================
        result = {
            "success": True,
            "call_session_history_id": session_history_id,
            "session_id": session_id,
            "assistant_id": str(assistant_id) if assistant_id else None,
            "assistant_name": assistant_name,
            "assistant_type": assistant_type,
            "caller_number": caller_number,
            "call_direction": call_direction,
            "call_cost": call_cost,
            "call_duration": call_duration,
            "record_url": record_url,
            "created_at": first_conv.created_at.isoformat() if first_conv.created_at else None,
            "dialog": dialog,
            "messages_count": len(dialog)
        }
        
        logger.info(f"[TELEPHONY-CALL-LOOKUP] ✅ Returned call data: {len(dialog)} messages, assistant={assistant_name}")
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY-CALL-LOOKUP] Error: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


# =============================================================================
# ИСХОДЯЩИЕ ЗВОНКИ (OUTBOUND CALLS)
# =============================================================================

@router.post("/start-outbound-call", response_model=StartOutboundCallResponse)
async def start_outbound_call(
    request: StartOutboundCallRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Запустить исходящие звонки.
    
    Запускает сценарий для каждого номера из списка target_phones.
    Максимум 50 номеров за один запрос.
    
    Требования:
    - Верифицированный аккаунт
    - Наличие купленных номеров (для caller_id)
    - Наличие outbound rules
    """
    try:
        logger.info(f"[TELEPHONY-OUTBOUND] Start outbound call request from user {current_user.id}")
        logger.info(f"[TELEPHONY-OUTBOUND]    Caller phone_id: {request.phone_number_id}")
        logger.info(f"[TELEPHONY-OUTBOUND]    Target phones: {len(request.target_phones)}")
        logger.info(f"[TELEPHONY-OUTBOUND]    Assistant: {request.assistant_id} ({request.assistant_type})")
        
        # =====================================================================
        # 1. Проверяем child_account
        # =====================================================================
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == current_user.id
        ).first()
        
        if not child_account:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Телефония не подключена"
            )
        
        if not child_account.is_verified:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Аккаунт не верифицирован"
            )
        
        # =====================================================================
        # 2. Проверяем наличие outbound rules
        # =====================================================================
        if not child_account.vox_rule_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Правила для исходящих звонков не настроены. Используйте /setup-scenarios"
            )
        
        rule_name = f"outbound_{request.assistant_type}"
        rule_id = child_account.vox_rule_ids.get(rule_name)

        if not rule_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Правило '{rule_name}' не найдено. Доступные: {list(child_account.vox_rule_ids.keys())}"
            )
        
        # =====================================================================
        # 3. Проверяем номер для caller_id
        # =====================================================================
        phone_record = db.query(VoximplantPhoneNumber).filter(
            VoximplantPhoneNumber.id == uuid.UUID(request.phone_number_id),
            VoximplantPhoneNumber.child_account_id == child_account.id
        ).first()
        
        if not phone_record:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Номер для исходящих звонков не найден"
            )
        
        if not phone_record.is_active:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Номер неактивен"
            )
        
        caller_id = phone_record.phone_number
        logger.info(f"[TELEPHONY-OUTBOUND] Using caller_id: {caller_id}")
        
        # =====================================================================
        # 4. Проверяем ассистента
        # =====================================================================
        assistant_uuid = uuid.UUID(request.assistant_id)
        assistant = None
        
        if request.assistant_type == "openai":
            from backend.models.assistant import AssistantConfig
            assistant = db.query(AssistantConfig).filter(
                AssistantConfig.id == assistant_uuid,
                AssistantConfig.user_id == current_user.id
            ).first()
        elif request.assistant_type == "gemini":
            from backend.models.gemini_assistant import GeminiAssistantConfig
            assistant = db.query(GeminiAssistantConfig).filter(
                GeminiAssistantConfig.id == assistant_uuid,
                GeminiAssistantConfig.user_id == current_user.id
            ).first()
        elif request.assistant_type == "cartesia":
            from backend.models.cartesia_assistant import CartesiaAssistantConfig
            assistant = db.query(CartesiaAssistantConfig).filter(
                CartesiaAssistantConfig.id == assistant_uuid,
                CartesiaAssistantConfig.user_id == current_user.id
            ).first()
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Неверный тип ассистента. Используйте 'openai', 'gemini' или 'cartesia'"
            )

        if not assistant:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Ассистент не найден"
            )

        logger.info(f"[TELEPHONY-OUTBOUND] Using assistant: {assistant.name}")
        
        # =====================================================================
        # 5. Запускаем звонки
        # =====================================================================
        service = get_voximplant_partner_service()
        
        results = []
        started_count = 0
        failed_count = 0
        
        # Определяем first_phrase
        first_phrase = request.first_phrase
        if not first_phrase and hasattr(assistant, 'greeting_message'):
            first_phrase = assistant.greeting_message
        
        for target_phone in request.target_phones:
            # Нормализуем номер
            normalized_target = normalize_phone_number(target_phone)
            
            # Форматируем для звонка (добавляем + если нужно)
            if not target_phone.startswith("+"):
                target_phone_formatted = f"+{normalized_target}"
            else:
                target_phone_formatted = target_phone
            
            logger.info(f"[TELEPHONY-OUTBOUND] Calling {target_phone_formatted}...")
            
            try:
                call_result = await service.start_outbound_call(
                    child_account_id=child_account.vox_account_id,
                    child_api_key=child_account.vox_api_key,
                    rule_id=int(rule_id),
                    phone_number=target_phone_formatted,
                    assistant_id=str(assistant.id),
                    caller_id=caller_id,
                    first_phrase=first_phrase,
                    mute_duration_ms=request.mute_duration_ms,
                    task=request.task
                )
                
                if call_result.get("success"):
                    started_count += 1
                    results.append({
                        "phone": target_phone,
                        "status": "started",
                        "session_id": call_result.get("call_session_history_id")
                    })
                    logger.info(f"[TELEPHONY-OUTBOUND] ✅ Started call to {target_phone}")
                else:
                    failed_count += 1
                    results.append({
                        "phone": target_phone,
                        "status": "failed",
                        "error": call_result.get("error")
                    })
                    logger.error(f"[TELEPHONY-OUTBOUND] ❌ Failed call to {target_phone}: {call_result.get('error')}")
                    
            except Exception as call_error:
                failed_count += 1
                results.append({
                    "phone": target_phone,
                    "status": "error",
                    "error": str(call_error)
                })
                logger.error(f"[TELEPHONY-OUTBOUND] ❌ Exception for {target_phone}: {call_error}")
        
        # =====================================================================
        # 6. Формируем ответ
        # =====================================================================
        logger.info(f"[TELEPHONY-OUTBOUND] ✅ Completed: {started_count} started, {failed_count} failed")
        
        return StartOutboundCallResponse(
            success=started_count > 0,
            message=f"Запущено {started_count} из {len(request.target_phones)} звонков",
            total_requested=len(request.target_phones),
            started=started_count,
            failed=failed_count,
            results=results
        )
        
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Неверный формат данных: {str(e)}"
        )
    except Exception as e:
        logger.error(f"[TELEPHONY-OUTBOUND] Error: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


# =============================================================================
# ПУБЛИЧНЫЙ API ДЛЯ ИСХОДЯЩИХ ЗВОНКОВ
# =============================================================================

@router.post("/public/call", response_model=PublicCallResponse)
async def public_outbound_call(
    request: PublicCallRequest,
    db: Session = Depends(get_db),
):
    """
    Публичный эндпоинт для запуска исходящих звонков.
    
    ⚠️ НЕ требует авторизации - assistant_id служит ключом доступа.
    
    Автоматически определяет:
    - Тип ассистента (openai/gemini)
    - Пользователя по ассистенту
    - Voximplant аккаунт
    - Номер для caller_id (если не указан - берёт первый доступный)
    
    🆕 v3.3: Возвращает session_ids - список ID сессий запущенных звонков.
    
    **Пример вызова:**
    ```
    curl -X POST "https://api.voicyfy.com/api/telephony/public/call" \\
      -H "Content-Type: application/json" \\
      -d '{
        "assistant_id": "550e8400-e29b-41d4-a716-446655440000",
        "target_phones": ["+79161234567"],
        "task": "Напомнить о встрече в 15:00"
      }'
    ```
    
    **Пример ответа:**
    ```json
    {
      "success": true,
      "message": "Запущено 1 звонков",
      "started": 1,
      "failed": 0,
      "session_ids": ["12345678"]
    }
    ```
    """
    try:
        logger.info(f"[TELEPHONY-PUBLIC] Public call request")
        logger.info(f"[TELEPHONY-PUBLIC]    Assistant ID: {request.assistant_id}")
        logger.info(f"[TELEPHONY-PUBLIC]    Target phones: {len(request.target_phones)}")
        logger.info(f"[TELEPHONY-PUBLIC]    Caller phone: {request.caller_phone or 'auto'}")
        
        # =====================================================================
        # 1. Валидация и поиск ассистента
        # =====================================================================
        try:
            assistant_uuid = uuid.UUID(request.assistant_id)
        except ValueError:
            logger.warning(f"[TELEPHONY-PUBLIC] Invalid assistant_id format: {request.assistant_id}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Неверный формат assistant_id"
            )
        
        assistant, assistant_type, user_id = find_assistant_by_id(db, assistant_uuid)
        
        if not assistant:
            logger.warning(f"[TELEPHONY-PUBLIC] Assistant not found: {request.assistant_id}")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Ассистент не найден"
            )
        
        logger.info(f"[TELEPHONY-PUBLIC] Found assistant: {assistant.name} ({assistant_type})")
        logger.info(f"[TELEPHONY-PUBLIC] User ID: {user_id}")
        
        # =====================================================================
        # 2. Получаем Voximplant аккаунт пользователя
        # =====================================================================
        child_account = db.query(VoximplantChildAccount).filter(
            VoximplantChildAccount.user_id == user_id
        ).first()
        
        if not child_account:
            logger.warning(f"[TELEPHONY-PUBLIC] No telephony account for user {user_id}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Телефония не подключена для этого ассистента"
            )
        
        if not child_account.is_verified:
            logger.warning(f"[TELEPHONY-PUBLIC] Account not verified: {child_account.vox_account_id}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Аккаунт телефонии не верифицирован"
            )
        
        if not child_account.is_active:
            logger.warning(f"[TELEPHONY-PUBLIC] Account not active: {child_account.vox_account_id}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Аккаунт телефонии неактивен"
            )
        
        # =====================================================================
        # 3. Проверяем наличие outbound rules
        # =====================================================================
        if not child_account.vox_rule_ids:
            logger.warning(f"[TELEPHONY-PUBLIC] No outbound rules for account {child_account.vox_account_id}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Правила для исходящих звонков не настроены"
            )
        
        rule_name = "outbound_crm"
        rule_id = child_account.vox_rule_ids.get(rule_name)
        
        if not rule_id:
            logger.warning(f"[TELEPHONY-PUBLIC] Rule '{rule_name}' not found")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Правило для {assistant_type} не найдено"
            )
        
        # =====================================================================
        # 4. Определяем caller_id
        # =====================================================================
        phone_record = None
        
        if request.caller_phone:
            # Ищем указанный номер
            normalized_caller = normalize_phone_number(request.caller_phone)
            
            for num in child_account.phone_numbers or []:
                if not num.is_active:
                    continue
                normalized_num = normalize_phone_number(num.phone_number)
                # Сравниваем по последним 10 цифрам
                if normalized_num[-10:] == normalized_caller[-10:]:
                    phone_record = num
                    break
            
            if not phone_record:
                logger.warning(f"[TELEPHONY-PUBLIC] Caller phone not found: {request.caller_phone}")
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Номер {request.caller_phone} не найден или неактивен"
                )
        else:
            # Берём первый активный номер
            for num in child_account.phone_numbers or []:
                if num.is_active:
                    phone_record = num
                    break
            
            if not phone_record:
                logger.warning(f"[TELEPHONY-PUBLIC] No active phone numbers for account {child_account.vox_account_id}")
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Нет доступных номеров для исходящих звонков"
                )
        
        caller_id = phone_record.phone_number
        logger.info(f"[TELEPHONY-PUBLIC] Using caller_id: {caller_id}")
        
        # =====================================================================
        # 5. Определяем first_phrase
        # =====================================================================
        first_phrase = request.first_phrase
        if not first_phrase and hasattr(assistant, 'greeting_message'):
            first_phrase = assistant.greeting_message
        
        # =====================================================================
        # 6. Запускаем звонки
        # =====================================================================
        service = get_voximplant_partner_service()
        
        started_count = 0
        failed_count = 0
        session_ids = []  # 🆕 v3.3: Собираем ID сессий
        
        for target_phone in request.target_phones:
            # Нормализуем номер
            normalized_target = normalize_phone_number(target_phone)
            
            # Форматируем для звонка
            if not target_phone.startswith("+"):
                target_phone_formatted = f"+{normalized_target}"
            else:
                target_phone_formatted = target_phone
            
            logger.info(f"[TELEPHONY-PUBLIC] Calling {target_phone_formatted}...")
            
            try:
                call_result = await service.start_outbound_call(
                    child_account_id=child_account.vox_account_id,
                    child_api_key=child_account.vox_api_key,
                    rule_id=int(rule_id),
                    phone_number=target_phone_formatted,
                    assistant_id=str(assistant.id),
                    caller_id=caller_id,
                    first_phrase=first_phrase,
                    mute_duration_ms=request.mute_duration_ms,
                    task=request.task
                )
                
                if call_result.get("success"):
                    started_count += 1
                    # 🆕 v3.3: Сохраняем session_id
                    session_id = call_result.get("call_session_history_id")
                    if session_id:
                        session_ids.append(str(session_id))
                    logger.info(f"[TELEPHONY-PUBLIC] ✅ Started call to {target_phone} (session: {session_id})")
                else:
                    failed_count += 1
                    logger.error(f"[TELEPHONY-PUBLIC] ❌ Failed call to {target_phone}: {call_result.get('error')}")
                    
            except Exception as call_error:
                failed_count += 1
                logger.error(f"[TELEPHONY-PUBLIC] ❌ Exception for {target_phone}: {call_error}")
        
        # =====================================================================
        # 7. Формируем ответ
        # =====================================================================
        total = len(request.target_phones)
        logger.info(f"[TELEPHONY-PUBLIC] ✅ Completed: {started_count}/{total} started, {failed_count} failed")
        logger.info(f"[TELEPHONY-PUBLIC]    Session IDs: {session_ids}")
        
        if started_count == 0:
            return PublicCallResponse(
                success=False,
                message=f"Не удалось запустить звонки (0 из {total})",
                started=0,
                failed=failed_count,
                session_ids=session_ids
            )
        
        if failed_count > 0:
            return PublicCallResponse(
                success=True,
                message=f"Запущено {started_count} из {total} звонков",
                started=started_count,
                failed=failed_count,
                session_ids=session_ids
            )
        
        return PublicCallResponse(
            success=True,
            message=f"Запущено {started_count} звонков",
            started=started_count,
            failed=0,
            session_ids=session_ids
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY-PUBLIC] Error: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.get("/outbound-config", response_model=OutboundConfigResponse)
async def get_outbound_config(
    assistant_id: str = Query(..., description="UUID ассистента"),
    assistant_type: str = Query(..., description="Тип ассистента: openai или gemini"),
    db: Session = Depends(get_db),
):
    """
    Получить конфигурацию для исходящего сценария Voximplant.
    
    ⚠️ Это ПУБЛИЧНЫЙ endpoint - НЕ требует авторизации.
    Вызывается из сценария Voximplant при исходящем звонке.
    
    GET /api/telephony/outbound-config?assistant_id=...&assistant_type=openai
    """
    try:
        logger.info(f"[TELEPHONY-OUTBOUND] Config request: assistant_id={assistant_id}, type={assistant_type}")
        
        # =====================================================================
        # 1. Получаем ассистента
        # =====================================================================
        assistant = None
        assistant_name = None
        system_prompt = None
        voice = None
        language = "ru"
        functions_config = None
        google_sheet_id = None
        enable_thinking = False
        thinking_budget = 0
        user_id = None
        
        try:
            assistant_uuid = uuid.UUID(assistant_id)
        except ValueError:
            logger.warning(f"[TELEPHONY-OUTBOUND] Invalid assistant_id format: {assistant_id}")
            return OutboundConfigResponse(success=False)
        
        if assistant_type == "openai":
            from backend.models.assistant import AssistantConfig
            assistant = db.query(AssistantConfig).filter(
                AssistantConfig.id == assistant_uuid
            ).first()
            
            if assistant:
                assistant_name = assistant.name
                system_prompt = assistant.system_prompt
                voice = assistant.voice or "alloy"
                language = assistant.language or "ru"
                functions_config = assistant.functions
                google_sheet_id = assistant.google_sheet_id
                user_id = assistant.user_id
                
        elif assistant_type == "gemini":
            from backend.models.gemini_assistant import GeminiAssistantConfig
            assistant = db.query(GeminiAssistantConfig).filter(
                GeminiAssistantConfig.id == assistant_uuid
            ).first()

            if assistant:
                assistant_name = assistant.name
                system_prompt = assistant.system_prompt
                voice = assistant.voice or "Aoede"
                language = assistant.language or "ru"
                functions_config = assistant.functions
                google_sheet_id = assistant.google_sheet_id
                enable_thinking = assistant.enable_thinking or False
                thinking_budget = assistant.thinking_budget or 0
                user_id = assistant.user_id

        elif assistant_type == "cartesia":
            from backend.models.cartesia_assistant import CartesiaAssistantConfig
            assistant = db.query(CartesiaAssistantConfig).filter(
                CartesiaAssistantConfig.id == assistant_uuid
            ).first()

            if assistant:
                assistant_name = assistant.name
                system_prompt = assistant.system_prompt
                functions_config = assistant.functions
                user_id = assistant.user_id
        else:
            logger.warning(f"[TELEPHONY-OUTBOUND] Unknown assistant_type: {assistant_type}")
            return OutboundConfigResponse(success=False)

        if not assistant:
            logger.warning(f"[TELEPHONY-OUTBOUND] Assistant not found: {assistant_id}")
            return OutboundConfigResponse(success=False)

        # =====================================================================
        # 2. Получаем пользователя и API ключ
        # =====================================================================
        user = db.query(User).filter(User.id == user_id).first()

        if not user:
            logger.warning(f"[TELEPHONY-OUTBOUND] User not found for assistant: {assistant_id}")
            return OutboundConfigResponse(success=False)

        api_key = None
        cartesia_api_key = None
        cartesia_voice_id = None
        voice_speed = None
        if assistant_type == "openai":
            api_key = user.openai_api_key
        elif assistant_type == "gemini":
            api_key = user.gemini_api_key
        elif assistant_type == "cartesia":
            api_key = user.openai_api_key
            cartesia_api_key = user.cartesia_api_key
            cartesia_voice_id = assistant.cartesia_voice_id
            voice_speed = assistant.voice_speed
        
        # =====================================================================
        # 3. Формируем функции
        # =====================================================================
        functions = []
        if functions_config:
            functions = build_functions_for_openai(functions_config)
        
        # =====================================================================
        # 4. Определяем first_phrase
        # =====================================================================
        first_phrase = None
        if hasattr(assistant, 'greeting_message'):
            first_phrase = assistant.greeting_message
        
        logger.info(f"[TELEPHONY-OUTBOUND] ✅ Config returned for {assistant_id}")
        logger.info(f"[TELEPHONY-OUTBOUND]    Assistant: {assistant_name} ({assistant_type})")
        logger.info(f"[TELEPHONY-OUTBOUND]    Voice: {voice}")
        logger.info(f"[TELEPHONY-OUTBOUND]    Functions: {len(functions)}")
        
        return OutboundConfigResponse(
            success=True,
            assistant_type=assistant_type,
            assistant_id=str(assistant.id),
            assistant_name=assistant_name,
            api_key=api_key,
            system_prompt=system_prompt,
            first_phrase=first_phrase,
            voice=voice,
            language=language,
            functions=functions if functions else None,
            google_sheet_id=google_sheet_id,
            model="gpt-4o-realtime-preview" if assistant_type == "openai" else None,
            enable_thinking=enable_thinking if assistant_type == "gemini" else None,
            thinking_budget=thinking_budget if assistant_type == "gemini" else None,
            cartesia_voice_id=cartesia_voice_id,
            voice_speed=voice_speed,
            cartesia_api_key=cartesia_api_key,
        )
        
    except Exception as e:
        logger.error(f"[TELEPHONY-OUTBOUND] Config error: {e}", exc_info=True)
        return OutboundConfigResponse(success=False)


# =============================================================================
# ADMIN ENDPOINTS
# =============================================================================

@router.post("/admin/update-all-scenarios")
async def admin_update_all_scenarios(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    🔐 ADMIN ONLY: Обновить сценарии у ВСЕХ дочерних аккаунтов.
    """
    # Проверка админа
    if not current_user.is_admin and current_user.email != "well96well@gmail.com":
        raise HTTPException(status_code=403, detail="Admin access required")
    
    try:
        service = get_voximplant_partner_service()
        
        # 1. Получаем актуальные сценарии с родителя
        logger.info("[TELEPHONY-ADMIN] Fetching scenarios from parent account...")
        
        parent_scenarios = {}
        parent_list = await service.get_parent_scenarios(with_script=False)
        
        if not parent_list.get("success"):
            raise HTTPException(status_code=500, detail="Failed to get parent scenarios")
        
        for scenario in parent_list.get("scenarios", []):
            scenario_id = scenario.get("scenario_id")
            scenario_name = scenario.get("scenario_name")
            
            script_result = await service.get_scenarios(
                account_id=service.parent_account_id,
                api_key=service.parent_api_key,
                with_script=True,
                scenario_id=scenario_id
            )
            
            if script_result.get("success") and script_result.get("scenarios"):
                script = script_result["scenarios"][0].get("scenario_script")
                if script:
                    parent_scenarios[scenario_name] = script
                    logger.info(f"[TELEPHONY-ADMIN] Loaded: {scenario_name} ({len(script)} chars)")
        
        logger.info(f"[TELEPHONY-ADMIN] Loaded {len(parent_scenarios)} scenarios from parent")
        
        # 2. Получаем все дочерние аккаунты
        child_accounts = db.query(VoximplantChildAccount).all()
        logger.info(f"[TELEPHONY-ADMIN] Found {len(child_accounts)} child accounts")
        
        results = {
            "total_accounts": len(child_accounts),
            "updated": 0,
            "failed": 0,
            "skipped": 0,
            "details": []
        }
        
        # 3. Обновляем сценарии у каждого дочернего аккаунта
        for child in child_accounts:
            account_result = {
                "account_id": child.vox_account_id,
                "user_id": str(child.user_id),
                "scenarios_updated": [],
                "errors": []
            }
            
            if not child.vox_scenario_ids:
                logger.info(f"[TELEPHONY-ADMIN] Skipping {child.vox_account_id} - no scenarios")
                results["skipped"] += 1
                account_result["status"] = "skipped"
                results["details"].append(account_result)
                continue
            
            for scenario_name, child_scenario_id in child.vox_scenario_ids.items():
                if scenario_name not in parent_scenarios:
                    logger.warning(f"[TELEPHONY-ADMIN] Scenario {scenario_name} not found on parent")
                    continue
                
                new_script = parent_scenarios[scenario_name]
                
                update_result = await service.update_scenario(
                    child_account_id=child.vox_account_id,
                    child_api_key=child.vox_api_key,
                    scenario_id=int(child_scenario_id),
                    scenario_script=new_script
                )
                
                if update_result.get("success"):
                    account_result["scenarios_updated"].append(scenario_name)
                    logger.info(f"[TELEPHONY-ADMIN] ✅ Updated {scenario_name} for {child.vox_account_id}")
                else:
                    account_result["errors"].append(f"{scenario_name}: {update_result.get('error')}")
                    logger.error(f"[TELEPHONY-ADMIN] ❌ Failed {scenario_name}: {update_result.get('error')}")
            
            if account_result["scenarios_updated"]:
                results["updated"] += 1
                account_result["status"] = "updated"
            elif account_result["errors"]:
                results["failed"] += 1
                account_result["status"] = "failed"
            else:
                results["skipped"] += 1
                account_result["status"] = "skipped"
            
            results["details"].append(account_result)
        
        logger.info(f"[TELEPHONY-ADMIN] ✅ Update complete: {results['updated']} updated, {results['failed']} failed, {results['skipped']} skipped")
        
        return {
            "success": True,
            "message": f"Updated {results['updated']} accounts",
            "results": results
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY-ADMIN] Error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/admin/setup-outbound-rules")
async def admin_setup_outbound_rules(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    🔐 ADMIN ONLY: Создать outbound rules для ВСЕХ дочерних аккаунтов.
    
    Миграция существующих аккаунтов - создаёт Rules для
    outbound сценариев у аккаунтов, где их ещё нет.
    """
    # Проверка админа
    if not current_user.is_admin and current_user.email != "well96well@gmail.com":
        raise HTTPException(status_code=403, detail="Admin access required")
    
    try:
        service = get_voximplant_partner_service()
        
        # Получаем все дочерние аккаунты
        child_accounts = db.query(VoximplantChildAccount).all()
        logger.info(f"[TELEPHONY-ADMIN] Found {len(child_accounts)} child accounts for outbound rules setup")
        
        results = {
            "total_accounts": len(child_accounts),
            "updated": 0,
            "skipped": 0,
            "failed": 0,
            "details": []
        }
        
        for child in child_accounts:
            account_result = {
                "account_id": child.vox_account_id,
                "user_id": str(child.user_id),
                "status": "skipped",
                "rules_created": [],
                "errors": []
            }
            
            # Пропускаем если уже есть outbound rules
            if child.vox_rule_ids and len(child.vox_rule_ids) > 0:
                logger.info(f"[TELEPHONY-ADMIN] Skipping {child.vox_account_id} - already has outbound rules")
                results["skipped"] += 1
                account_result["status"] = "skipped_has_rules"
                results["details"].append(account_result)
                continue
            
            # Пропускаем если нет сценариев
            if not child.vox_scenario_ids or len(child.vox_scenario_ids) == 0:
                logger.info(f"[TELEPHONY-ADMIN] Skipping {child.vox_account_id} - no scenarios")
                results["skipped"] += 1
                account_result["status"] = "skipped_no_scenarios"
                results["details"].append(account_result)
                continue
            
            # Пропускаем если нет application_id
            if not child.vox_application_id:
                logger.info(f"[TELEPHONY-ADMIN] Skipping {child.vox_account_id} - no application_id")
                results["skipped"] += 1
                account_result["status"] = "skipped_no_app"
                results["details"].append(account_result)
                continue
            
            # Создаём outbound rules
            logger.info(f"[TELEPHONY-ADMIN] Creating outbound rules for {child.vox_account_id}...")
            
            outbound_result = await service.setup_outbound_rules(
                child_account_id=child.vox_account_id,
                child_api_key=child.vox_api_key,
                application_id=child.vox_application_id,
                scenario_ids=child.vox_scenario_ids
            )
            
            if outbound_result.get("success") and outbound_result.get("rule_ids"):
                child.vox_rule_ids = outbound_result.get("rule_ids")
                flag_modified(child, "vox_rule_ids")
                db.commit()
                
                results["updated"] += 1
                account_result["status"] = "updated"
                account_result["rules_created"] = list(outbound_result.get("rule_ids", {}).keys())
                logger.info(f"[TELEPHONY-ADMIN] ✅ Created outbound rules for {child.vox_account_id}: {account_result['rules_created']}")
            else:
                results["failed"] += 1
                account_result["status"] = "failed"
                account_result["errors"] = outbound_result.get("errors", [])
                logger.error(f"[TELEPHONY-ADMIN] ❌ Failed for {child.vox_account_id}: {account_result['errors']}")
            
            results["details"].append(account_result)
        
        logger.info(f"[TELEPHONY-ADMIN] ✅ Outbound rules setup complete: {results['updated']} updated, {results['failed']} failed, {results['skipped']} skipped")
        
        return {
            "success": True,
            "message": f"Created outbound rules for {results['updated']} accounts",
            "results": results
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY-ADMIN] Error: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# 🆕 v3.2: ADMIN ENDPOINT ДЛЯ МИГРАЦИИ SERVICE ACCOUNTS
# =============================================================================

@router.post("/admin/setup-service-accounts")
async def admin_setup_service_accounts(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    🔐 ADMIN ONLY: Создать Service Account для ВСЕХ дочерних аккаунтов.
    
    🆕 v3.2: Миграция существующих аккаунтов - создаёт Service Account
    для JWT авторизации при скачивании secure записей.
    
    После выполнения все аккаунты смогут скачивать записи с secure URLs.
    """
    # Проверка админа
    if not current_user.is_admin and current_user.email != "well96well@gmail.com":
        raise HTTPException(status_code=403, detail="Admin access required")
    
    try:
        service = get_voximplant_partner_service()
        
        # Получаем все дочерние аккаунты
        child_accounts = db.query(VoximplantChildAccount).all()
        logger.info(f"[TELEPHONY-ADMIN] Found {len(child_accounts)} child accounts for Service Account setup")
        
        results = {
            "total_accounts": len(child_accounts),
            "created": 0,
            "skipped": 0,
            "failed": 0,
            "details": []
        }
        
        for child in child_accounts:
            account_result = {
                "account_id": child.vox_account_id,
                "user_id": str(child.user_id),
                "status": "skipped",
                "service_account_id": None,
                "error": None
            }
            
            # Пропускаем если уже есть Service Account
            if child.vox_service_account_id and child.vox_service_account_key:
                logger.info(f"[TELEPHONY-ADMIN] Skipping {child.vox_account_id} - already has Service Account")
                results["skipped"] += 1
                account_result["status"] = "skipped_has_sa"
                account_result["service_account_id"] = child.vox_service_account_id
                results["details"].append(account_result)
                continue
            
            # Создаём Service Account
            logger.info(f"[TELEPHONY-ADMIN] Creating Service Account for {child.vox_account_id}...")
            
            try:
                sa_result = await service.setup_service_account(
                    child_account_id=child.vox_account_id,
                    child_api_key=child.vox_api_key
                )
                
                if sa_result.get("success"):
                    child.vox_service_account_id = sa_result.get("service_account_id")
                    child.vox_service_account_key = sa_result.get("service_account_key")
                    db.commit()
                    
                    results["created"] += 1
                    account_result["status"] = "created"
                    account_result["service_account_id"] = child.vox_service_account_id
                    logger.info(f"[TELEPHONY-ADMIN] ✅ Created Service Account for {child.vox_account_id}: {child.vox_service_account_id}")
                else:
                    results["failed"] += 1
                    account_result["status"] = "failed"
                    account_result["error"] = sa_result.get("error")
                    logger.error(f"[TELEPHONY-ADMIN] ❌ Failed for {child.vox_account_id}: {sa_result.get('error')}")
                    
            except Exception as sa_error:
                results["failed"] += 1
                account_result["status"] = "error"
                account_result["error"] = str(sa_error)
                logger.error(f"[TELEPHONY-ADMIN] ❌ Exception for {child.vox_account_id}: {sa_error}")
            
            results["details"].append(account_result)
        
        logger.info(f"[TELEPHONY-ADMIN] ✅ Service Account setup complete:")
        logger.info(f"[TELEPHONY-ADMIN]    Created: {results['created']}")
        logger.info(f"[TELEPHONY-ADMIN]    Skipped: {results['skipped']}")
        logger.info(f"[TELEPHONY-ADMIN]    Failed: {results['failed']}")
        
        return {
            "success": True,
            "message": f"Created Service Accounts for {results['created']} accounts",
            "results": results
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY-ADMIN] Error: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# 🆕 ADMIN ENDPOINT ДЛЯ МИГРАЦИИ CARTESIA СЦЕНАРИЕВ
# =============================================================================

@router.post("/admin/setup-cartesia-scenarios")
async def admin_setup_cartesia_scenarios(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    🔐 ADMIN ONLY: Скопировать cartesia_inbound и cartesia_outbound
    на ВСЕ дочерние аккаунты + создать outbound_cartesia rule.

    Логика для каждого дочернего аккаунта:
    - Если сценарий уже есть (есть в vox_scenario_ids) → обновить код (SetScenarioInfo)
    - Если сценария нет → скопировать (AddScenario) и сохранить ID в vox_scenario_ids
    - Если outbound_cartesia rule отсутствует → создать (AddRule) и сохранить в vox_rule_ids
    - Аккаунты без vox_application_id → пропустить
    """
    if not current_user.is_admin and current_user.email != "well96well@gmail.com":
        raise HTTPException(status_code=403, detail="Admin access required")

    try:
        service = get_voximplant_partner_service()

        # ── 1. Загружаем cartesia_inbound и cartesia_outbound с родителя ──────
        # Сначала получаем список сценариев без кода (быстро),
        # затем для каждого cartesia-сценария делаем отдельный запрос с кодом
        # (Voximplant quirk: with_script=true не возвращает код при массовом запросе)

        logger.info("[TELEPHONY-ADMIN] Fetching cartesia scenarios from parent...")

        cartesia_scripts = {}
        cartesia_scenario_names = ["cartesia_inbound", "cartesia_outbound"]

        parent_list = await service.get_parent_scenarios(with_script=False)
        if not parent_list.get("success"):
            raise HTTPException(status_code=500, detail="Failed to get parent scenarios")

        for scenario in parent_list.get("scenarios", []):
            scenario_name = scenario.get("scenario_name")
            scenario_id = scenario.get("scenario_id")

            if scenario_name not in cartesia_scenario_names:
                continue

            script_result = await service.get_scenarios(
                account_id=service.parent_account_id,
                api_key=service.parent_api_key,
                with_script=True,
                scenario_id=scenario_id
            )

            if script_result.get("success") and script_result.get("scenarios"):
                script = script_result["scenarios"][0].get("scenario_script")
                if script:
                    cartesia_scripts[scenario_name] = script
                    logger.info(f"[TELEPHONY-ADMIN] Loaded: {scenario_name} ({len(script)} chars)")

        if not cartesia_scripts:
            raise HTTPException(
                status_code=404,
                detail="cartesia_inbound / cartesia_outbound не найдены на родительском аккаунте. "
                       "Убедись что скрипты созданы на родительском аккаунте Voximplant."
            )

        logger.info(f"[TELEPHONY-ADMIN] Loaded scripts: {list(cartesia_scripts.keys())}")

        # ── 2. Обрабатываем все дочерние аккаунты ────────────────────────────
        child_accounts = db.query(VoximplantChildAccount).all()
        logger.info(f"[TELEPHONY-ADMIN] Processing {len(child_accounts)} child accounts")

        results = {
            "total_accounts":   len(child_accounts),
            "scripts_added":    0,
            "scripts_updated":  0,
            "rules_created":    0,
            "skipped":          0,
            "failed":           0,
            "details":          []
        }

        for child in child_accounts:
            account_result = {
                "account_id":      child.vox_account_id,
                "user_id":         str(child.user_id),
                "scripts_added":   [],
                "scripts_updated": [],
                "rules_created":   [],
                "errors":          []
            }

            # Аккаунты без application_id пропускаем — там нет приложения Voximplant
            if not child.vox_application_id:
                results["skipped"] += 1
                account_result["status"] = "skipped_no_app"
                results["details"].append(account_result)
                continue

            scenario_ids = child.vox_scenario_ids or {}
            rule_ids     = child.vox_rule_ids     or {}
            changed      = False

            for scenario_name, script in cartesia_scripts.items():

                if scenario_name in scenario_ids:
                    # Сценарий уже есть → обновляем код
                    update_result = await service.update_scenario(
                        child_account_id=child.vox_account_id,
                        child_api_key=child.vox_api_key,
                        scenario_id=int(scenario_ids[scenario_name]),
                        scenario_script=script
                    )
                    if update_result.get("success"):
                        account_result["scripts_updated"].append(scenario_name)
                    else:
                        account_result["errors"].append(
                            f"update {scenario_name}: {update_result.get('error')}"
                        )
                else:
                    # Пробуем добавить
                    add_result = await service.add_scenario(
                        child_account_id=child.vox_account_id,
                        child_api_key=child.vox_api_key,
                        scenario_name=scenario_name,
                        scenario_script=script
                    )
                    if add_result.get("success"):
                        scenario_ids[scenario_name] = str(add_result.get("scenario_id"))
                        changed = True
                        account_result["scripts_added"].append(scenario_name)
                    elif "not unique" in (add_result.get("error") or "").lower():
                        # Сценарий уже существует на аккаунте но не в нашей БД
                        # Находим его ID через API и обновляем код
                        existing = await service.get_scenarios(
                            account_id=child.vox_account_id,
                            api_key=child.vox_api_key,
                            with_script=False
                        )
                        found_id = None
                        if existing.get("success"):
                            for s in existing.get("scenarios", []):
                                if s.get("scenario_name") == scenario_name:
                                    found_id = s.get("scenario_id")
                                    break

                        if found_id:
                            # Сохраняем ID в БД
                            scenario_ids[scenario_name] = str(found_id)
                            changed = True
                            # Обновляем код
                            update_result = await service.update_scenario(
                                child_account_id=child.vox_account_id,
                                child_api_key=child.vox_api_key,
                                scenario_id=int(found_id),
                                scenario_script=script
                            )
                            if update_result.get("success"):
                                account_result["scripts_updated"].append(scenario_name)
                                logger.info(f"[TELEPHONY-ADMIN] Recovered existing scenario {scenario_name} (id={found_id}) for {child.vox_account_id}")
                            else:
                                account_result["errors"].append(
                                    f"update_recovered {scenario_name}: {update_result.get('error')}"
                                )
                        else:
                            account_result["errors"].append(
                                f"add {scenario_name}: not unique, but could not find existing scenario"
                            )
                    else:
                        account_result["errors"].append(
                            f"add {scenario_name}: {add_result.get('error')}"
                        )

            # Создаём outbound_cartesia rule если его нет
            # (нужен для запуска исходящих звонков через Cartesia)
            if "outbound_cartesia" not in rule_ids and "cartesia_outbound" in scenario_ids:
                rule_result = await service.add_rule(
                    child_account_id=child.vox_account_id,
                    child_api_key=child.vox_api_key,
                    application_id=child.vox_application_id,
                    rule_name="outbound_cartesia",
                    rule_pattern="outbound_cartesia_.*",
                    scenario_id=int(scenario_ids["cartesia_outbound"])
                )
                if rule_result.get("success"):
                    rule_ids["outbound_cartesia"] = str(rule_result.get("rule_id"))
                    changed = True
                    account_result["rules_created"].append("outbound_cartesia")
                elif "not unique" in (rule_result.get("error") or "").lower():
                    # Правило уже есть в Voximplant — получаем его ID
                    existing_rules = await service.get_rules(
                        child_account_id=child.vox_account_id,
                        child_api_key=child.vox_api_key,
                        application_id=child.vox_application_id
                    )
                    found_rule = False
                    for r in (existing_rules.get("rules") or []):
                        if r.get("rule_name") == "outbound_cartesia":
                            rule_ids["outbound_cartesia"] = str(r.get("rule_id"))
                            changed = True
                            found_rule = True
                            logger.info(f"[TELEPHONY-ADMIN] Recovered existing rule outbound_cartesia (id={r.get('rule_id')}) for {child.vox_account_id}")
                            break
                    if not found_rule:
                        account_result["errors"].append(
                            "rule outbound_cartesia: not unique, but could not find existing rule"
                        )
                else:
                    account_result["errors"].append(
                        f"rule outbound_cartesia: {rule_result.get('error')}"
                    )

            # Сохраняем изменения в БД только если что-то добавилось
            if changed:
                child.vox_scenario_ids = scenario_ids
                child.vox_rule_ids     = rule_ids
                flag_modified(child, "vox_scenario_ids")
                flag_modified(child, "vox_rule_ids")
                db.commit()

            account_result["status"] = "partial" if account_result["errors"] else "ok"

            results["scripts_added"]   += len(account_result["scripts_added"])
            results["scripts_updated"] += len(account_result["scripts_updated"])
            results["rules_created"]   += len(account_result["rules_created"])
            if account_result["errors"]:
                results["failed"] += 1

            results["details"].append(account_result)

        logger.info(
            f"[TELEPHONY-ADMIN] Cartesia setup complete: "
            f"added={results['scripts_added']} updated={results['scripts_updated']} "
            f"rules={results['rules_created']} failed={results['failed']}"
        )

        return {
            "success": True,
            "message": (
                f"Scripts added: {results['scripts_added']}, "
                f"updated: {results['scripts_updated']}, "
                f"rules created: {results['rules_created']}"
            ),
            "results": results
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY-ADMIN] Error: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/admin/setup-crm-rules")
async def admin_setup_crm_rules(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    ADMIN ONLY: Create outbound_crm rule for ALL child accounts.

    Migration: creates Rule for outbound_crm scenario,
    used by task_scheduler for CRM calls.
    """
    if not current_user.is_admin and current_user.email != "well96well@gmail.com":
        raise HTTPException(status_code=403, detail="Admin access required")

    try:
        service = get_voximplant_partner_service()

        child_accounts = db.query(VoximplantChildAccount).all()
        logger.info(f"[TELEPHONY-ADMIN] Setting up outbound_crm rules for {len(child_accounts)} accounts")

        results = {
            "total_accounts": len(child_accounts),
            "created": 0,
            "skipped": 0,
            "failed": 0,
            "details": []
        }

        for child in child_accounts:
            account_result = {
                "account_id": child.vox_account_id,
                "user_id": str(child.user_id),
                "status": "skipped",
                "rule_id": None,
                "error": None
            }

            # Skip if no application_id
            if not child.vox_application_id:
                results["skipped"] += 1
                account_result["status"] = "skipped_no_app"
                results["details"].append(account_result)
                continue

            # Skip if no outbound_crm scenario
            scenario_ids = child.vox_scenario_ids or {}
            if "outbound_crm" not in scenario_ids:
                results["skipped"] += 1
                account_result["status"] = "skipped_no_scenario"
                results["details"].append(account_result)
                continue

            # Skip if rule already exists
            rule_ids = child.vox_rule_ids or {}
            if "outbound_crm" in rule_ids:
                results["skipped"] += 1
                account_result["status"] = "skipped_has_rule"
                account_result["rule_id"] = rule_ids["outbound_crm"]
                results["details"].append(account_result)
                continue

            # Create rule
            try:
                rule_result = await service.add_rule(
                    child_account_id=child.vox_account_id,
                    child_api_key=child.vox_api_key,
                    application_id=child.vox_application_id,
                    rule_name="outbound_crm",
                    rule_pattern="outbound_crm_.*",
                    scenario_id=int(scenario_ids["outbound_crm"])
                )

                if rule_result.get("success"):
                    rule_ids["outbound_crm"] = str(rule_result.get("rule_id"))
                    child.vox_rule_ids = rule_ids
                    flag_modified(child, "vox_rule_ids")
                    db.commit()

                    results["created"] += 1
                    account_result["status"] = "created"
                    account_result["rule_id"] = rule_ids["outbound_crm"]
                    logger.info(f"[TELEPHONY-ADMIN] Created outbound_crm rule for {child.vox_account_id}: {rule_ids['outbound_crm']}")

                elif "not unique" in (rule_result.get("error") or "").lower():
                    # Rule already exists in Voximplant - find its ID
                    existing_rules = await service.get_rules(
                        child_account_id=child.vox_account_id,
                        child_api_key=child.vox_api_key,
                        application_id=child.vox_application_id
                    )
                    found = False
                    for r in (existing_rules.get("rules") or []):
                        if r.get("rule_name") == "outbound_crm":
                            rule_ids["outbound_crm"] = str(r.get("rule_id"))
                            child.vox_rule_ids = rule_ids
                            flag_modified(child, "vox_rule_ids")
                            db.commit()

                            results["created"] += 1
                            account_result["status"] = "recovered"
                            account_result["rule_id"] = rule_ids["outbound_crm"]
                            found = True
                            logger.info(f"[TELEPHONY-ADMIN] Recovered existing outbound_crm rule for {child.vox_account_id}")
                            break

                    if not found:
                        results["failed"] += 1
                        account_result["status"] = "failed"
                        account_result["error"] = "not unique but could not find existing rule"
                else:
                    results["failed"] += 1
                    account_result["status"] = "failed"
                    account_result["error"] = rule_result.get("error")
                    logger.error(f"[TELEPHONY-ADMIN] Failed for {child.vox_account_id}: {rule_result.get('error')}")

            except Exception as e:
                results["failed"] += 1
                account_result["status"] = "error"
                account_result["error"] = str(e)
                logger.error(f"[TELEPHONY-ADMIN] Exception for {child.vox_account_id}: {e}")

            results["details"].append(account_result)

        logger.info(f"[TELEPHONY-ADMIN] CRM rules setup: created={results['created']} skipped={results['skipped']} failed={results['failed']}")

        return {
            "success": True,
            "message": f"Created outbound_crm rules for {results['created']} accounts",
            "results": results
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TELEPHONY-ADMIN] Error: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# ПУБЛИЧНЫЙ ENDPOINT ДЛЯ СЦЕНАРИЯ VOXIMPLANT (INBOUND)
# =============================================================================

@router.get("/config")
async def get_scenario_config(
    phone: str = Query(..., description="Номер телефона, на который звонят"),
    db: Session = Depends(get_db),
):
    """
    Получить конфигурацию для сценария Voximplant (INBOUND).
    
    ⚠️ Это ПУБЛИЧНЫЙ endpoint - НЕ требует авторизации.
    Вызывается из сценария Voximplant при входящем звонке.
    
    GET /api/telephony/config?phone=74951234567
    """
    try:
        normalized_phone = normalize_phone_number(phone)
        
        logger.info(f"[TELEPHONY] Config request for phone: {phone}")
        
        # Ищем номер в БД
        phone_variants = [
            normalized_phone,
            f"+{normalized_phone}",
            normalized_phone[1:] if normalized_phone.startswith('7') else None,
            f"7{normalized_phone}" if len(normalized_phone) == 10 else None,
        ]
        phone_variants = [p for p in phone_variants if p]
        
        phone_record = None
        for variant in phone_variants:
            phone_record = db.query(VoximplantPhoneNumber).filter(
                VoximplantPhoneNumber.phone_number.contains(variant[-10:]),
                VoximplantPhoneNumber.is_active == True
            ).first()
            if phone_record:
                break
        
        if not phone_record:
            logger.warning(f"[TELEPHONY] Phone not found: {phone}")
            return ScenarioConfigResponse(success=False)
        
        if not phone_record.assistant_id or not phone_record.assistant_type:
            logger.warning(f"[TELEPHONY] No assistant bound: {phone}")
            return ScenarioConfigResponse(success=False)
        
        # Получаем пользователя
        child_account = phone_record.child_account
        user = db.query(User).filter(User.id == child_account.user_id).first()
        
        if not user:
            return ScenarioConfigResponse(success=False)
        
        # Получаем ассистента в зависимости от типа
        assistant = None
        assistant_name = None
        system_prompt = None
        voice = None
        language = "ru"
        functions_config = None
        google_sheet_id = None
        enable_thinking = False
        thinking_budget = 0
        
        if phone_record.assistant_type == "openai":
            from backend.models.assistant import AssistantConfig
            assistant = db.query(AssistantConfig).filter(
                AssistantConfig.id == phone_record.assistant_id
            ).first()
            
            if assistant:
                assistant_name = assistant.name
                system_prompt = assistant.system_prompt
                voice = assistant.voice or "alloy"
                language = assistant.language or "ru"
                functions_config = assistant.functions
                google_sheet_id = assistant.google_sheet_id
                
        elif phone_record.assistant_type == "gemini":
            from backend.models.gemini_assistant import GeminiAssistantConfig
            assistant = db.query(GeminiAssistantConfig).filter(
                GeminiAssistantConfig.id == phone_record.assistant_id
            ).first()

            if assistant:
                assistant_name = assistant.name
                system_prompt = assistant.system_prompt
                voice = assistant.voice or "Aoede"
                language = assistant.language or "ru"
                functions_config = assistant.functions
                google_sheet_id = assistant.google_sheet_id
                enable_thinking = assistant.enable_thinking or False
                thinking_budget = assistant.thinking_budget or 0

        elif phone_record.assistant_type == "cartesia":
            from backend.models.cartesia_assistant import CartesiaAssistantConfig
            assistant = db.query(CartesiaAssistantConfig).filter(
                CartesiaAssistantConfig.id == phone_record.assistant_id
            ).first()

            if assistant:
                assistant_name = assistant.name
                system_prompt = assistant.system_prompt
                functions_config = assistant.functions

        if not assistant:
            logger.warning(f"[TELEPHONY] Assistant not found: {phone_record.assistant_id}")
            return ScenarioConfigResponse(success=False)
        
        # Формируем функции
        functions = []
        if functions_config:
            functions = build_functions_for_openai(functions_config)
        
        # API ключ
        api_key = None
        cartesia_api_key = None
        cartesia_voice_id = None
        voice_speed = None
        if phone_record.assistant_type == "openai":
            api_key = user.openai_api_key
        elif phone_record.assistant_type == "gemini":
            api_key = user.gemini_api_key
        elif phone_record.assistant_type == "cartesia":
            api_key = user.openai_api_key
            cartesia_api_key = user.cartesia_api_key
            cartesia_voice_id = assistant.cartesia_voice_id
            voice_speed = assistant.voice_speed

        # First phrase
        first_phrase = phone_record.first_phrase
        if not first_phrase and hasattr(assistant, 'greeting_message'):
            first_phrase = assistant.greeting_message

        logger.info(f"[TELEPHONY] Config returned for {phone}")
        logger.info(f"[TELEPHONY]   Assistant: {assistant_name} ({phone_record.assistant_type})")
        logger.info(f"[TELEPHONY]   Voice: {voice}")
        logger.info(f"[TELEPHONY]   Functions: {len(functions)}")

        return ScenarioConfigResponse(
            success=True,
            assistant_type=phone_record.assistant_type,
            assistant_id=str(phone_record.assistant_id),
            assistant_name=assistant_name,
            api_key=api_key,
            system_prompt=system_prompt,
            first_phrase=first_phrase,
            voice=voice,
            language=language,
            functions=functions if functions else None,
            google_sheet_id=google_sheet_id,
            model="gpt-4o-realtime-preview" if phone_record.assistant_type == "openai" else None,
            enable_thinking=enable_thinking if phone_record.assistant_type == "gemini" else None,
            thinking_budget=thinking_budget if phone_record.assistant_type == "gemini" else None,
            cartesia_voice_id=cartesia_voice_id,
            voice_speed=voice_speed,
            cartesia_api_key=cartesia_api_key,
        )
        
    except Exception as e:
        logger.error(f"[TELEPHONY] Config error: {e}", exc_info=True)
        return ScenarioConfigResponse(success=False)


# =============================================================================
# SIP ТРАНКИ (ВХОДЯЩИЕ ЗВОНКИ)
# =============================================================================

@router.post("/sip/connect")
async def connect_sip_trunk(
    request: SipConnectRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Подключить SIP транк для приёма входящих звонков от внешнего провайдера.

    Создаёт SIP регистрацию на дочернем аккаунте Voximplant,
    добавляет авторизованные IP адреса провайдера и создаёт номер в БД.
    """
    # 1. Найти дочерний аккаунт
    child_account = db.query(VoximplantChildAccount).filter(
        VoximplantChildAccount.user_id == current_user.id
    ).first()

    if not child_account:
        raise HTTPException(status_code=404, detail="Телефония не подключена. Сначала подключите телефонию.")

    # 2. Проверить верификацию
    if not child_account.is_verified:
        raise HTTPException(status_code=400, detail="Аккаунт не верифицирован. Пройдите верификацию перед подключением SIP.")

    # 3. Проверить, что провайдер ещё не подключён
    sip_regs = child_account.vox_sip_registrations or {}
    if request.provider in sip_regs:
        raise HTTPException(status_code=400, detail=f"Провайдер '{request.provider}' уже подключён.")

    # 4. Определить proxy
    if request.provider == "other":
        sip_proxy = request.custom_proxy
        if not sip_proxy:
            raise HTTPException(status_code=400, detail="Для провайдера 'other' укажите custom_proxy.")
    else:
        sip_proxy = SIP_PROVIDER_PROXIES.get(request.provider)
        if not sip_proxy:
            raise HTTPException(status_code=400, detail=f"Неизвестный провайдер: {request.provider}")

    # 5. Найти application_id и rule_id
    application_id = child_account.vox_application_id
    if not application_id:
        raise HTTPException(status_code=400, detail="Приложение Voximplant не настроено. Выполните настройку сценариев.")

    # Определяем ключ сценария для inbound
    scenario_key = get_scenario_key(request.assistant_type, "inbound")
    scenario_id = child_account.get_scenario_id(scenario_key)

    if not scenario_id:
        raise HTTPException(
            status_code=400,
            detail=f"Входящий сценарий для типа '{request.assistant_type}' не найден. Настройте сценарии."
        )

    # Создаём правило для SIP входящих
    service = get_voximplant_partner_service()
    rule_name = f"sip_inbound_{request.provider}"
    rule_result = await service.add_rule(
        child_account_id=child_account.vox_account_id,
        child_api_key=child_account.vox_api_key,
        application_id=application_id,
        rule_name=rule_name,
        rule_pattern=".*",
        scenario_id=scenario_id
    )

    if not rule_result.get("success"):
        if "not unique" in (rule_result.get("error") or "").lower():
            # Правило уже есть — найти существующее
            existing_rules = await service.get_rules(
                child_account_id=child_account.vox_account_id,
                child_api_key=child_account.vox_api_key,
                application_id=application_id
            )
            rule_id = None
            for r in (existing_rules.get("rules") or []):
                if r.get("rule_name") == rule_name:
                    rule_id = r.get("rule_id")
                    break
            if not rule_id:
                raise HTTPException(status_code=500, detail="Не удалось найти существующее правило маршрутизации.")
        else:
            raise HTTPException(
                status_code=500,
                detail=f"Ошибка создания правила маршрутизации: {rule_result.get('error', 'Unknown')}"
            )
    else:
        rule_id = rule_result["rule_id"]

    # 6. Создать SIP регистрацию
    result = await service.add_sip_registration(
        child_account_id=child_account.vox_account_id,
        child_api_key=child_account.vox_api_key,
        sip_proxy=sip_proxy,
        sip_login=request.sip_login,
        sip_password=request.sip_password,
        application_id=application_id,
        rule_id=str(rule_id)
    )

    if not result.get("success"):
        # Откатываем правило
        await service.delete_rule(
            child_account_id=child_account.vox_account_id,
            child_api_key=child_account.vox_api_key,
            rule_id=str(rule_id)
        )
        raise HTTPException(
            status_code=500,
            detail=f"Ошибка создания SIP регистрации: {result.get('error', 'Unknown')}"
        )

    sip_registration_id = result["sip_registration_id"]

    # 7. Добавить авторизованные IP для известных провайдеров
    if request.provider != "other":
        provider_ips = SIP_PROVIDER_IPS.get(request.provider, [])
        for ip in provider_ips:
            try:
                await service.add_authorized_ip(
                    child_account_id=child_account.vox_account_id,
                    child_api_key=child_account.vox_api_key,
                    ip=ip
                )
            except Exception as e:
                logger.warning(f"[TELEPHONY] Failed to add authorized IP {ip}: {e}")

    # 8. Сформировать адрес терминации
    termination_address = f"voicyfy.{child_account.vox_account_name}.voximplant.com"

    # 9. Создать запись номера в БД
    phone_record = VoximplantPhoneNumber(
        child_account_id=child_account.id,
        phone_number=request.phone_number,
        phone_number_id=f"sip_{sip_registration_id}",
        phone_source="sip",
        sip_provider=request.provider,
        sip_registration_id=sip_registration_id,
        assistant_id=uuid.UUID(request.assistant_id),
        assistant_type=request.assistant_type,
        first_phrase=request.first_phrase,
        vox_rule_id=str(rule_id),
        is_active=True,
    )
    db.add(phone_record)

    # 10. Обновить vox_sip_registrations
    if child_account.vox_sip_registrations is None:
        child_account.vox_sip_registrations = {}

    child_account.vox_sip_registrations[request.provider] = {
        "sip_id": sip_registration_id,
        "proxy": sip_proxy,
        "login": request.sip_login,
        "phone_number": request.phone_number,
        "status": "active",
        "termination_address": termination_address,
    }

    # 11. flag_modified — обязательно для JSON полей
    flag_modified(child_account, "vox_sip_registrations")

    # 12. Сохранить
    db.commit()

    logger.info(f"[TELEPHONY] ✅ SIP trunk connected: provider={request.provider}, "
                f"sip_id={sip_registration_id}, user={current_user.id}")

    # 13. Вернуть результат
    return {
        "success": True,
        "sip_registration_id": sip_registration_id,
        "termination_address": termination_address,
        "provider_instruction": SIP_PROVIDER_INSTRUCTIONS.get(request.provider, SIP_PROVIDER_INSTRUCTIONS["other"]),
    }


@router.delete("/sip/{provider}")
async def disconnect_sip_trunk(
    provider: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Отключить SIP транк (удалить SIP регистрацию и номер).
    """
    # 1. Найти дочерний аккаунт
    child_account = db.query(VoximplantChildAccount).filter(
        VoximplantChildAccount.user_id == current_user.id
    ).first()

    if not child_account:
        raise HTTPException(status_code=404, detail="Телефония не подключена.")

    # 2. Проверить наличие провайдера
    sip_regs = child_account.vox_sip_registrations or {}
    if provider not in sip_regs:
        raise HTTPException(status_code=404, detail=f"SIP провайдер '{provider}' не подключён.")

    # 3. Получить sip_id
    sip_id = sip_regs[provider].get("sip_id")

    # 4. Удалить SIP регистрацию в Voximplant
    if sip_id:
        service = get_voximplant_partner_service()
        try:
            await service.delete_sip_registration(
                child_account_id=child_account.vox_account_id,
                child_api_key=child_account.vox_api_key,
                sip_registration_id=sip_id
            )
        except Exception as e:
            logger.error(f"[TELEPHONY] Error deleting SIP registration {sip_id}: {e}")

    # 5. Найти и удалить номер из БД
    phone_record = db.query(VoximplantPhoneNumber).filter(
        VoximplantPhoneNumber.child_account_id == child_account.id,
        VoximplantPhoneNumber.sip_provider == provider,
        VoximplantPhoneNumber.phone_source == "sip",
    ).first()

    if phone_record:
        # Удалить правило маршрутизации если есть
        if phone_record.vox_rule_id:
            try:
                service = get_voximplant_partner_service()
                await service.delete_rule(
                    child_account_id=child_account.vox_account_id,
                    child_api_key=child_account.vox_api_key,
                    rule_id=phone_record.vox_rule_id
                )
            except Exception as e:
                logger.warning(f"[TELEPHONY] Error deleting SIP rule: {e}")

        db.delete(phone_record)

    # 6. Убрать из vox_sip_registrations
    del child_account.vox_sip_registrations[provider]
    flag_modified(child_account, "vox_sip_registrations")

    # 7. Сохранить
    db.commit()

    logger.info(f"[TELEPHONY] ✅ SIP trunk disconnected: provider={provider}, user={current_user.id}")

    return {"success": True}


@router.get("/sip/list")
async def list_sip_trunks(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Получить список подключённых SIP транков с информацией об ассистентах.
    """
    # 1. Найти дочерний аккаунт
    child_account = db.query(VoximplantChildAccount).filter(
        VoximplantChildAccount.user_id == current_user.id
    ).first()

    if not child_account:
        return {"sip_connections": []}

    sip_regs = child_account.vox_sip_registrations or {}

    if not sip_regs:
        return {"sip_connections": []}

    connections = []

    for provider, data in sip_regs.items():
        # Найти связанный номер и имя ассистента
        phone_record = db.query(VoximplantPhoneNumber).filter(
            VoximplantPhoneNumber.child_account_id == child_account.id,
            VoximplantPhoneNumber.sip_provider == provider,
            VoximplantPhoneNumber.phone_source == "sip",
        ).first()

        assistant_name = None
        assistant_type = None

        if phone_record and phone_record.assistant_id:
            assistant, a_type, _ = find_assistant_by_id(db, phone_record.assistant_id)
            if assistant:
                assistant_name = getattr(assistant, "name", None)
                assistant_type = a_type

        connections.append({
            "provider": provider,
            "proxy": data.get("proxy", ""),
            "phone_number": data.get("phone_number", ""),
            "status": data.get("status", "unknown"),
            "termination_address": data.get("termination_address", ""),
            "assistant_name": assistant_name,
            "assistant_type": assistant_type or (phone_record.assistant_type if phone_record else None),
        })

    return {"sip_connections": connections}


# =============================================================================
# WEBHOOK ДЛЯ VOXIMPLANT CALLBACKS
# =============================================================================

@router.post("/webhook/verification-status")
async def webhook_verification_status(
    request: Request,
    db: Session = Depends(get_db),
):
    """
    Webhook для обновлений статуса верификации от Voximplant.
    """
    try:
        body = await request.json()
        logger.info(f"[TELEPHONY] Webhook received: {body}")
        
        callbacks = body.get("callbacks", [])
        
        if not callbacks and body.get("type") == "account_document_status_updated":
            callbacks = [body]
        
        if not callbacks and body.get("account_document_status"):
            callbacks = [body]
        
        processed_count = 0
        
        for callback in callbacks:
            callback_type = callback.get("type", "account_document_status_updated")
            
            if callback_type not in ["account_document_status_updated", None]:
                logger.info(f"[TELEPHONY] Skipping callback type: {callback_type}")
                continue
            
            account_id = str(callback.get("account_id", ""))
            account_document_status = callback.get("account_document_status")
            previous_status = callback.get("previous_account_document_status")
            
            if not account_id or not account_document_status:
                logger.warning(f"[TELEPHONY] Missing account_id or status in callback: {callback}")
                continue
            
            logger.info(f"[TELEPHONY] Processing: {account_id} | {previous_status} -> {account_document_status}")
            
            child_account = db.query(VoximplantChildAccount).filter(
                VoximplantChildAccount.vox_account_id == account_id
            ).first()
            
            if not child_account:
                logger.warning(f"[TELEPHONY] Account not found: {account_id}")
                continue
            
            status_mapping = {
                "AWAITING_DOCUMENTS_UPLOADING": VoximplantVerificationStatus.awaiting_documents,
                "AWAITING_AGREEMENT_UPLOADING": VoximplantVerificationStatus.awaiting_agreement,
                "AWAITING_VERIFICATION": VoximplantVerificationStatus.awaiting_verification,
                "WAITING_FOR_CONFIRMATION_DOCUMENTS": VoximplantVerificationStatus.awaiting_verification,
                "VERIFIED": VoximplantVerificationStatus.verified,
                "REJECTED": VoximplantVerificationStatus.rejected,
                "WAITING_PERIOD_EXPIRED": VoximplantVerificationStatus.rejected,
            }
            
            if account_document_status in status_mapping:
                new_status = status_mapping[account_document_status]
                old_status = child_account.verification_status
                
                child_account.verification_status = new_status
                
                if account_document_status == "VERIFIED" and not child_account.verified_at:
                    child_account.verified_at = datetime.now(timezone.utc)
                
                db.commit()
                processed_count += 1
                
                logger.info(f"[TELEPHONY] ✅ Status updated via webhook: {account_id} | {old_status} -> {new_status}")
            else:
                logger.warning(f"[TELEPHONY] Unknown status: {account_document_status}")
        
        return {
            "status": "ok",
            "processed": processed_count,
            "received": len(callbacks)
        }
        
    except Exception as e:
        logger.error(f"[TELEPHONY] Webhook error: {e}", exc_info=True)
        return {"status": "error", "message": str(e)}

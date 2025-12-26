"""
Сервис для работы с Voximplant Partner API.

Реализует создание и управление дочерними аккаунтами:
- Создание/клонирование аккаунтов
- Создание SubUsers для верификации и биллинга
- Получение ссылок на верификацию и биллинг
- Работа с номерами телефонов
- Проверка статуса верификации
- Управление сценариями и правилами маршрутизации
- Запуск исходящих звонков

Документация Voximplant API:
https://voximplant.com/docs/references/httpapi/accounts

✅ v1.0: Базовый функционал Partner API
✅ v1.3: Исправлены параметры API (parent_account_id, parent_account_api_key, account_password)
✅ v1.4: Исправлен check_verification_status - теперь использует GetAccountDocuments
✅ v1.5: Комбинированная проверка верификации (по номерам + GetAccountDocuments)
✅ v1.6: Добавлен set_account_callback для webhook-уведомлений
✅ v1.7: Добавлено управление сценариями (get_scenarios, add_scenario, add_application, add_rule)
✅ v1.8: ИСПРАВЛЕНО копирование сценариев - запрос кода для каждого сценария отдельно
         (Voximplant API quirk: with_script=true не возвращает код при массовом запросе)
✅ v2.1: Добавлен fallback для получения phone_id через GetPhoneNumbers если AttachPhoneNumber не вернул ID
✅ v2.2: Добавлен метод update_scenario для массового обновления сценариев на дочерних аккаунтах
✅ v3.0: OUTBOUND CALLS - добавлена поддержка исходящих звонков:
         - setup_child_account_scenarios() теперь создаёт Rules для outbound
         - Новый метод start_outbound_call() для запуска исходящих звонков
         - Новый метод setup_outbound_rules() для создания Rules на существующих аккаунтах
✅ v3.1: CRM INTEGRATION - расширена передача контекста в start_outbound_call():
         - contact_name, task_title, task_description, custom_greeting, timezone
         - Полная поддержка Task-based звонков из CRM
"""

import httpx
import json
import secrets
import string
from typing import Optional, Dict, Any, List

from backend.core.logging import get_logger
from backend.core.config import settings

logger = get_logger(__name__)


class VoximplantPartnerService:
    """
    Сервис для работы с Voximplant Partner API.
    
    Использует credentials родительского аккаунта для создания
    и управления дочерними аккаунтами.
    """
    
    # Базовые URL API Voximplant (для России)
    API_BASE_URL = "https://api.voximplant.com/platform_api"
    MANAGE_API_URL = "https://api-ru-manage.voximplant.com/api"
    VERIFICATION_URL = "https://verify.voximplant.com/verification_ru"
    BILLING_URL = "https://billing.voximplant.com/login.php"
    
    # ✅ v1.6: URL для webhook
    WEBHOOK_URL = "https://voicyfy.ru/api/telephony/webhook/verification-status"
    
    # ✅ v3.0: Типы сценариев для outbound
    OUTBOUND_SCENARIO_TYPES = ["outbound_openai", "outbound_gemini"]
    
    def __init__(
        self,
        parent_account_id: Optional[str] = None,
        parent_api_key: Optional[str] = None,
        template_account_id: Optional[str] = None
    ):
        """
        Инициализация сервиса.
        
        Args:
            parent_account_id: ID родительского аккаунта (по умолчанию из settings)
            parent_api_key: API ключ родительского аккаунта (по умолчанию из settings)
            template_account_id: ID эталонного аккаунта для клонирования (опционально)
        """
        self.parent_account_id = parent_account_id or settings.VOXIMPLANT_PARENT_ACCOUNT_ID
        self.parent_api_key = parent_api_key or settings.VOXIMPLANT_PARENT_API_KEY
        self.template_account_id = template_account_id or getattr(settings, 'VOXIMPLANT_TEMPLATE_ACCOUNT_ID', None)
        
        self._client: Optional[httpx.AsyncClient] = None
    
    async def _get_client(self) -> httpx.AsyncClient:
        """Получить или создать HTTP клиент"""
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=60.0)  # Увеличен таймаут для больших сценариев
        return self._client
    
    async def close(self):
        """Закрыть HTTP клиент"""
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None
    
    # =========================================================================
    # СОЗДАНИЕ АККАУНТА
    # =========================================================================
    
    async def create_child_account(
        self,
        account_name: str,
        account_email: str,
        account_password: Optional[str] = None,
        use_template: bool = True
    ) -> Dict[str, Any]:
        """
        Создать дочерний аккаунт.
        
        Если есть эталонный аккаунт и use_template=True, использует CloneAccount.
        Иначе создаёт пустой аккаунт через AddAccount.
        """
        if not account_password:
            account_password = self._generate_secure_password()
        
        if use_template and self.template_account_id:
            return await self._clone_account(account_name, account_email, account_password)
        else:
            return await self._add_account(account_name, account_email, account_password)
    
    async def _add_account(self, account_name: str, account_email: str, account_password: str) -> Dict[str, Any]:
        """Создать пустой дочерний аккаунт"""
        url = f"{self.API_BASE_URL}/AddAccount"
        
        params = {
            "parent_account_id": self.parent_account_id,
            "parent_account_api_key": self.parent_api_key,
            "account_name": account_name,
            "account_email": account_email,
            "account_password": account_password,
            "active": "true",
        }
        
        logger.info(f"[VOXIMPLANT] Creating child account: {account_name}")
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            logger.error(f"[VOXIMPLANT] Failed to create account: {result}")
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        logger.info(f"[VOXIMPLANT] ✅ Account created: {result.get('account_id')}")
        
        return {
            "success": True,
            "account_id": str(result.get("account_id")),
            "account_name": account_name,
            "account_email": account_email,
            "account_password": account_password,
            "api_key": result.get("api_key"),
        }
    
    async def _clone_account(self, account_name: str, account_email: str, account_password: str) -> Dict[str, Any]:
        """Клонировать эталонный аккаунт"""
        url = f"{self.API_BASE_URL}/CloneAccount"
        
        params = {
            "parent_account_id": self.parent_account_id,
            "parent_account_api_key": self.parent_api_key,
            "account_id": self.template_account_id,
            "new_account_name": account_name,
            "new_account_email": account_email,
            "new_account_password": account_password,
        }
        
        logger.info(f"[VOXIMPLANT] Cloning template account to: {account_name}")
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            logger.error(f"[VOXIMPLANT] Failed to clone account: {result}")
            logger.info(f"[VOXIMPLANT] Falling back to AddAccount...")
            return await self._add_account(account_name, account_email, account_password)
        
        cloned = result.get("result", {})
        
        return {
            "success": True,
            "account_id": str(cloned.get("account_id")),
            "account_name": account_name,
            "account_email": account_email,
            "account_password": account_password,
            "api_key": cloned.get("api_key"),
        }
    
    # =========================================================================
    # SUBUSERS
    # =========================================================================
    
    async def create_subuser(
        self,
        child_account_id: str,
        child_api_key: str,
        subuser_name: str,
        roles: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """Создать SubUser для дочернего аккаунта."""
        url = f"{self.API_BASE_URL}/AddSubUser"
        
        password = self._generate_secure_password()
        
        params = {
            "account_id": child_account_id,
            "api_key": child_api_key,
            "new_subuser_name": subuser_name,
            "new_subuser_password": password,
            "role_id": "7;9",
        }
        
        logger.info(f"[VOXIMPLANT] Creating subuser {subuser_name} for account {child_account_id}")
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            logger.error(f"[VOXIMPLANT] Failed to create subuser: {result}")
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        return {
            "success": True,
            "subuser_id": result.get("subuser_id"),
            "subuser_name": subuser_name,
            "subuser_password": password,
        }
    
    def _generate_secure_password(self, length: int = 16) -> str:
        """Генерирует безопасный пароль"""
        password = [
            secrets.choice(string.ascii_uppercase),
            secrets.choice(string.ascii_lowercase),
            secrets.choice(string.digits),
            secrets.choice("!@#$%"),
        ]
        alphabet = string.ascii_letters + string.digits + "!@#$%"
        password += [secrets.choice(alphabet) for _ in range(length - 4)]
        secrets.SystemRandom().shuffle(password)
        return ''.join(password)
    
    def generate_unique_email(self, user_email: str, user_id: str) -> str:
        """Генерирует уникальный email для дочернего аккаунта Voximplant."""
        import time
        timestamp = int(time.time())
        
        if "@gmail.com" in user_email.lower():
            local_part = user_email.split("@")[0]
            return f"{local_part}+vox{timestamp}@gmail.com"
        
        return f"vox-{user_id[:8]}-{timestamp}@voicyfy.ru"
    
    # =========================================================================
    # ВЕРИФИКАЦИЯ
    # =========================================================================
    
    async def get_verification_url(
        self,
        child_account_id: str,
        child_api_key: str,
        subuser_login: str,
        subuser_password: str,
        verification_type: str = "legal_entity"
    ) -> Dict[str, Any]:
        """Получить URL для страницы верификации."""
        logger.info(f"[VOXIMPLANT] Getting verification URL for account {child_account_id}")
        
        client = await self._get_client()
        
        # Шаг 1: Logon
        logon_url = f"{self.MANAGE_API_URL}/Logon"
        logon_params = {
            "account_id": child_account_id,
            "subuser_login": subuser_login,
            "subuser_password": subuser_password,
        }
        
        response = await client.post(logon_url, data=logon_params)
        logon_result = response.json()
        
        if "error" in logon_result:
            return {"success": False, "error": logon_result.get("error", {}).get("msg", "Logon failed")}
        
        temp_session = logon_result.get("result")
        
        # Шаг 2: GetSessionID
        session_url = f"{self.MANAGE_API_URL}/GetSessionID"
        session_params = {
            "account_id": child_account_id,
            "subuser_login": subuser_login,
            "session_id": temp_session,
        }
        
        response = await client.post(session_url, data=session_params)
        session_result = response.json()
        
        if "error" in session_result:
            return {"success": False, "error": session_result.get("error", {}).get("msg", "Session failed")}
        
        session_id = session_result.get("result")
        
        # Шаг 3: Формируем URL
        verification_url = (
            f"{self.VERIFICATION_URL}"
            f"?account_id={child_account_id}"
            f"&subuser_login={subuser_login}"
            f"&session_id={session_id}"
            f"&tab={verification_type}"
            f"&_lang=RU"
        )
        
        return {"success": True, "url": verification_url, "session_id": session_id}
    
    async def check_verification_status(
        self,
        child_account_id: str,
        child_api_key: str
    ) -> Dict[str, Any]:
        """
        Проверить статус верификации аккаунта.
        
        ✅ v1.5: Комбинированный подход:
        1. Сначала проверяем доступность номеров (надёжный индикатор)
        2. Если номера недоступны - проверяем GetAccountDocuments для детального статуса
        """
        logger.info(f"[VOXIMPLANT] Checking verification status for account {child_account_id}")
        
        client = await self._get_client()
        
        # =====================================================================
        # ШАГ 1: Проверяем доступность номеров (главный индикатор верификации)
        # =====================================================================
        try:
            check_url = f"{self.API_BASE_URL}/GetNewPhoneNumbers"
            check_params = {
                "account_id": child_account_id,
                "api_key": child_api_key,
                "country_code": "RU",
                "count": 1
            }
            
            response = await client.post(check_url, data=check_params)
            result = response.json()
            
            logger.info(f"[VOXIMPLANT] GetNewPhoneNumbers response: total_count={result.get('total_count', 0)}")
            
            # Если номера доступны - верификация точно пройдена!
            if "result" in result and len(result.get("result", [])) > 0:
                total_available = result.get("total_count", len(result.get("result", [])))
                logger.info(f"[VOXIMPLANT] ✅ Account {child_account_id} is VERIFIED (numbers available: {total_available})")
                return {
                    "success": True,
                    "verification_status": "VERIFIED",
                    "is_verified": True,
                    "raw_status": "VERIFIED_BY_NUMBERS_CHECK",
                }
                
        except Exception as e:
            logger.warning(f"[VOXIMPLANT] Numbers check failed: {e}")
        
        # =====================================================================
        # ШАГ 2: Если номера недоступны - проверяем детальный статус
        # =====================================================================
        url = f"{self.API_BASE_URL}/GetAccountDocuments"
        params = {
            "account_id": child_account_id,
            "api_key": child_api_key,
        }
        
        response = await client.post(url, data=params)
        result = response.json()
        
        logger.info(f"[VOXIMPLANT] GetAccountDocuments response: {result}")
        
        if "error" in result:
            logger.error(f"[VOXIMPLANT] GetAccountDocuments failed: {result}")
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        documents = result.get("result", [])
        verification_status = "NOT_STARTED"
        is_verified = False
        raw_status = None
        
        if documents:
            for doc in documents:
                verifications = doc.get("verifications", [])
                if verifications:
                    verification = verifications[0]
                    raw_status = verification.get("verification_status", "")
                    
                    status_mapping = {
                        "IN_PROGRESS": "AWAITING_VERIFICATION",
                        "VERIFIED": "VERIFIED",
                        "REJECTED": "REJECTED",
                        "PENDING": "AWAITING_DOCUMENTS_UPLOADING",
                        "AWAITING_DOCUMENTS": "AWAITING_DOCUMENTS_UPLOADING",
                        "AWAITING_AGREEMENT": "AWAITING_AGREEMENT_UPLOADING",
                    }
                    
                    verification_status = status_mapping.get(raw_status, raw_status or "NOT_STARTED")
                    is_verified = raw_status == "VERIFIED"
                    break
        
        logger.info(f"[VOXIMPLANT] Final status: {verification_status} (raw: {raw_status})")
        
        return {
            "success": True,
            "verification_status": verification_status,
            "is_verified": is_verified,
            "raw_status": raw_status,
        }
    
    # =========================================================================
    # WEBHOOK (CALLBACK) ДЛЯ АВТОМАТИЧЕСКИХ УВЕДОМЛЕНИЙ
    # =========================================================================
    
    async def set_account_callback(
        self,
        child_account_id: str,
        child_api_key: str,
        callback_url: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Установить webhook URL для получения уведомлений об изменении статуса верификации.
        
        ✅ v1.6: Регистрация callback для автоматических обновлений статуса.
        """
        url = f"{self.API_BASE_URL}/SetAccountCallback"
        
        if callback_url is None:
            callback_url = self.WEBHOOK_URL
        
        params = {
            "account_id": child_account_id,
            "api_key": child_api_key,
            "callback_url": callback_url,
            "account_document_status_updated": "true",
        }
        
        logger.info(f"[VOXIMPLANT] Setting callback URL for account {child_account_id}: {callback_url}")
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        logger.info(f"[VOXIMPLANT] SetAccountCallback response: {result}")
        
        if "error" in result:
            logger.error(f"[VOXIMPLANT] SetAccountCallback failed: {result}")
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        logger.info(f"[VOXIMPLANT] ✅ Callback URL set successfully for account {child_account_id}")
        
        return {"success": True, "result": result.get("result", 1)}
    
    async def get_account_callback(
        self,
        child_account_id: str,
        child_api_key: str
    ) -> Dict[str, Any]:
        """Получить текущие настройки callback для аккаунта."""
        url = f"{self.API_BASE_URL}/GetAccountCallback"
        
        params = {
            "account_id": child_account_id,
            "api_key": child_api_key,
        }
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        return {"success": True, "callback_info": result.get("result", {})}
    
    # =========================================================================
    # БИЛЛИНГ
    # =========================================================================
    
    async def get_billing_url(
        self,
        child_account_id: str,
        child_api_key: str,
        start_page: str = "card"
    ) -> Dict[str, Any]:
        """Получить URL для страницы биллинга."""
        billing_url = (
            f"{self.BILLING_URL}"
            f"?account_id={child_account_id}"
            f"&api_key={child_api_key}"
            f"&_start_page={start_page}"
            f"&_lang=RU"
            f"&hide_account_name=false"
        )
        return {"success": True, "url": billing_url}
    
    async def get_account_balance(
        self,
        child_account_id: str,
        child_api_key: str
    ) -> Dict[str, Any]:
        """Получить баланс аккаунта"""
        url = f"{self.API_BASE_URL}/GetAccountInfo"
        params = {"account_id": child_account_id, "api_key": child_api_key}
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        account_info = result.get("result", {})
        return {
            "success": True,
            "balance": account_info.get("live_balance", 0),
            "currency": account_info.get("currency", "RUR"),
        }
    
    # =========================================================================
    # ТЕЛЕФОННЫЕ НОМЕРА
    # =========================================================================
    
    async def get_phone_regions(
        self,
        child_account_id: str,
        child_api_key: str,
        country_code: str = "RU",
        category: Optional[str] = None
    ) -> Dict[str, Any]:
        """Получить список доступных регионов для покупки номеров."""
        url = f"{self.API_BASE_URL}/GetPhoneNumberRegions"
        
        params = {
            "account_id": child_account_id,
            "api_key": child_api_key,
            "country_code": country_code,
        }
        
        if category:
            params["phone_category_name"] = category
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        regions = result.get("result", [])
        
        return {
            "success": True,
            "regions": [
                {
                    "region_id": r.get("phone_region_id"),
                    "region_name": r.get("phone_region_name"),
                    "region_code": r.get("phone_region_code"),
                    "phone_count": r.get("phone_count", 0),
                    "phone_price": r.get("phone_price"),
                    "phone_installation_price": r.get("phone_installation_price", 0),
                }
                for r in regions
            ],
            "total": len(regions),
        }

    async def get_available_numbers(
        self,
        child_account_id: str,
        child_api_key: str,
        country_code: str = "RU",
        region_id: Optional[int] = None,
        category: Optional[str] = None,
        count: int = 20,
        offset: int = 0
    ) -> Dict[str, Any]:
        """
        Получить список доступных номеров для покупки.
        
        Args:
            region_id: ID региона (получить из get_phone_regions)
            category: Категория номеров - GEOGRAPHIC (городские), MOBILE, TOLLFREE (8-800)
            count: Количество номеров
            offset: Смещение для пагинации
        """
        url = f"{self.API_BASE_URL}/GetNewPhoneNumbers"
        
        params = {
            "account_id": child_account_id,
            "api_key": child_api_key,
            "country_code": country_code,
            "count": count,
            "offset": offset,
        }
        
        if region_id is not None and region_id > 0:
            params["phone_region_id"] = int(region_id)
        
        if category:
            params["phone_category_name"] = category
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        numbers = result.get("result", [])
        
        return {
            "success": True,
            "numbers": [
                {
                    "phone_number": n.get("phone_number"),
                    "phone_price": n.get("phone_price"),
                    "phone_installation_price": n.get("phone_installation_price"),
                    "phone_region_name": n.get("phone_region_name"),
                    "phone_period": n.get("phone_period"),
                    "phone_category_name": n.get("phone_category_name"),
                }
                for n in numbers
            ],
            "total": result.get("total_count", len(numbers)),
        }
    
    async def buy_phone_number(
        self,
        child_account_id: str,
        child_api_key: str,
        phone_number: str
    ) -> Dict[str, Any]:
        """Купить телефонный номер."""
        url = f"{self.API_BASE_URL}/AttachPhoneNumber"
        
        params = {
            "account_id": child_account_id,
            "api_key": child_api_key,
            "phone_number": phone_number,
        }
        
        logger.info(f"[VOXIMPLANT] Buying phone number {phone_number}")
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        # ✅ v2.1: Логируем полный ответ для отладки
        logger.info(f"[VOXIMPLANT] AttachPhoneNumber response: {result}")
        
        if "error" in result:
            logger.error(f"[VOXIMPLANT] Failed to buy number: {result}")
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        phone_id = result.get("phone_id")
        
        # ✅ v2.1: Fallback - если phone_id не вернулся, получаем через GetPhoneNumbers
        if not phone_id:
            logger.warning(f"[VOXIMPLANT] ⚠️ No phone_id in response, fetching via GetPhoneNumbers...")
            phone_id = await self.find_phone_id_by_number(
                child_account_id=child_account_id,
                child_api_key=child_api_key,
                phone_number=phone_number
            )
        
        if not phone_id:
            logger.error(f"[VOXIMPLANT] ❌ Could not get phone_id for {phone_number}")
            return {"success": False, "error": "Номер куплен, но не удалось получить ID. Обратитесь в поддержку."}
        
        logger.info(f"[VOXIMPLANT] ✅ Phone number purchased: {phone_number} (id: {phone_id})")
        
        return {"success": True, "phone_id": phone_id, "phone_number": phone_number}
    
    async def find_phone_id_by_number(
        self,
        child_account_id: str,
        child_api_key: str,
        phone_number: str
    ) -> Optional[int]:
        """
        Найти phone_id по номеру телефона через GetPhoneNumbers.
        
        ✅ v2.1: Fallback-метод если AttachPhoneNumber не вернул phone_id.
        """
        try:
            result = await self.get_phone_numbers(
                child_account_id=child_account_id,
                child_api_key=child_api_key
            )
            
            if not result.get("success"):
                logger.error(f"[VOXIMPLANT] GetPhoneNumbers failed: {result.get('error')}")
                return None
            
            # Нормализуем искомый номер (только цифры)
            normalized_search = ''.join(filter(str.isdigit, phone_number))
            
            for num in result.get("numbers", []):
                normalized_num = ''.join(filter(str.isdigit, num.get("phone_number", "")))
                if normalized_num == normalized_search or normalized_num.endswith(normalized_search[-10:]):
                    phone_id = num.get("phone_id")
                    logger.info(f"[VOXIMPLANT] ✅ Found phone_id via GetPhoneNumbers: {phone_id}")
                    return phone_id
            
            logger.warning(f"[VOXIMPLANT] Phone {phone_number} not found in GetPhoneNumbers response")
            return None
            
        except Exception as e:
            logger.error(f"[VOXIMPLANT] Error finding phone_id: {e}")
            return None
    
    async def bind_phone_to_application(
        self,
        child_account_id: str,
        child_api_key: str,
        phone_id: str,
        application_id: str,
        rule_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Привязать номер к приложению и правилу роутинга."""
        url = f"{self.API_BASE_URL}/BindPhoneNumberToApplication"
        
        params = {
            "account_id": child_account_id,
            "api_key": child_api_key,
            "phone_id": phone_id,
            "application_id": application_id,
        }
        
        if rule_id:
            params["rule_id"] = rule_id
        
        logger.info(f"[VOXIMPLANT] Binding phone {phone_id} to app {application_id}")
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            logger.error(f"[VOXIMPLANT] Failed to bind phone: {result}")
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        logger.info(f"[VOXIMPLANT] ✅ Phone bound to application")
        return {"success": True, "result": result.get("result")}
    
    async def get_phone_numbers(
        self,
        child_account_id: str,
        child_api_key: str
    ) -> Dict[str, Any]:
        """Получить список купленных номеров аккаунта."""
        url = f"{self.API_BASE_URL}/GetPhoneNumbers"
        params = {"account_id": child_account_id, "api_key": child_api_key}
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        numbers = result.get("result", [])
        
        return {
            "success": True,
            "numbers": [
                {
                    "phone_id": n.get("phone_id"),
                    "phone_number": n.get("phone_number"),
                    "phone_region_name": n.get("phone_region_name"),
                    "phone_next_renewal": n.get("phone_next_renewal"),
                    "application_id": n.get("application_id"),
                    "application_name": n.get("application_name"),
                }
                for n in numbers
            ],
            "total": len(numbers),
        }
    
    # =========================================================================
    # ПРИЛОЖЕНИЯ (APPLICATIONS)
    # =========================================================================
    
    async def get_applications(
        self,
        child_account_id: str,
        child_api_key: str
    ) -> Dict[str, Any]:
        """Получить список приложений аккаунта"""
        url = f"{self.API_BASE_URL}/GetApplications"
        params = {"account_id": child_account_id, "api_key": child_api_key}
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        return {"success": True, "applications": result.get("result", [])}
    
    async def add_application(
        self,
        child_account_id: str,
        child_api_key: str,
        application_name: str
    ) -> Dict[str, Any]:
        """
        Создать приложение на дочернем аккаунте.
        
        Args:
            application_name: Имя приложения (например, 'voicyfy')
        """
        url = f"{self.API_BASE_URL}/AddApplication"
        
        params = {
            "account_id": child_account_id,
            "api_key": child_api_key,
            "application_name": application_name,
        }
        
        logger.info(f"[VOXIMPLANT] Creating application '{application_name}' for account {child_account_id}")
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            logger.error(f"[VOXIMPLANT] Failed to create application: {result}")
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        application_id = result.get("application_id")
        logger.info(f"[VOXIMPLANT] ✅ Application created: {application_id}")
        
        return {
            "success": True,
            "application_id": application_id,
            "application_name": application_name,
        }
    
    # =========================================================================
    # СЦЕНАРИИ (SCENARIOS)
    # =========================================================================
    
    async def get_scenarios(
        self,
        account_id: str,
        api_key: str,
        with_script: bool = False,
        scenario_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Получить список сценариев аккаунта.
        
        ⚠️ ВАЖНО: Voximplant API quirk!
        При массовом запросе (без scenario_id) параметр with_script=true 
        НЕ возвращает код сценариев. Код возвращается только при запросе
        конкретного сценария по scenario_id.
        
        Args:
            account_id: ID аккаунта
            api_key: API ключ аккаунта
            with_script: Включить код сценариев в ответ
            scenario_id: Опциональный ID конкретного сценария (нужен для получения кода!)
        """
        url = f"{self.API_BASE_URL}/GetScenarios"
        
        params = {
            "account_id": account_id,
            "api_key": api_key,
        }
        
        if with_script:
            params["with_script"] = "true"
        
        if scenario_id:
            params["scenario_id"] = scenario_id
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        scenarios = result.get("result", [])
        
        return {
            "success": True,
            "scenarios": [
                {
                    "scenario_id": s.get("scenario_id"),
                    "scenario_name": s.get("scenario_name"),
                    "scenario_script": s.get("scenario_script"),
                    "application_id": s.get("application_id"),
                    "application_name": s.get("application_name"),
                    "parent": s.get("parent", False),
                }
                for s in scenarios
            ],
            "total": len(scenarios),
        }
    
    async def get_parent_scenarios(self, with_script: bool = False) -> Dict[str, Any]:
        """
        Получить сценарии с родительского аккаунта.
        Используется для копирования на дочерние аккаунты.
        
        ⚠️ ВАЖНО: with_script=True НЕ вернёт код при массовом запросе!
        Для получения кода используйте get_scenario_with_script() для каждого сценария.
        """
        return await self.get_scenarios(
            account_id=self.parent_account_id,
            api_key=self.parent_api_key,
            with_script=with_script
        )
    
    async def get_scenario_with_script(
        self,
        account_id: str,
        api_key: str,
        scenario_id: int
    ) -> Dict[str, Any]:
        """
        Получить конкретный сценарий С КОДОМ.
        
        ✅ v1.8: Этот метод гарантированно возвращает код сценария,
        т.к. запрашивает конкретный сценарий по ID.
        """
        result = await self.get_scenarios(
            account_id=account_id,
            api_key=api_key,
            with_script=True,
            scenario_id=scenario_id
        )
        
        if not result.get("success"):
            return result
        
        scenarios = result.get("scenarios", [])
        if not scenarios:
            return {"success": False, "error": f"Scenario {scenario_id} not found"}
        
        return {"success": True, "scenario": scenarios[0]}
    
    async def add_scenario(
        self,
        child_account_id: str,
        child_api_key: str,
        scenario_name: str,
        scenario_script: str
    ) -> Dict[str, Any]:
        """
        Создать сценарий на дочернем аккаунте.
        
        Args:
            scenario_name: Имя сценария (например, 'inbound_gemini')
            scenario_script: Код сценария (VoxEngine JavaScript)
        """
        url = f"{self.API_BASE_URL}/AddScenario"
        
        params = {
            "account_id": child_account_id,
            "api_key": child_api_key,
            "scenario_name": scenario_name,
            "scenario_script": scenario_script,
        }
        
        logger.info(f"[VOXIMPLANT] Creating scenario '{scenario_name}' for account {child_account_id}")
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            logger.error(f"[VOXIMPLANT] Failed to create scenario: {result}")
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        scenario_id = result.get("scenario_id")
        logger.info(f"[VOXIMPLANT] ✅ Scenario created: {scenario_name} (ID: {scenario_id})")
        
        return {
            "success": True,
            "scenario_id": scenario_id,
            "scenario_name": scenario_name,
        }
    
    async def set_scenario_info(
        self,
        child_account_id: str,
        child_api_key: str,
        scenario_id: int,
        scenario_script: Optional[str] = None,
        scenario_name: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Обновить сценарий на дочернем аккаунте.
        
        Args:
            scenario_id: ID сценария для обновления
            scenario_script: Новый код сценария (опционально)
            scenario_name: Новое имя сценария (опционально)
        """
        url = f"{self.API_BASE_URL}/SetScenarioInfo"
        
        params = {
            "account_id": child_account_id,
            "api_key": child_api_key,
            "scenario_id": scenario_id,
        }
        
        if scenario_script:
            params["scenario_script"] = scenario_script
        
        if scenario_name:
            params["scenario_name"] = scenario_name
        
        logger.info(f"[VOXIMPLANT] Updating scenario {scenario_id} for account {child_account_id}")
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            logger.error(f"[VOXIMPLANT] Failed to update scenario: {result}")
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        logger.info(f"[VOXIMPLANT] ✅ Scenario updated: {scenario_id}")
        
        return {"success": True, "result": result.get("result")}
    
    async def update_scenario(
        self,
        child_account_id: str,
        child_api_key: str,
        scenario_id: int,
        scenario_script: str
    ) -> Dict[str, Any]:
        """
        Обновить код сценария на дочернем аккаунте.
        
        ✅ v2.2: Метод для массового обновления сценариев.
        Используется в admin_update_all_scenarios endpoint.
        
        Args:
            child_account_id: ID дочернего аккаунта
            child_api_key: API ключ дочернего аккаунта
            scenario_id: ID сценария для обновления
            scenario_script: Новый код сценария
            
        Returns:
            Dict с success и result/error
        """
        return await self.set_scenario_info(
            child_account_id=child_account_id,
            child_api_key=child_api_key,
            scenario_id=scenario_id,
            scenario_script=scenario_script
        )
    
    async def copy_scenarios_from_parent(
        self,
        child_account_id: str,
        child_api_key: str
    ) -> Dict[str, Any]:
        """
        Скопировать все сценарии с родительского аккаунта на дочерний.
        
        ✅ v1.8: ИСПРАВЛЕНО! Теперь для каждого сценария делается отдельный
        запрос с scenario_id, чтобы получить код сценария.
        
        Voximplant API quirk: при массовом запросе with_script=true
        НЕ возвращает scenario_script. Код возвращается только при
        запросе конкретного сценария по scenario_id.
        
        Возвращает маппинг {scenario_name: scenario_id} для сохранения в БД.
        """
        logger.info(f"[VOXIMPLANT] Copying scenarios from parent to child {child_account_id}")
        
        # =====================================================================
        # ШАГ 1: Получаем СПИСОК сценариев с родителя (БЕЗ кода)
        # =====================================================================
        parent_result = await self.get_parent_scenarios(with_script=False)
        
        if not parent_result.get("success"):
            return {"success": False, "error": "Failed to get parent scenarios"}
        
        parent_scenarios = parent_result.get("scenarios", [])
        
        if not parent_scenarios:
            logger.warning("[VOXIMPLANT] No scenarios found on parent account")
            return {"success": True, "scenario_ids": {}, "copied": 0}
        
        logger.info(f"[VOXIMPLANT] Found {len(parent_scenarios)} scenarios on parent account")
        
        scenario_ids = {}
        copied_count = 0
        errors = []
        
        # =====================================================================
        # ШАГ 2: Для КАЖДОГО сценария получаем код ОТДЕЛЬНЫМ запросом
        # =====================================================================
        for scenario in parent_scenarios:
            scenario_name = scenario.get("scenario_name")
            scenario_id = scenario.get("scenario_id")
            
            if not scenario_name or not scenario_id:
                logger.warning(f"[VOXIMPLANT] Skipping scenario without name or id")
                continue
            
            # Получаем код сценария отдельным запросом
            script_result = await self.get_scenario_with_script(
                account_id=self.parent_account_id,
                api_key=self.parent_api_key,
                scenario_id=scenario_id
            )
            
            if not script_result.get("success"):
                errors.append(f"{scenario_name}: не удалось получить код")
                logger.warning(f"[VOXIMPLANT] Failed to get script for {scenario_name}")
                continue
            
            scenario_script = script_result.get("scenario", {}).get("scenario_script")
            
            if not scenario_script:
                errors.append(f"{scenario_name}: код пустой")
                logger.warning(f"[VOXIMPLANT] Empty script for {scenario_name}")
                continue
            
            logger.info(f"[VOXIMPLANT] Got script for {scenario_name}: {len(scenario_script)} chars")
            
            # =====================================================================
            # ШАГ 3: Создаём сценарий на дочке
            # =====================================================================
            result = await self.add_scenario(
                child_account_id=child_account_id,
                child_api_key=child_api_key,
                scenario_name=scenario_name,
                scenario_script=scenario_script
            )
            
            if result.get("success"):
                scenario_ids[scenario_name] = result.get("scenario_id")
                copied_count += 1
                logger.info(f"[VOXIMPLANT] ✅ Copied {scenario_name}")
            else:
                errors.append(f"{scenario_name}: {result.get('error')}")
                logger.warning(f"[VOXIMPLANT] Failed to copy {scenario_name}: {result.get('error')}")
        
        logger.info(f"[VOXIMPLANT] ✅ Copied {copied_count}/{len(parent_scenarios)} scenarios")
        
        if errors:
            logger.warning(f"[VOXIMPLANT] Errors during copy: {errors}")
        
        return {
            "success": True,
            "scenario_ids": scenario_ids,
            "copied": copied_count,
            "total": len(parent_scenarios),
            "errors": errors if errors else None
        }
    
    # =========================================================================
    # ПРАВИЛА МАРШРУТИЗАЦИИ (RULES)
    # =========================================================================
    
    async def get_rules(
        self,
        child_account_id: str,
        child_api_key: str,
        application_id: str
    ) -> Dict[str, Any]:
        """Получить правила роутинга приложения"""
        url = f"{self.API_BASE_URL}/GetRules"
        params = {
            "account_id": child_account_id,
            "api_key": child_api_key,
            "application_id": application_id,
        }
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        return {"success": True, "rules": result.get("result", [])}
    
    async def add_rule(
        self,
        child_account_id: str,
        child_api_key: str,
        application_id: str,
        rule_name: str,
        rule_pattern: str,
        scenario_id: int
    ) -> Dict[str, Any]:
        """
        Создать правило маршрутизации.
        
        Args:
            application_id: ID приложения
            rule_name: Имя правила (например, 'inbound_74951234567')
            rule_pattern: Паттерн номера (например, '74951234567' или '.*')
            scenario_id: ID сценария для обработки
        """
        url = f"{self.API_BASE_URL}/AddRule"
        
        params = {
            "account_id": child_account_id,
            "api_key": child_api_key,
            "application_id": application_id,
            "rule_name": rule_name,
            "rule_pattern": rule_pattern,
            "scenario_id": scenario_id,
        }
        
        logger.info(f"[VOXIMPLANT] Creating rule '{rule_name}' (pattern: {rule_pattern}) for app {application_id}")
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            logger.error(f"[VOXIMPLANT] Failed to create rule: {result}")
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        rule_id = result.get("rule_id")
        logger.info(f"[VOXIMPLANT] ✅ Rule created: {rule_name} (ID: {rule_id})")
        
        return {
            "success": True,
            "rule_id": rule_id,
            "rule_name": rule_name,
        }
    
    async def set_rule_info(
        self,
        child_account_id: str,
        child_api_key: str,
        rule_id: str,
        scenario_id: Optional[int] = None,
        rule_name: Optional[str] = None,
        rule_pattern: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Обновить правило маршрутизации.
        
        Args:
            rule_id: ID правила для обновления
            scenario_id: Новый ID сценария (для смены обработчика)
            rule_name: Новое имя правила
            rule_pattern: Новый паттерн
        """
        url = f"{self.API_BASE_URL}/SetRuleInfo"
        
        params = {
            "account_id": child_account_id,
            "api_key": child_api_key,
            "rule_id": rule_id,
        }
        
        if scenario_id:
            params["scenario_id"] = scenario_id
        
        if rule_name:
            params["rule_name"] = rule_name
        
        if rule_pattern:
            params["rule_pattern"] = rule_pattern
        
        logger.info(f"[VOXIMPLANT] Updating rule {rule_id}")
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            logger.error(f"[VOXIMPLANT] Failed to update rule: {result}")
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        logger.info(f"[VOXIMPLANT] ✅ Rule updated: {rule_id}")
        
        return {"success": True, "result": result.get("result")}
    
    async def delete_rule(
        self,
        child_account_id: str,
        child_api_key: str,
        rule_id: str
    ) -> Dict[str, Any]:
        """Удалить правило маршрутизации."""
        url = f"{self.API_BASE_URL}/DelRule"
        
        params = {
            "account_id": child_account_id,
            "api_key": child_api_key,
            "rule_id": rule_id,
        }
        
        logger.info(f"[VOXIMPLANT] Deleting rule {rule_id}")
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            logger.error(f"[VOXIMPLANT] Failed to delete rule: {result}")
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        logger.info(f"[VOXIMPLANT] ✅ Rule deleted: {rule_id}")
        
        return {"success": True, "result": result.get("result")}
    
    # =========================================================================
    # 🆕 v3.0 + v3.1: ИСХОДЯЩИЕ ЗВОНКИ (OUTBOUND CALLS) С КОНТЕКСТОМ CRM
    # =========================================================================
    
    async def start_scenarios(
        self,
        child_account_id: str,
        child_api_key: str,
        rule_id: int,
        script_custom_data: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Запустить сценарий через Voximplant API.
        
        ✅ v3.0: Основной метод для запуска исходящих звонков.
        
        Args:
            child_account_id: ID дочернего аккаунта
            child_api_key: API ключ дочернего аккаунта  
            rule_id: ID правила (Rule), к которому привязан сценарий
            script_custom_data: JSON-строка с данными для сценария
                               (phone_number, assistant_id, caller_id, etc.)
        
        Returns:
            Dict с call_session_history_id и media_session_access_url
        """
        url = f"{self.API_BASE_URL}/StartScenarios"
        
        params = {
            "account_id": child_account_id,
            "api_key": child_api_key,
            "rule_id": rule_id,
        }
        
        if script_custom_data:
            params["script_custom_data"] = script_custom_data
        
        logger.info(f"[VOXIMPLANT] Starting scenario via rule {rule_id}")
        logger.info(f"[VOXIMPLANT] Custom data: {script_custom_data[:200] if script_custom_data else 'None'}...")
        
        client = await self._get_client()
        response = await client.post(url, data=params)
        result = response.json()
        
        if "error" in result:
            logger.error(f"[VOXIMPLANT] Failed to start scenario: {result}")
            return {"success": False, "error": result.get("error", {}).get("msg", "Unknown error")}
        
        call_session_id = result.get("call_session_history_id")
        media_url = result.get("media_session_access_url")
        
        logger.info(f"[VOXIMPLANT] ✅ Scenario started: session={call_session_id}")
        
        return {
            "success": True,
            "call_session_history_id": call_session_id,
            "media_session_access_url": media_url,
            "result": result.get("result", 1)
        }
    
    async def start_outbound_call(
        self,
        child_account_id: str,
        child_api_key: str,
        rule_id: int,
        phone_number: str,
        assistant_id: str,
        caller_id: str,
        first_phrase: Optional[str] = None,
        mute_duration_ms: int = 3000,
        # ✅ v3.1: Новые параметры для CRM контекста
        contact_name: Optional[str] = None,
        task_title: Optional[str] = None,
        task_description: Optional[str] = None,
        custom_greeting: Optional[str] = None,
        timezone: str = "Europe/Moscow"
    ) -> Dict[str, Any]:
        """
        🆕 v3.0 + v3.1: Запустить исходящий звонок с полным контекстом CRM.
        
        Формирует script_custom_data и вызывает StartScenarios API.
        
        Args:
            child_account_id: ID дочернего аккаунта
            child_api_key: API ключ
            rule_id: ID правила для outbound сценария
            phone_number: Номер телефона для звонка (target)
            assistant_id: UUID ассистента
            caller_id: Номер, с которого звоним (Caller ID)
            first_phrase: Первая фраза (опционально, устаревший параметр)
            mute_duration_ms: Время мьюта микрофона клиента (мс)
            
            # ✅ v3.1: CRM контекст
            contact_name: Имя контакта (для персонализации)
            task_title: Название задачи
            task_description: Описание задачи (контекст для ассистента)
            custom_greeting: Персонализированное приветствие из задачи
            timezone: Часовой пояс (по умолчанию Europe/Moscow)
            
        Returns:
            Dict с результатом запуска звонка
        """
        # Формируем данные для сценария
        custom_data = {
            "phone_number": phone_number,
            "assistant_id": assistant_id,
            "caller_id": caller_id,
            "mute_duration_ms": mute_duration_ms,
            # ✅ v3.1: CRM контекст
            "contact_name": contact_name or "",
            "task_title": task_title or "",
            "task_description": task_description or "",
            "custom_greeting": custom_greeting or "",
            "timezone": timezone,
        }
        
        # Для обратной совместимости: first_phrase как fallback для custom_greeting
        if first_phrase and not custom_greeting:
            custom_data["custom_greeting"] = first_phrase
        
        script_custom_data = json.dumps(custom_data, ensure_ascii=False)
        
        logger.info(f"[VOXIMPLANT] 📞 Starting outbound call:")
        logger.info(f"[VOXIMPLANT]    Target: {phone_number}")
        logger.info(f"[VOXIMPLANT]    Caller ID: {caller_id}")
        logger.info(f"[VOXIMPLANT]    Assistant: {assistant_id}")
        logger.info(f"[VOXIMPLANT]    Rule ID: {rule_id}")
        if contact_name:
            logger.info(f"[VOXIMPLANT]    👤 Contact: {contact_name}")
        if task_title:
            logger.info(f"[VOXIMPLANT]    📋 Task: {task_title}")
        if task_description:
            logger.info(f"[VOXIMPLANT]    📝 Description: {task_description[:80]}...")
        if custom_greeting:
            logger.info(f"[VOXIMPLANT]    💬 Custom Greeting: {custom_greeting[:80]}...")
        logger.info(f"[VOXIMPLANT]    🌍 Timezone: {timezone}")
        
        result = await self.start_scenarios(
            child_account_id=child_account_id,
            child_api_key=child_api_key,
            rule_id=rule_id,
            script_custom_data=script_custom_data
        )
        
        if result.get("success"):
            logger.info(f"[VOXIMPLANT] ✅ Outbound call started to {phone_number}")
        else:
            logger.error(f"[VOXIMPLANT] ❌ Failed to start outbound call: {result.get('error')}")
        
        return result
    
    async def setup_outbound_rules(
        self,
        child_account_id: str,
        child_api_key: str,
        application_id: str,
        scenario_ids: Dict[str, int]
    ) -> Dict[str, Any]:
        """
        🆕 v3.0: Создать Rules для исходящих сценариев.
        
        Используется для:
        - Новых аккаунтов (вызывается из setup_child_account_scenarios)
        - Существующих аккаунтов (миграция через admin endpoint)
        
        Args:
            child_account_id: ID дочернего аккаунта
            child_api_key: API ключ
            application_id: ID приложения
            scenario_ids: Маппинг {scenario_name: scenario_id}
            
        Returns:
            Dict с rule_ids: {"outbound_openai": 123, "outbound_gemini": 124}
        """
        logger.info(f"[VOXIMPLANT] Setting up outbound rules for account {child_account_id}")
        
        rule_ids = {}
        errors = []
        
        for scenario_type in self.OUTBOUND_SCENARIO_TYPES:
            scenario_id = scenario_ids.get(scenario_type)
            
            if not scenario_id:
                logger.warning(f"[VOXIMPLANT] Scenario '{scenario_type}' not found, skipping rule creation")
                continue
            
            # Создаём Rule для этого outbound сценария
            # Pattern не важен для outbound - он не используется
            rule_result = await self.add_rule(
                child_account_id=child_account_id,
                child_api_key=child_api_key,
                application_id=application_id,
                rule_name=scenario_type,
                rule_pattern=scenario_type,  # Любой уникальный pattern
                scenario_id=scenario_id
            )
            
            if rule_result.get("success"):
                rule_ids[scenario_type] = rule_result.get("rule_id")
                logger.info(f"[VOXIMPLANT] ✅ Created rule for {scenario_type}: {rule_ids[scenario_type]}")
            else:
                error_msg = f"{scenario_type}: {rule_result.get('error')}"
                errors.append(error_msg)
                logger.error(f"[VOXIMPLANT] ❌ Failed to create rule for {scenario_type}: {rule_result.get('error')}")
        
        logger.info(f"[VOXIMPLANT] Outbound rules setup complete: {len(rule_ids)} created, {len(errors)} failed")
        
        return {
            "success": len(rule_ids) > 0,
            "rule_ids": rule_ids,
            "created": len(rule_ids),
            "errors": errors if errors else None
        }
    
    # =========================================================================
    # КОМПЛЕКСНАЯ НАСТРОЙКА ДОЧЕРНЕГО АККАУНТА
    # =========================================================================
    
    async def setup_child_account_scenarios(
        self,
        child_account_id: str,
        child_api_key: str,
        application_name: str = "voicyfy"
    ) -> Dict[str, Any]:
        """
        Комплексная настройка сценариев для дочернего аккаунта.
        
        ✅ v3.0: Теперь создаёт Rules для OUTBOUND сценариев!
        
        1. Создаёт приложение
        2. Копирует сценарии с родителя (inbound + outbound)
        3. 🆕 Создаёт Rules для outbound сценариев
        4. Возвращает application_id, scenario_ids и rule_ids для сохранения в БД
        
        Вызывается при setup_telephony после создания аккаунта.
        """
        logger.info(f"[VOXIMPLANT] Setting up scenarios for child account {child_account_id}")
        
        # =====================================================================
        # ШАГ 1: Создаём приложение
        # =====================================================================
        app_result = await self.add_application(
            child_account_id=child_account_id,
            child_api_key=child_api_key,
            application_name=application_name
        )
        
        if not app_result.get("success"):
            return {"success": False, "error": f"Failed to create application: {app_result.get('error')}"}
        
        application_id = app_result.get("application_id")
        
        # =====================================================================
        # ШАГ 2: Копируем сценарии (теперь с правильной логикой!)
        # =====================================================================
        copy_result = await self.copy_scenarios_from_parent(
            child_account_id=child_account_id,
            child_api_key=child_api_key
        )
        
        if not copy_result.get("success"):
            return {"success": False, "error": f"Failed to copy scenarios: {copy_result.get('error')}"}
        
        scenario_ids = copy_result.get("scenario_ids", {})
        
        # =====================================================================
        # 🆕 ШАГ 3: Создаём Rules для OUTBOUND сценариев
        # =====================================================================
        rule_ids = {}
        outbound_errors = []
        
        outbound_result = await self.setup_outbound_rules(
            child_account_id=child_account_id,
            child_api_key=child_api_key,
            application_id=str(application_id),
            scenario_ids=scenario_ids
        )
        
        if outbound_result.get("success"):
            rule_ids = outbound_result.get("rule_ids", {})
            logger.info(f"[VOXIMPLANT] ✅ Outbound rules created: {list(rule_ids.keys())}")
        else:
            outbound_errors = outbound_result.get("errors", [])
            logger.warning(f"[VOXIMPLANT] ⚠️ Some outbound rules failed: {outbound_errors}")
        
        # =====================================================================
        # ШАГ 4: Формируем результат
        # =====================================================================
        all_errors = copy_result.get("errors", []) or []
        if outbound_errors:
            all_errors.extend(outbound_errors)
        
        logger.info(f"[VOXIMPLANT] ✅ Child account setup complete:")
        logger.info(f"[VOXIMPLANT]    Application: {application_id}")
        logger.info(f"[VOXIMPLANT]    Scenarios: {list(scenario_ids.keys())}")
        logger.info(f"[VOXIMPLANT]    Outbound Rules: {list(rule_ids.keys())}")
        
        return {
            "success": True,
            "application_id": application_id,
            "application_name": application_name,
            "scenario_ids": scenario_ids,
            "rule_ids": rule_ids,  # 🆕 v3.0
            "scenarios_copied": copy_result.get("copied", 0),
            "scenarios_total": copy_result.get("total", 0),
            "outbound_rules_created": len(rule_ids),  # 🆕 v3.0
            "errors": all_errors if all_errors else None,
        }


# =============================================================================
# SINGLETON
# =============================================================================

_service_instance: Optional[VoximplantPartnerService] = None


def get_voximplant_partner_service() -> VoximplantPartnerService:
    """Получить экземпляр сервиса Voximplant Partner."""
    global _service_instance
    
    if _service_instance is None:
        _service_instance = VoximplantPartnerService()
    
    return _service_instance

# backend/services/payment_service.py

"""
Payment service for WellcomeAI application.
Handles Robokassa integration for subscription payments.
"""

import hashlib
import hmac
import base64
import json
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, Optional
from urllib.parse import urlencode, quote
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from backend.core.logging import get_logger
from backend.core.config import settings
from backend.models.user import User
from backend.models.subscription import SubscriptionPlan
from backend.services.subscription_service import SubscriptionService

logger = get_logger(__name__)

class RobokassaService:
    """Service for Robokassa payment integration"""
    
    # Robokassa настройки из конфигурации
    MERCHANT_LOGIN = settings.ROBOKASSA_MERCHANT_LOGIN
    PASSWORD_1 = settings.ROBOKASSA_PASSWORD_1
    PASSWORD_2 = settings.ROBOKASSA_PASSWORD_2
    
    # URLs для обработки
    BASE_URL = settings.HOST_URL
    RESULT_URL = f"{BASE_URL}/api/payments/robokassa-result"
    SUCCESS_URL = f"{BASE_URL}/api/payments/success"
    FAIL_URL = f"{BASE_URL}/api/payments/cancel"
    
    # Robokassa URLs
    PAYMENT_URL = "https://auth.robokassa.ru/Merchant/Index.aspx"
    TEST_MODE = settings.ROBOKASSA_TEST_MODE
    
    @staticmethod
    def generate_signature(
        merchant_login: str,
        out_sum: str,
        inv_id: str,
        password: str,
        receipt: Optional[str] = None,
        custom_params: Optional[Dict[str, str]] = None
    ) -> str:
        """
        Генерация подписи для Robokassa
        
        Args:
            merchant_login: Идентификатор магазина
            out_sum: Сумма платежа
            inv_id: Номер счета
            password: Пароль для подписи
            receipt: Данные чека (необязательно)
            custom_params: Дополнительные параметры (необязательно)
            
        Returns:
            Подпись MD5
        """
        # Базовая строка для подписи: MerchantLogin:OutSum:InvId:Password
        sign_string = f"{merchant_login}:{out_sum}:{inv_id}"
        
        # Добавляем чек если есть
        if receipt:
            sign_string += f":{receipt}"
            
        sign_string += f":{password}"
        
        # Добавляем пользовательские параметры в алфавитном порядке
        if custom_params:
            sorted_params = sorted(custom_params.items())
            for key, value in sorted_params:
                sign_string += f":{key}={value}"
        
        logger.debug(f"Signature string: {sign_string}")
        
        # Генерируем MD5 хеш
        signature = hashlib.md5(sign_string.encode('utf-8')).hexdigest().upper()
        
        return signature
    
    @staticmethod
    def verify_result_signature(
        out_sum: str,
        inv_id: str,
        password: str,
        received_signature: str,
        custom_params: Optional[Dict[str, str]] = None
    ) -> bool:
        """
        Проверка подписи в уведомлении от Robokassa
        
        Args:
            out_sum: Сумма платежа
            inv_id: Номер счета  
            password: Пароль #2
            received_signature: Полученная подпись
            custom_params: Дополнительные параметры
            
        Returns:
            True если подпись корректна
        """
        # Базовая строка: OutSum:InvId:Password2
        sign_string = f"{out_sum}:{inv_id}:{password}"
        
        # Добавляем пользовательские параметры в алфавитном порядке
        if custom_params:
            sorted_params = sorted(custom_params.items())
            for key, value in sorted_params:
                sign_string += f":{key}={value}"
        
        logger.debug(f"Verification string: {sign_string}")
        
        # Генерируем подпись
        expected_signature = hashlib.md5(sign_string.encode('utf-8')).hexdigest().upper()
        
        # Сравниваем подписи
        is_valid = expected_signature == received_signature.upper()
        
        if not is_valid:
            logger.error(f"Signature mismatch. Expected: {expected_signature}, Received: {received_signature}")
        
        return is_valid
    
    @staticmethod
    def create_receipt(description: str, amount: float) -> str:
        """
        Создание чека для фискализации
        
        Args:
            description: Описание товара/услуги
            amount: Сумма
            
        Returns:
            JSON строка чека в URL encode
        """
        receipt = {
            "items": [
                {
                    "name": description,
                    "quantity": 1,
                    "sum": amount,
                    "tax": "none"  # Без НДС
                }
            ]
        }
        
        # Конвертируем в JSON и кодируем для URL
        receipt_json = json.dumps(receipt, ensure_ascii=False)
        receipt_encoded = quote(receipt_json)
        
        return receipt_encoded
    
    @classmethod
    async def create_payment(
        cls,
        db: Session,
        user_id: str,
        plan_code: str = "start"
    ) -> Dict[str, Any]:
        """
        Создание платежа для подписки
        
        Args:
            db: Сессия базы данных
            user_id: ID пользователя
            plan_code: Код тарифного плана
            
        Returns:
            Данные для перенаправления на оплату
        """
        try:
            # Получаем пользователя
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="User not found"
                )
            
            # Получаем план подписки
            plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == plan_code).first()
            if not plan and plan_code == "start":
                # Создаем план "start" если его нет
                plan = SubscriptionPlan(
                    code="start",
                    name="Тариф Старт",
                    price=1490.0,
                    max_assistants=3,
                    description="Полный доступ к платформе на 30 дней",
                    is_active=True
                )
                db.add(plan)
                db.flush()
            elif not plan:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Plan {plan_code} not found"
                )
            
            # Параметры платежа
            out_sum = f"{settings.SUBSCRIPTION_PRICE:.2f}"  # Сумма из настроек
            inv_id = f"{user_id}_{int(datetime.now().timestamp())}"  # Уникальный номер счета
            description = f"Подписка {plan.name} на {settings.SUBSCRIPTION_DURATION_DAYS} дней"
            
            # Создаем чек для фискализации
            receipt = cls.create_receipt(description, float(out_sum))
            
            # Дополнительные параметры
            custom_params = {
                "Shp_user_id": user_id,
                "Shp_plan_code": plan_code
            }
            
            # Генерируем подпись
            signature = cls.generate_signature(
                cls.MERCHANT_LOGIN,
                out_sum,
                inv_id,
                cls.PASSWORD_1,
                receipt,
                custom_params
            )
            
            # Формируем параметры для формы
            form_params = {
                "MerchantLogin": cls.MERCHANT_LOGIN,
                "OutSum": out_sum,
                "InvId": inv_id,
                "Description": description,
                "SignatureValue": signature,
                "Receipt": receipt,
                "ResultURL": cls.RESULT_URL,
                "SuccessURL": cls.SUCCESS_URL,
                "FailURL": cls.FAIL_URL,
                "Culture": "ru",
                "Encoding": "utf-8",
                "Email": user.email,
                "IsTest": "1" if cls.TEST_MODE else "0",
                **{f"Shp_{k.lower().split('_', 1)[1]}": v for k, v in custom_params.items()}
            }
            
            logger.info(f"Creating payment for user {user_id}, plan {plan_code}, amount {out_sum}")
            
            return {
                "payment_url": cls.PAYMENT_URL,
                "form_params": form_params,
                "inv_id": inv_id,
                "amount": out_sum
            }
            
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error creating payment: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create payment"
            )
    
    @classmethod
    async def process_payment_result(
        cls,
        db: Session,
        form_data: Dict[str, Any]
    ) -> str:
        """
        Обработка уведомления о результате платежа от Robokassa
        
        Args:
            db: Сессия базы данных
            form_data: Данные формы от Robokassa
            
        Returns:
            Ответ для Robokassa (OK{InvId} или FAIL)
        """
        try:
            # Извлекаем параметры
            out_sum = form_data.get("OutSum", "")
            inv_id = form_data.get("InvId", "")
            signature_value = form_data.get("SignatureValue", "")
            
            # Извлекаем пользовательские параметры
            custom_params = {}
            for key, value in form_data.items():
                if key.startswith("Shp_"):
                    param_key = key[4:]  # Убираем "Shp_"
                    custom_params[f"Shp_{param_key}"] = value
            
            logger.info(f"Processing payment result for InvId: {inv_id}, OutSum: {out_sum}")
            
            # Проверяем подпись
            is_valid = cls.verify_result_signature(
                out_sum,
                inv_id,
                cls.PASSWORD_2,
                signature_value,
                custom_params
            )
            
            if not is_valid:
                logger.error(f"Invalid signature for payment {inv_id}")
                return "FAIL"
            
            # Извлекаем пользовательские данные
            user_id = custom_params.get("Shp_user_id")
            plan_code = custom_params.get("Shp_plan_code", "start")
            
            if not user_id:
                logger.error(f"Missing user_id in payment {inv_id}")
                return "FAIL"
            
            # Получаем пользователя
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                logger.error(f"User {user_id} not found for payment {inv_id}")
                return "FAIL"
            
            # Получаем план
            plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == plan_code).first()
            if not plan:
                logger.error(f"Plan {plan_code} not found for payment {inv_id}")
                return "FAIL"
            
            # Обновляем подписку пользователя
            now = datetime.now(timezone.utc)
            
            # Если у пользователя уже есть активная подписка, продлеваем от её окончания
            start_date = now
            if user.subscription_end_date and user.subscription_end_date > now:
                start_date = user.subscription_end_date
            
            user.subscription_start_date = start_date
            user.subscription_end_date = start_date + timedelta(days=settings.SUBSCRIPTION_DURATION_DAYS)
            user.subscription_plan_id = plan.id
            user.is_trial = False
            
            db.commit()
            
            # Логируем событие через SubscriptionService
            await SubscriptionService.log_subscription_event(
                db=db,
                user_id=user_id,
                action="payment_success",
                plan_id=str(plan.id),
                plan_code=plan_code,
                details=f"Payment processed successfully. InvId: {inv_id}, Amount: {out_sum}"
            )
            
            logger.info(f"Payment {inv_id} processed successfully for user {user_id}")
            
            return f"OK{inv_id}"
            
        except Exception as e:
            logger.error(f"Error processing payment result: {str(e)}")
            return "FAIL"
    
    @staticmethod
    def get_payment_status_message(success: bool = True) -> Dict[str, Any]:
        """
        Получение сообщения о статусе платежа для пользователя
        
        Args:
            success: Успешность платежа
            
        Returns:
            Данные для отображения пользователю
        """
        if success:
            return {
                "success": True,
                "title": "Оплата прошла успешно!",
                "message": "Ваша подписка активирована. Теперь вы можете пользоваться всеми функциями платформы.",
                "redirect_url": "/static/dashboard.html"
            }
        else:
            return {
                "success": False,
                "title": "Оплата отменена",
                "message": "Платеж не был завершен. Вы можете попробовать еще раз.",
                "redirect_url": "/static/dashboard.html"
            }

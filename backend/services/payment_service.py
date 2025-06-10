# backend/services/payment_service.py

"""
ИСПРАВЛЕННЫЙ Payment service - устранена ошибка 500 Robokassa
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
from backend.models.subscription import SubscriptionPlan, PaymentTransaction
from backend.services.subscription_service import SubscriptionService

logger = get_logger(__name__)

class RobokassaService:
    """Service for Robokassa integration - ИСПРАВЛЕННАЯ ВЕРСИЯ без ошибки 500"""
    
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
    
    # Константы для подписки
    DEFAULT_SUBSCRIPTION_PRICE = 1490.0
    DEFAULT_SUBSCRIPTION_DURATION_DAYS = 30
    
    @staticmethod
    def generate_signature(
        merchant_login: str,
        out_sum: str,
        inv_id: str,
        password: str,
        custom_params: Optional[Dict[str, str]] = None
    ) -> str:
        """
        ✅ ИСПРАВЛЕНО: Генерация подписи БЕЗ Receipt согласно документации
        """
        try:
            # Базовая строка для подписи: MerchantLogin:OutSum:InvId:Password
            sign_string = f"{merchant_login}:{out_sum}:{inv_id}:{password}"
            
            # Добавляем пользовательские параметры в алфавитном порядке
            if custom_params:
                sorted_params = sorted(custom_params.items())
                for key, value in sorted_params:
                    sign_string += f":{key}={value}"
            
            logger.info(f"🔐 Signature string: {sign_string}")
            
            # Генерируем MD5 хеш
            signature = hashlib.md5(sign_string.encode('utf-8')).hexdigest().upper()
            
            logger.info(f"✅ Generated signature: {signature}")
            return signature
            
        except Exception as e:
            logger.error(f"❌ Error generating signature: {str(e)}")
            raise
    
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
        """
        try:
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
            
        except Exception as e:
            logger.error(f"Error verifying signature: {str(e)}")
            return False
    
    @classmethod
    async def create_payment(
        cls,
        db: Session,
        user_id: str,
        plan_code: str = "start"
    ) -> Dict[str, Any]:
        """
        ✅ ИСПРАВЛЕННАЯ версия создания платежа БЕЗ ошибки 500
        """
        try:
            logger.info(f"🚀 Creating Robokassa payment for user {user_id}, plan {plan_code}")
            
            # Проверяем настройки Robokassa
            if not cls.MERCHANT_LOGIN:
                logger.error("❌ ROBOKASSA_MERCHANT_LOGIN not configured")
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Payment system not configured: missing merchant login"
                )
                
            if not cls.PASSWORD_1:
                logger.error("❌ ROBOKASSA_PASSWORD_1 not configured")
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Payment system not configured: missing password"
                )
            
            # Логируем режим работы
            if cls.TEST_MODE:
                logger.warning("⚠️ ROBOKASSA TEST MODE IS ENABLED")
            else:
                logger.info("🎯 ROBOKASSA PRODUCTION MODE")
            
            # Получаем пользователя
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                logger.error(f"❌ User {user_id} not found")
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="User not found"
                )
            
            # Получаем план из таблицы subscription_plans
            plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == plan_code).first()
            if not plan:
                logger.info(f"📋 Creating new subscription plan: {plan_code}")
                # Создаем план, если его нет
                plan_data = {
                    "free": {"name": "Free Trial", "price": 0, "max_assistants": 1},
                    "start": {"name": "Тариф Старт", "price": 1490, "max_assistants": 3},
                    "pro": {"name": "Тариф Про", "price": 4990, "max_assistants": 10}
                }
                
                if plan_code in plan_data:
                    plan = SubscriptionPlan(
                        code=plan_code,
                        name=plan_data[plan_code]["name"],
                        price=plan_data[plan_code]["price"],
                        max_assistants=plan_data[plan_code]["max_assistants"],
                        description=f"План подписки {plan_data[plan_code]['name']}",
                        is_active=True
                    )
                    db.add(plan)
                    db.flush()
                    logger.info(f"✅ Created subscription plan: {plan_code}")
                else:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Unknown plan code: {plan_code}"
                    )
            
            # Параметры платежа
            out_sum = f"{float(plan.price):.2f}"
            inv_id = f"{user_id}_{int(datetime.now().timestamp())}"
            description = f"{plan.name} - подписка на {cls.DEFAULT_SUBSCRIPTION_DURATION_DAYS} дней"
            
            logger.info(f"💳 Payment details:")
            logger.info(f"   amount: {out_sum}")
            logger.info(f"   inv_id: {inv_id}")
            logger.info(f"   plan: {plan.name}")
            logger.info(f"   merchant: {cls.MERCHANT_LOGIN}")
            
            # Создаем запись транзакции
            transaction = PaymentTransaction(
                user_id=user.id,
                plan_id=plan.id,
                external_payment_id=inv_id,
                payment_system="robokassa",
                amount=plan.price,
                currency="RUB",
                status="pending",
                payment_details=f"Plan: {plan_code}, Description: {description}"
            )
            db.add(transaction)
            db.commit()
            db.refresh(transaction)
            
            logger.info(f"📋 Created payment transaction: {transaction.id}")
            
            # Логируем начало процесса оплаты
            await SubscriptionService.log_subscription_event(
                db=db,
                user_id=user_id,
                action="payment_started",
                plan_id=str(plan.id),
                plan_code=plan_code,
                details=f"Payment initiated: amount={out_sum}, inv_id={inv_id}"
            )
            
            # ✅ ИСПРАВЛЕНО: Убираем Receipt, который может вызывать ошибку 500
            # Receipt часто является причиной ошибок в Robokassa
            
            # Дополнительные параметры (сокращаем для минимизации ошибок)
            custom_params = {
                "Shp_user_id": user_id,
                "Shp_plan_code": plan_code
            }
            
            # ✅ ИСПРАВЛЕНО: Генерируем подпись БЕЗ Receipt
            try:
                signature = cls.generate_signature(
                    cls.MERCHANT_LOGIN,
                    out_sum,
                    inv_id,
                    cls.PASSWORD_1,
                    custom_params
                )
            except Exception as e:
                logger.error(f"❌ Error generating signature: {str(e)}")
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Error generating payment signature"
                )
            
            # ✅ ИСПРАВЛЕНО: Минимальный набор параметров для избежания ошибок
            form_params = {
                "MerchantLogin": cls.MERCHANT_LOGIN,
                "OutSum": out_sum,
                "InvId": inv_id,
                "Description": description,
                "SignatureValue": signature,
                "Culture": "ru",
                "Encoding": "utf-8"
            }
            
            # Добавляем URL'ы для обработки
            if cls.RESULT_URL:
                form_params["ResultURL"] = cls.RESULT_URL
            if cls.SUCCESS_URL:
                form_params["SuccessURL"] = cls.SUCCESS_URL  
            if cls.FAIL_URL:
                form_params["FailURL"] = cls.FAIL_URL
            
            # Добавляем email пользователя
            if user.email:
                form_params["Email"] = user.email
            
            # Добавляем тестовый режим
            if cls.TEST_MODE:
                form_params["IsTest"] = "1"
                logger.info("🧪 Test mode parameter added")
            
            # Добавляем пользовательские параметры
            for key, value in custom_params.items():
                form_params[key] = value
            
            # Детальное логирование параметров
            logger.info(f"📋 Final form parameters:")
            for key, value in form_params.items():
                if key == "SignatureValue":
                    logger.info(f"   {key}: {value[:10]}...")
                else:
                    logger.info(f"   {key}: {value}")
            
            logger.info(f"✅ Payment created successfully: {inv_id}")
            logger.info(f"🌐 Redirecting to: {cls.PAYMENT_URL}")
            
            return {
                "payment_url": cls.PAYMENT_URL,
                "form_params": form_params,
                "inv_id": inv_id,
                "amount": out_sum,
                "transaction_id": str(transaction.id)
            }
            
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"❌ Error creating Robokassa payment: {str(e)}", exc_info=True)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to create payment: {str(e)}"
            )
    
    @classmethod
    async def process_payment_result(
        cls,
        db: Session,
        form_data: Dict[str, Any]
    ) -> str:
        """
        Обработка уведомления от Robokassa
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
                    custom_params[key] = value
            
            logger.info(f"📥 Processing payment result for InvId: {inv_id}, OutSum: {out_sum}")
            
            # Проверяем подпись
            is_valid = cls.verify_result_signature(
                out_sum,
                inv_id,
                cls.PASSWORD_2,
                signature_value,
                custom_params
            )
            
            if not is_valid:
                logger.error(f"❌ Invalid signature for payment {inv_id}")
                return "FAIL"
            
            # Извлекаем пользовательские данные
            user_id = custom_params.get("Shp_user_id")
            plan_code = custom_params.get("Shp_plan_code", "start")
            
            if not user_id:
                logger.error(f"❌ Missing user_id in payment {inv_id}")
                return "FAIL"
            
            # Получаем пользователя
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                logger.error(f"❌ User {user_id} not found for payment {inv_id}")
                return "FAIL"
            
            # Получаем план
            plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == plan_code).first()
            if not plan:
                logger.error(f"❌ Plan {plan_code} not found for payment {inv_id}")
                return "FAIL"
            
            # Обновляем подписку пользователя
            now = datetime.now(timezone.utc)
            
            # Если у пользователя уже есть активная подписка, продлеваем от её окончания
            start_date = now
            if user.subscription_end_date and user.subscription_end_date > now:
                start_date = user.subscription_end_date
            
            duration_days = getattr(settings, 'SUBSCRIPTION_DURATION_DAYS', cls.DEFAULT_SUBSCRIPTION_DURATION_DAYS)
            user.subscription_start_date = start_date
            user.subscription_end_date = start_date + timedelta(days=duration_days)
            user.subscription_plan_id = plan.id
            user.is_trial = False  # Больше не триал
            
            db.commit()
            
            # Логируем успешную оплату
            await SubscriptionService.log_subscription_event(
                db=db,
                user_id=user_id,
                action="payment_success",
                plan_id=str(plan.id),
                plan_code=plan_code,
                details=f"Payment processed successfully. InvId: {inv_id}, Amount: {out_sum}, Subscription until: {user.subscription_end_date.strftime('%Y-%m-%d')}"
            )
            
            logger.info(f"✅ Payment {inv_id} processed successfully for user {user_id}")
            
            return f"OK{inv_id}"
            
        except Exception as e:
            logger.error(f"❌ Error processing payment result: {str(e)}")
            return "FAIL"
    
    @staticmethod
    def get_payment_status_message(success: bool = True) -> Dict[str, Any]:
        """
        Получение сообщения о статусе платежа для пользователя
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

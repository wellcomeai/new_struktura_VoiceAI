# backend/services/payment_service.py

"""
ИСПРАВЛЕННЫЙ Payment service - устранены все проблемы с Robokassa
ВЕРСИЯ С ПРАВИЛЬНОЙ ГЕНЕРАЦИЕЙ ПОДПИСИ И ДЕТАЛЬНЫМ ЛОГИРОВАНИЕМ
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
    """Service for Robokassa integration - ИСПРАВЛЕННАЯ ВЕРСИЯ"""
    
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
        ✅ ИСПРАВЛЕННАЯ генерация подписи согласно документации Robokassa
        Формула для инициализации платежа: MerchantLogin:OutSum:InvId:Password1[:Shp_item=value]
        """
        try:
            # ✅ ПРАВИЛЬНАЯ базовая строка: MerchantLogin:OutSum:InvId:Password
            sign_string = f"{merchant_login}:{out_sum}:{inv_id}:{password}"
            
            logger.info(f"🔐 SIGNATURE GENERATION:")
            logger.info(f"   merchant_login: '{merchant_login}'")
            logger.info(f"   out_sum: '{out_sum}'")
            logger.info(f"   inv_id: '{inv_id}'")
            logger.info(f"   password: '[HIDDEN]' (length: {len(password)})")
            logger.info(f"   base_string: '{sign_string}'")
            
            # ✅ ИСПРАВЛЕНО: Добавляем пользовательские параметры в АЛФАВИТНОМ порядке
            if custom_params:
                # Сортируем параметры по ключам в алфавитном порядке
                sorted_params = sorted(custom_params.items())
                logger.info(f"   custom_params (sorted): {sorted_params}")
                
                for key, value in sorted_params:
                    # ✅ ВАЖНО: При генерации подписи НЕ убираем префикс Shp_
                    param_string = f"{key}={value}"
                    sign_string += f":{param_string}"
                    logger.info(f"   added param: '{param_string}'")
            
            logger.info(f"🔐 Final signature string: '{sign_string}'")
            
            # Генерируем MD5 хеш
            signature = hashlib.md5(sign_string.encode('utf-8')).hexdigest().upper()
            
            logger.info(f"✅ Generated signature: '{signature}'")
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
        ✅ ИСПРАВЛЕННАЯ проверка подписи в уведомлении от Robokassa
        Формула для ResultURL: OutSum:InvId:Password2[:Shp_item=value]
        """
        try:
            # ✅ ПРАВИЛЬНАЯ базовая строка для ResultURL: OutSum:InvId:Password2
            sign_string = f"{out_sum}:{inv_id}:{password}"
            
            logger.info(f"🔍 VERIFYING RESULT SIGNATURE:")
            logger.info(f"   out_sum: '{out_sum}'")
            logger.info(f"   inv_id: '{inv_id}'")
            logger.info(f"   password2: '[HIDDEN]' (length: {len(password)})")
            logger.info(f"   received_signature: '{received_signature}'")
            logger.info(f"   custom_params: {custom_params}")
            
            # ✅ ИСПРАВЛЕНО: Добавляем пользовательские параметры в алфавитном порядке
            if custom_params:
                sorted_params = sorted(custom_params.items())
                for key, value in sorted_params:
                    # ✅ ВАЖНО: При проверке подписи НЕ убираем префикс Shp_
                    param_string = f"{key}={value}"
                    sign_string += f":{param_string}"
                    logger.info(f"   added verification param: '{param_string}'")
            
            logger.info(f"🔍 Verification string: '{sign_string}'")
            
            # Генерируем подпись
            expected_signature = hashlib.md5(sign_string.encode('utf-8')).hexdigest().upper()
            
            logger.info(f"🔍 Expected signature: '{expected_signature}'")
            logger.info(f"🔍 Received signature: '{received_signature.upper()}'")
            
            # Сравниваем подписи
            is_valid = expected_signature == received_signature.upper()
            
            if not is_valid:
                logger.error(f"❌ Signature mismatch!")
                logger.error(f"   Expected: {expected_signature}")
                logger.error(f"   Received: {received_signature}")
            else:
                logger.info(f"✅ Signature is valid")
            
            return is_valid
            
        except Exception as e:
            logger.error(f"❌ Error verifying signature: {str(e)}")
            return False
    
    @classmethod
    async def create_payment(
        cls,
        db: Session,
        user_id: str,
        plan_code: str = "start"
    ) -> Dict[str, Any]:
        """
        ✅ ИСПРАВЛЕННАЯ версия создания платежа с правильной подписью
        """
        try:
            logger.info(f"🚀 Creating Robokassa payment for user {user_id}, plan {plan_code}")
            
            # ✅ КРИТИЧЕСКИЕ ПРОВЕРКИ НАСТРОЕК
            if not cls.BASE_URL or "localhost" in cls.BASE_URL or "127.0.0.1" in cls.BASE_URL:
                logger.error("❌ HOST_URL contains localhost or is invalid!")
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="HOST_URL cannot be localhost for Robokassa. Please use public domain."
                )
            
            if not cls.MERCHANT_LOGIN or cls.MERCHANT_LOGIN == "demo":
                logger.error("❌ Invalid MERCHANT_LOGIN")
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="ROBOKASSA_MERCHANT_LOGIN must be configured with real merchant login"
                )
                
            if not cls.PASSWORD_1 or cls.PASSWORD_1 in ["password_1", "demo"]:
                logger.error("❌ Invalid PASSWORD_1")
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="ROBOKASSA_PASSWORD_1 must be configured with real password"
                )
                
            if not cls.PASSWORD_2 or cls.PASSWORD_2 in ["password_2", "demo"]:
                logger.error("❌ Invalid PASSWORD_2")
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="ROBOKASSA_PASSWORD_2 must be configured with real password"
                )
            
            # Получаем пользователя
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                logger.error(f"❌ User {user_id} not found")
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="User not found"
                )
            
            # Получаем план
            plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == plan_code).first()
            if not plan:
                logger.info(f"📋 Creating new subscription plan: {plan_code}")
                plan_data = {
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
            
            # ✅ ИСПРАВЛЕНО: Правильные параметры платежа
            out_sum = f"{float(plan.price):.2f}"  # Важно: формат X.XX
            inv_id = f"{int(datetime.now().timestamp())}"  # Простой числовой ID
            description = f"Подписка {plan.name} на 30 дней"
            
            logger.info(f"💳 PAYMENT PARAMETERS:")
            logger.info(f"   out_sum: '{out_sum}'")
            logger.info(f"   inv_id: '{inv_id}'")
            logger.info(f"   description: '{description}'")
            
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
            
            # ✅ ИСПРАВЛЕНО: Правильные дополнительные параметры с префиксом Shp_
            custom_params = {
                "Shp_user_id": user_id,
                "Shp_plan_code": plan_code
            }
            
            # ✅ ГЕНЕРИРУЕМ ПРАВИЛЬНУЮ ПОДПИСЬ
            logger.info(f"🔐 Generating signature with PASSWORD_1...")
            signature = cls.generate_signature(
                cls.MERCHANT_LOGIN,
                out_sum,
                inv_id,
                cls.PASSWORD_1,
                custom_params
            )
            
            # ✅ ИСПРАВЛЕНО: Правильные параметры формы
            form_params = {
                "MerchantLogin": cls.MERCHANT_LOGIN,
                "OutSum": out_sum,
                "InvId": inv_id,
                "Description": description,
                "SignatureValue": signature,
                "Culture": "ru",
                "Encoding": "utf-8"
            }
            
            # ✅ ВАЖНО: Добавляем URL'ы только для ПУБЛИЧНЫХ доменов
            if cls.BASE_URL and not any(x in cls.BASE_URL for x in ["localhost", "127.0.0.1"]):
                form_params["ResultURL"] = cls.RESULT_URL
                form_params["SuccessURL"] = cls.SUCCESS_URL  
                form_params["FailURL"] = cls.FAIL_URL
                logger.info(f"✅ Added callback URLs")
            else:
                logger.warning(f"⚠️ Skipping callback URLs due to localhost")
            
            # Добавляем email пользователя
            if user.email:
                form_params["Email"] = user.email
            
            # Добавляем тестовый режим
            if cls.TEST_MODE:
                form_params["IsTest"] = "1"
                logger.info("🧪 Test mode enabled")
            
            # Добавляем пользовательские параметры
            for key, value in custom_params.items():
                form_params[key] = value
            
            # ✅ ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ ФИНАЛЬНЫХ ПАРАМЕТРОВ
            logger.info(f"📋 FINAL FORM PARAMETERS:")
            for key, value in form_params.items():
                if key == "SignatureValue":
                    logger.info(f"   {key}: '{value}'")
                else:
                    logger.info(f"   {key}: '{value}'")
            
            logger.info(f"✅ Payment created successfully: {inv_id}")
            logger.info(f"🌐 Will redirect to: {cls.PAYMENT_URL}")
            
            # Логируем в базу
            await SubscriptionService.log_subscription_event(
                db=db,
                user_id=user_id,
                action="payment_started",
                plan_id=str(plan.id),
                plan_code=plan_code,
                details=f"Payment initiated: amount={out_sum}, inv_id={inv_id}, signature={signature[:10]}..."
            )
            
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
        ✅ ИСПРАВЛЕННАЯ обработка уведомления от Robokassa
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
            
            logger.info(f"📥 Processing payment result:")
            logger.info(f"   InvId: {inv_id}")
            logger.info(f"   OutSum: {out_sum}")
            logger.info(f"   SignatureValue: {signature_value[:10]}...")
            logger.info(f"   Custom params: {custom_params}")
            
            # ✅ ПРОВЕРЯЕМ ПОДПИСЬ С PASSWORD_2
            is_valid = cls.verify_result_signature(
                out_sum,
                inv_id,
                cls.PASSWORD_2,  # ✅ ВАЖНО: Для ResultURL используем PASSWORD_2
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
            
            # ✅ ОБНОВЛЯЕМ ПОДПИСКУ ПОЛЬЗОВАТЕЛЯ
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
            
            # ✅ ОБНОВЛЯЕМ СТАТУС ТРАНЗАКЦИИ
            transaction = db.query(PaymentTransaction).filter(
                PaymentTransaction.external_payment_id == inv_id
            ).first()
            
            if transaction:
                transaction.status = "success"
                transaction.paid_at = now
                transaction.processed_at = now
                transaction.is_processed = True
            
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
            
            # ✅ ВАЖНО: Возвращаем правильный ответ для Robokassa
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

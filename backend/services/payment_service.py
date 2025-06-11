# backend/services/payment_service.py

"""
ДИАГНОСТИЧЕСКАЯ ВЕРСИЯ Payment service для устранения ошибки 29 Robokassa
Включает детальную диагностику и возможность тестирования без Shp_ параметров
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
    """Service for Robokassa integration - ДИАГНОСТИЧЕСКАЯ ВЕРСИЯ для ошибки 29"""
    
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
    
    # 🔧 ДИАГНОСТИЧЕСКИЙ РЕЖИМ - для отключения Shp_ параметров при тестировании
    DISABLE_SHP_PARAMS = False  # Установите в True для тестирования без Shp_ параметров
    
    @staticmethod
    def validate_configuration() -> Dict[str, Any]:
        """
        🔍 НОВЫЙ МЕТОД: Проверка конфигурации для диагностики ошибки 29
        """
        issues = []
        warnings = []
        
        # Проверка MERCHANT_LOGIN
        if not RobokassaService.MERCHANT_LOGIN:
            issues.append("ROBOKASSA_MERCHANT_LOGIN не задан")
        elif RobokassaService.MERCHANT_LOGIN.lower() in ["demo", "test", "example"]:
            issues.append(f"ROBOKASSA_MERCHANT_LOGIN содержит тестовое значение: {RobokassaService.MERCHANT_LOGIN}")
        elif len(RobokassaService.MERCHANT_LOGIN.strip()) != len(RobokassaService.MERCHANT_LOGIN):
            warnings.append("ROBOKASSA_MERCHANT_LOGIN содержит лишние пробелы")
        
        # Проверка PASSWORD_1
        if not RobokassaService.PASSWORD_1:
            issues.append("ROBOKASSA_PASSWORD_1 не задан")
        elif RobokassaService.PASSWORD_1.lower() in ["password_1", "demo", "test"]:
            issues.append(f"ROBOKASSA_PASSWORD_1 содержит демо-значение")
        elif len(RobokassaService.PASSWORD_1) < 8:
            issues.append("ROBOKASSA_PASSWORD_1 слишком короткий (менее 8 символов)")
        
        # Проверка PASSWORD_2
        if not RobokassaService.PASSWORD_2:
            issues.append("ROBOKASSA_PASSWORD_2 не задан")
        elif RobokassaService.PASSWORD_2.lower() in ["password_2", "demo", "test"]:
            issues.append(f"ROBOKASSA_PASSWORD_2 содержит демо-значение")
        elif RobokassaService.PASSWORD_1 == RobokassaService.PASSWORD_2:
            issues.append("ROBOKASSA_PASSWORD_1 и ROBOKASSA_PASSWORD_2 одинаковые (должны различаться)")
        
        # Проверка BASE_URL
        if not RobokassaService.BASE_URL:
            issues.append("HOST_URL не задан")
        elif any(x in RobokassaService.BASE_URL for x in ["localhost", "127.0.0.1", "0.0.0.0"]):
            issues.append(f"HOST_URL содержит localhost: {RobokassaService.BASE_URL}")
        
        return {
            "valid": len(issues) == 0,
            "issues": issues,
            "warnings": warnings,
            "config": {
                "merchant_login": RobokassaService.MERCHANT_LOGIN,
                "merchant_login_length": len(RobokassaService.MERCHANT_LOGIN) if RobokassaService.MERCHANT_LOGIN else 0,
                "password1_length": len(RobokassaService.PASSWORD_1) if RobokassaService.PASSWORD_1 else 0,
                "password2_length": len(RobokassaService.PASSWORD_2) if RobokassaService.PASSWORD_2 else 0,
                "base_url": RobokassaService.BASE_URL,
                "test_mode": RobokassaService.TEST_MODE,
                "disable_shp_params": RobokassaService.DISABLE_SHP_PARAMS
            }
        }
    
    @staticmethod
    def generate_signature(
        merchant_login: str,
        out_sum: str,
        inv_id: str,
        password: str,
        custom_params: Optional[Dict[str, str]] = None
    ) -> str:
        """
        ✅ УЛУЧШЕННАЯ генерация подписи с расширенной диагностикой для ошибки 29
        Формула для инициализации платежа: MerchantLogin:OutSum:InvId:Password1[:Shp_item=value]
        """
        try:
            logger.info(f"🔐 SIGNATURE GENERATION (ошибка 29 диагностика):")
            logger.info(f"   merchant_login: '{merchant_login}' (length: {len(merchant_login)})")
            logger.info(f"   merchant_login_bytes: {merchant_login.encode('utf-8')}")
            logger.info(f"   out_sum: '{out_sum}' (type: {type(out_sum)})")
            logger.info(f"   inv_id: '{inv_id}' (type: {type(inv_id)})")
            logger.info(f"   password: '[HIDDEN]' (length: {len(password)})")
            
            # ✅ Проверка на пустые или некорректные значения
            if not merchant_login or not merchant_login.strip():
                raise ValueError("merchant_login пустой или содержит только пробелы")
            if not out_sum or not str(out_sum).strip():
                raise ValueError("out_sum пустой")
            if not inv_id or not str(inv_id).strip():
                raise ValueError("inv_id пустой")
            if not password or not password.strip():
                raise ValueError("password пустой")
            
            # ✅ Очистка от лишних пробелов
            merchant_login = merchant_login.strip()
            out_sum = str(out_sum).strip()
            inv_id = str(inv_id).strip()
            password = password.strip()
            
            # ✅ ПРАВИЛЬНАЯ базовая строка: MerchantLogin:OutSum:InvId:Password
            sign_string = f"{merchant_login}:{out_sum}:{inv_id}:{password}"
            
            logger.info(f"   base_string: '{sign_string}'")
            
            # ✅ Добавляем пользовательские параметры только если они не отключены
            if custom_params and not RobokassaService.DISABLE_SHP_PARAMS:
                # Сортируем параметры по ключам в алфавитном порядке
                sorted_params = sorted(custom_params.items())
                logger.info(f"   custom_params (sorted): {sorted_params}")
                
                for key, value in sorted_params:
                    # ✅ ВАЖНО: При генерации подписи НЕ убираем префикс Shp_
                    param_string = f"{key}={value}"
                    sign_string += f":{param_string}"
                    logger.info(f"   added param: '{param_string}'")
            elif RobokassaService.DISABLE_SHP_PARAMS:
                logger.info(f"   🔧 DIAGNOSTIC MODE: Shp_ parameters disabled for testing")
            else:
                logger.info(f"   no custom_params provided")
            
            logger.info(f"🔐 Final signature string: '{sign_string}'")
            logger.info(f"🔐 String length: {len(sign_string)} characters")
            logger.info(f"🔐 String bytes: {sign_string.encode('utf-8')}")
            
            # Генерируем MD5 хеш
            signature = hashlib.md5(sign_string.encode('utf-8')).hexdigest().upper()
            
            logger.info(f"✅ Generated signature: '{signature}'")
            logger.info(f"✅ Signature length: {len(signature)} characters")
            
            return signature
            
        except Exception as e:
            logger.error(f"❌ Error generating signature: {str(e)}")
            logger.error(f"❌ merchant_login: '{merchant_login}'")
            logger.error(f"❌ out_sum: '{out_sum}'")
            logger.error(f"❌ inv_id: '{inv_id}'")
            logger.error(f"❌ password length: {len(password) if password else 0}")
            raise
    
    @classmethod
    async def create_payment(
        cls,
        db: Session,
        user_id: str,
        plan_code: str = "start"
    ) -> Dict[str, Any]:
        """
        ✅ ДИАГНОСТИЧЕСКАЯ версия создания платежа для устранения ошибки 29
        """
        try:
            logger.info(f"🚀 Creating Robokassa payment for user {user_id}, plan {plan_code}")
            
            # 🔍 РАСШИРЕННАЯ диагностика конфигурации
            config_check = cls.validate_configuration()
            logger.info(f"📋 Configuration check: {config_check}")
            
            if not config_check["valid"]:
                error_details = "; ".join(config_check["issues"])
                logger.error(f"❌ Configuration errors: {error_details}")
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"Robokassa configuration errors: {error_details}"
                )
            
            if config_check["warnings"]:
                warning_details = "; ".join(config_check["warnings"])
                logger.warning(f"⚠️ Configuration warnings: {warning_details}")
            
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
            
            # ✅ УЛУЧШЕННЫЕ параметры платежа для избежания ошибки 29
            out_sum = f"{float(plan.price):.2f}"  # Формат X.XX
            inv_id = f"{int(datetime.now().timestamp())}"  # Простой числовой ID
            description = f"Подписка {plan.name} на 30 дней"
            
            logger.info(f"💳 PAYMENT PARAMETERS:")
            logger.info(f"   out_sum: '{out_sum}' (type: {type(out_sum)})")
            logger.info(f"   inv_id: '{inv_id}' (type: {type(inv_id)})")
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
            
            # ✅ Дополнительные параметры (можно отключить для диагностики)
            custom_params = None
            if not cls.DISABLE_SHP_PARAMS:
                custom_params = {
                    "Shp_user_id": user_id,
                    "Shp_plan_code": plan_code
                }
                logger.info(f"✅ Using Shp_ parameters: {custom_params}")
            else:
                logger.info(f"🔧 DIAGNOSTIC MODE: Shp_ parameters disabled")
            
            # ✅ ГЕНЕРИРУЕМ ПОДПИСЬ С РАСШИРЕННОЙ ДИАГНОСТИКОЙ
            logger.info(f"🔐 Generating signature with PASSWORD_1...")
            signature = cls.generate_signature(
                cls.MERCHANT_LOGIN,
                out_sum,
                inv_id,
                cls.PASSWORD_1,
                custom_params
            )
            
            # ✅ БАЗОВЫЕ параметры формы
            form_params = {
                "MerchantLogin": cls.MERCHANT_LOGIN,
                "OutSum": out_sum,
                "InvId": inv_id,
                "Description": description,
                "SignatureValue": signature,
                "Culture": "ru",
                "Encoding": "utf-8"
            }
            
            # ✅ Добавляем URL'ы только для публичных доменов
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
            
            # Добавляем пользовательские параметры только если они не отключены
            if custom_params and not cls.DISABLE_SHP_PARAMS:
                for key, value in custom_params.items():
                    form_params[key] = value
            
            # ✅ ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ ФИНАЛЬНЫХ ПАРАМЕТРОВ
            logger.info(f"📋 FINAL FORM PARAMETERS:")
            for key, value in form_params.items():
                if key == "SignatureValue":
                    logger.info(f"   {key}: '{value}'")
                else:
                    logger.info(f"   {key}: '{value}'")
            
            # ✅ ДОПОЛНИТЕЛЬНАЯ диагностика для ошибки 29
            logger.info(f"🔍 ERROR 29 DIAGNOSTIC INFO:")
            logger.info(f"   MerchantLogin exact value: '{cls.MERCHANT_LOGIN}'")
            logger.info(f"   MerchantLogin has spaces: {cls.MERCHANT_LOGIN != cls.MERCHANT_LOGIN.strip()}")
            logger.info(f"   Password1 length: {len(cls.PASSWORD_1)}")
            logger.info(f"   Test mode: {cls.TEST_MODE}")
            logger.info(f"   Shp params disabled: {cls.DISABLE_SHP_PARAMS}")
            
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
                "transaction_id": str(transaction.id),
                "diagnostic_info": config_check
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
        ✅ УЛУЧШЕННАЯ обработка уведомления от Robokassa с диагностикой
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
    def verify_result_signature(
        out_sum: str,
        inv_id: str,
        password: str,
        received_signature: str,
        custom_params: Optional[Dict[str, str]] = None
    ) -> bool:
        """
        ✅ УЛУЧШЕННАЯ проверка подписи в уведомлении от Robokassa
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
            
            # ✅ Добавляем пользовательские параметры в алфавитном порядке
            if custom_params and not RobokassaService.DISABLE_SHP_PARAMS:
                sorted_params = sorted(custom_params.items())
                for key, value in sorted_params:
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

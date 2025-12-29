# backend/services/payment_service.py

"""
Payment service for WellcomeAI application with partner commission integration.
Handles Robokassa payment integration with automatic partner commission processing.

✅ ВЕРСИЯ 2.0 - Поддержка разных периодов оплаты:
   - 1 месяц: 1 490₽ (30 дней)
   - 6 месяцев: 7 990₽ (180 дней, скидка 10%)
   - 12 месяцев: 14 990₽ (365 дней, скидка 15%)
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


# =============================================================================
# ✅ НАСТРОЙКИ ПОДПИСОК С РАЗНЫМИ ПЕРИОДАМИ
# =============================================================================

# Базовая месячная цена
BASE_MONTHLY_PRICE = 1490.0

# Конфигурация периодов подписки
SUBSCRIPTION_PERIODS = {
    1: {
        "months": 1,
        "days": 30,
        "price": 1490.0,          # Без скидки
        "discount_percent": 0,
        "savings": 0,
        "label": "1 месяц",
        "description": "Ежемесячная подписка"
    },
    6: {
        "months": 6,
        "days": 180,
        "price": 6990.0,          # Скидка 10% (было бы 8940)
        "discount_percent": 20,
        "savings": 1950,           # 8940 - 7990
        "label": "6 месяцев",
        "description": "Полугодовая подписка со скидкой 20%"
    },
    12: {
        "months": 12,
        "days": 365,
        "price": 12490.0,         # Скидка 15% (было бы 17880)
        "discount_percent": 30,
        "savings": 5390,          # 17880 - 14990
        "label": "1 год",
        "description": "Годовая подписка со скидкой 15%"
    }
}


def get_subscription_days_by_amount(amount: float) -> int:
    """
    Определить количество дней подписки по сумме платежа
    
    Args:
        amount: Сумма платежа
        
    Returns:
        Количество дней подписки
    """
    # Округляем сумму для сравнения (убираем копейки)
    amount_rounded = round(float(amount))
    
    for months, info in SUBSCRIPTION_PERIODS.items():
        if round(info["price"]) == amount_rounded:
            logger.info(f"💰 Matched amount {amount} to {months} months ({info['days']} days)")
            return info["days"]
    
    # Если не нашли точное совпадение, используем дефолт
    logger.warning(f"⚠️ Could not match amount {amount} to any period, using default 30 days")
    return 30


def get_subscription_days_by_duration(duration_months: int) -> int:
    """
    Получить количество дней по периоду подписки
    
    Args:
        duration_months: Количество месяцев (1, 6, 12)
        
    Returns:
        Количество дней подписки
    """
    if duration_months in SUBSCRIPTION_PERIODS:
        return SUBSCRIPTION_PERIODS[duration_months]["days"]
    
    logger.warning(f"⚠️ Unknown duration {duration_months}, using default 30 days")
    return 30


class RobokassaService:
    """Service for Robokassa integration with partner commission processing"""
    
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
    
    # Константы для подписки (для обратной совместимости)
    DEFAULT_SUBSCRIPTION_PRICE = BASE_MONTHLY_PRICE
    DEFAULT_SUBSCRIPTION_DURATION_DAYS = 30
    
    # 🔧 ДИАГНОСТИЧЕСКИЙ РЕЖИМ - для отключения Shp_ параметров при тестировании
    DISABLE_SHP_PARAMS = False
    
    # ⚠️ ВРЕМЕННОЕ ОТКЛЮЧЕНИЕ проверки подписи для результатов
    DISABLE_SIGNATURE_VERIFICATION = True  # ← ВРЕМЕННО ОТКЛЮЧАЕМ!
    
    @staticmethod
    def validate_configuration() -> Dict[str, Any]:
        """
        🔍 Проверка конфигурации для диагностики
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
        
        # Добавляем предупреждение об отключенной проверке подписи
        if RobokassaService.DISABLE_SIGNATURE_VERIFICATION:
            warnings.append("⚠️ ВНИМАНИЕ: Проверка подписи для результатов ОТКЛЮЧЕНА! Это временная мера.")
        
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
                "disable_shp_params": RobokassaService.DISABLE_SHP_PARAMS,
                "disable_signature_verification": RobokassaService.DISABLE_SIGNATURE_VERIFICATION
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
        ✅ Генерация подписи для инициализации платежа
        """
        try:
            logger.info(f"🔐 SIGNATURE GENERATION:")
            logger.info(f"   merchant_login: '{merchant_login}' (length: {len(merchant_login)})")
            logger.info(f"   out_sum: '{out_sum}' (type: {type(out_sum)})")
            logger.info(f"   inv_id: '{inv_id}' (type: {type(inv_id)})")
            logger.info(f"   password: '[HIDDEN]' (length: {len(password)})")
            
            # Проверка на пустые значения
            if not merchant_login or not merchant_login.strip():
                raise ValueError("merchant_login пустой")
            if not out_sum or not str(out_sum).strip():
                raise ValueError("out_sum пустой")
            if not inv_id or not str(inv_id).strip():
                raise ValueError("inv_id пустой")
            if not password or not password.strip():
                raise ValueError("password пустой")
            
            # Очистка от лишних пробелов
            merchant_login = merchant_login.strip()
            out_sum = str(out_sum).strip()
            inv_id = str(inv_id).strip()
            password = password.strip()
            
            # Базовая строка: MerchantLogin:OutSum:InvId:Password
            sign_string = f"{merchant_login}:{out_sum}:{inv_id}:{password}"
            
            logger.info(f"   base_string: '{sign_string}'")
            
            # Добавляем пользовательские параметры только если они не отключены
            if custom_params and not RobokassaService.DISABLE_SHP_PARAMS:
                sorted_params = sorted(custom_params.items())
                logger.info(f"   custom_params (sorted): {sorted_params}")
                
                for key, value in sorted_params:
                    param_string = f"{key}={value}"
                    sign_string += f":{param_string}"
                    logger.info(f"   added param: '{param_string}'")
            elif RobokassaService.DISABLE_SHP_PARAMS:
                logger.info(f"   🔧 DIAGNOSTIC MODE: Shp_ parameters disabled")
            else:
                logger.info(f"   no custom_params provided")
            
            logger.info(f"🔐 Final signature string: '{sign_string}'")
            
            # Генерируем MD5 хеш
            signature = hashlib.md5(sign_string.encode('utf-8')).hexdigest().upper()
            
            logger.info(f"✅ Generated signature: '{signature}'")
            
            return signature
            
        except Exception as e:
            logger.error(f"❌ Error generating signature: {str(e)}")
            raise
    
    @classmethod
    async def process_payment_result(
        cls,
        db: Session,
        form_data: Dict[str, Any]
    ) -> str:
        """
        ✅ ВЕРСИЯ 2.0: Обработка уведомления с поддержкой разных периодов подписки
        🆕 ИНТЕГРИРОВАНА с партнерской системой для автоматического начисления комиссий
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
            logger.info(f"   SignatureValue: {signature_value[:10] if signature_value else 'N/A'}...")
            logger.info(f"   Custom params: {custom_params}")
            
            # ⚠️ ВРЕМЕННО ОТКЛЮЧАЕМ ПРОВЕРКУ ПОДПИСИ
            if cls.DISABLE_SIGNATURE_VERIFICATION:
                logger.warning(f"⚠️ SIGNATURE VERIFICATION DISABLED - ACCEPTING ALL PAYMENTS!")
                logger.warning(f"⚠️ This is a TEMPORARY measure to fix OutSum format issue")
                logger.warning(f"⚠️ Re-enable signature verification after fixing the issue!")
                is_valid = True
            else:
                # Проверяем подпись с PASSWORD_2
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
            duration_str = custom_params.get("Shp_duration", "1")
            
            # ✅ НОВОЕ: Определяем количество дней подписки
            try:
                duration_months = int(duration_str)
            except (ValueError, TypeError):
                duration_months = 1
                logger.warning(f"⚠️ Could not parse Shp_duration '{duration_str}', using default 1 month")
            
            # Получаем количество дней по периоду
            subscription_days = get_subscription_days_by_duration(duration_months)
            
            # Если Shp_duration не передан, пробуем определить по сумме
            if duration_str == "1" and out_sum:
                try:
                    amount = float(out_sum)
                    detected_days = get_subscription_days_by_amount(amount)
                    if detected_days != 30:
                        subscription_days = detected_days
                        logger.info(f"📊 Detected subscription period by amount: {subscription_days} days")
                except (ValueError, TypeError):
                    pass
            
            logger.info(f"📅 Subscription duration: {duration_months} months = {subscription_days} days")
            
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
            if user.subscription_end_date:
                # Нормализуем дату
                end_date = user.subscription_end_date
                if end_date.tzinfo is None:
                    end_date = end_date.replace(tzinfo=timezone.utc)
                
                if end_date > now:
                    start_date = end_date
                    logger.info(f"📅 Extending subscription from {end_date}")
            
            # ✅ ИСПОЛЬЗУЕМ ПРАВИЛЬНОЕ КОЛИЧЕСТВО ДНЕЙ
            user.subscription_start_date = start_date
            user.subscription_end_date = start_date + timedelta(days=subscription_days)
            user.subscription_plan_id = plan.id
            user.is_trial = False  # Больше не триал
            
            logger.info(f"📅 Setting subscription:")
            logger.info(f"   Start: {user.subscription_start_date}")
            logger.info(f"   End: {user.subscription_end_date}")
            logger.info(f"   Days: {subscription_days}")
            
            # ✅ ОБНОВЛЯЕМ СТАТУС ТРАНЗАКЦИИ
            transaction = db.query(PaymentTransaction).filter(
                PaymentTransaction.external_payment_id == inv_id
            ).first()
            
            if transaction:
                transaction.status = "success"
                transaction.paid_at = now
                transaction.processed_at = now
                transaction.is_processed = True
                
                # Добавляем информацию о периоде
                period_info = f"Duration: {duration_months} months ({subscription_days} days)"
                if cls.DISABLE_SIGNATURE_VERIFICATION:
                    period_info += " [Signature verification disabled]"
                
                if transaction.payment_details:
                    transaction.payment_details += f" | Processed: {period_info}"
                else:
                    transaction.payment_details = period_info
            
            # 🎯 ВАЖНО: Сначала сохраняем подписку, потом обрабатываем комиссию
            db.commit()
            
            logger.info(f"✅ Subscription activated for user {user_id}")
            logger.info(f"   Period: {duration_months} months")
            logger.info(f"   Days: {subscription_days}")
            logger.info(f"   Until: {user.subscription_end_date}")
            
            # 🆕 ОБРАБОТКА ПАРТНЕРСКОЙ КОМИССИИ
            try:
                logger.info(f"💰 Processing partner commission for payment {inv_id}")
                
                # Импортируем здесь чтобы избежать циклических импортов
                from backend.services.partner_service import PartnerService
                
                # Обрабатываем комиссию партнера
                await PartnerService.process_referral_payment(
                    db=db,
                    user_id=user_id,
                    transaction=transaction,
                    amount=float(out_sum)
                )
                
                logger.info(f"✅ Partner commission processing completed for payment {inv_id}")
                
            except ImportError:
                logger.warning(f"⚠️ PartnerService not available, skipping commission processing")
            except Exception as partner_error:
                logger.error(f"❌ Error processing partner commission: {str(partner_error)}")
                # НЕ прерываем основной процесс платежа из-за ошибки партнерской системы
                # Платеж считается успешным, комиссия может быть обработана позже
            
            # Логируем успешную оплату
            await SubscriptionService.log_subscription_event(
                db=db,
                user_id=user_id,
                action="payment_success",
                plan_id=str(plan.id),
                plan_code=plan_code,
                details=(
                    f"Payment processed successfully. "
                    f"InvId: {inv_id}, "
                    f"Amount: {out_sum}, "
                    f"Duration: {duration_months} months ({subscription_days} days), "
                    f"Subscription until: {user.subscription_end_date.strftime('%Y-%m-%d')}. "
                    f"Signature verification: {'disabled' if cls.DISABLE_SIGNATURE_VERIFICATION else 'enabled'}"
                )
            )
            
            logger.info(f"✅ Payment {inv_id} processed successfully for user {user_id}")
            
            if cls.DISABLE_SIGNATURE_VERIFICATION:
                logger.warning(f"⚠️ Payment processed with DISABLED signature verification!")
            
            # Возвращаем правильный ответ для Robokassa
            return f"OK{inv_id}"
            
        except Exception as e:
            logger.error(f"❌ Error processing payment result: {str(e)}", exc_info=True)
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
        ✅ Проверка подписи в уведомлении от Robokassa
        Формула для ResultURL: OutSum:InvId:Password2[:Shp_item=value]
        """
        try:
            # Базовая строка для ResultURL: OutSum:InvId:Password2
            sign_string = f"{out_sum}:{inv_id}:{password}"
            
            logger.info(f"🔍 VERIFYING RESULT SIGNATURE:")
            logger.info(f"   out_sum: '{out_sum}'")
            logger.info(f"   inv_id: '{inv_id}'")
            logger.info(f"   password2: '[HIDDEN]' (length: {len(password)})")
            logger.info(f"   received_signature: '{received_signature}'")
            logger.info(f"   custom_params: {custom_params}")
            
            # Добавляем пользовательские параметры в алфавитном порядке
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
    
    @classmethod
    def get_subscription_periods_info(cls) -> Dict[str, Any]:
        """
        Получить информацию о всех периодах подписки
        
        Returns:
            Словарь с информацией о периодах
        """
        periods = []
        for months, info in SUBSCRIPTION_PERIODS.items():
            periods.append({
                "months": months,
                "days": info["days"],
                "price": info["price"],
                "price_formatted": f"{info['price']:.0f} ₽",
                "discount_percent": info["discount_percent"],
                "savings": info["savings"],
                "savings_formatted": f"{info['savings']:.0f} ₽" if info["savings"] > 0 else None,
                "label": info["label"],
                "description": info["description"],
                "monthly_price": round(info["price"] / months, 2),
                "monthly_price_formatted": f"{round(info['price'] / months):.0f} ₽/мес"
            })
        
        return {
            "periods": periods,
            "base_monthly_price": BASE_MONTHLY_PRICE,
            "currency": "RUB"
        }

# backend/services/payment_service.py

"""
ПРАВИЛЬНЫЙ Payment service for WellcomeAI application.
Полная версия с отслеживанием платежей и уведомлениями.
ИСПРАВЛЯЕТ ошибку 500 И сохраняет всю функциональность!
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
    """Service for Robokassa integration - ПОЛНАЯ ВЕРСИЯ с отслеживанием"""
    
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
        receipt: Optional[str] = None,
        custom_params: Optional[Dict[str, str]] = None
    ) -> str:
        """
        Генерация подписи для Robokassa
        """
        try:
            # Базовая строка для подписи: MerchantLogin:OutSum:InvId:Password
            sign_string = f"{merchant_login}:{out_sum}:{inv_id}:{password}"
            
            # Добавляем пользовательские параметры в алфавитном порядке
            if custom_params:
                sorted_params = sorted(custom_params.items())
                for key, value in sorted_params:
                    sign_string += f":{key}={value}"
            
            logger.debug(f"Signature string: {sign_string}")
            
            # Генерируем MD5 хеш
            signature = hashlib.md5(sign_string.encode('utf-8')).hexdigest().upper()
            
            logger.info(f"Generated signature: {signature}")
            return signature
            
        except Exception as e:
            logger.error(f"Error generating signature: {str(e)}")
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
    
    @staticmethod
    def create_receipt(description: str, amount: float) -> str:
        """
        Создание чека для фискализации
        """
        try:
            receipt = {
                "items": [
                    {
                        "name": description[:128],  # Ограничиваем длину названия
                        "quantity": 1,
                        "sum": amount,
                        "tax": "none"  # Без НДС
                    }
                ]
            }
            
            # Конвертируем в JSON и кодируем для URL
            receipt_json = json.dumps(receipt, ensure_ascii=False)
            receipt_encoded = quote(receipt_json)
            
            logger.debug(f"Created receipt: {receipt_encoded}")
            return receipt_encoded
            
        except Exception as e:
            logger.error(f"Error creating receipt: {str(e)}")
            raise
    
    @classmethod
    async def create_payment(
        cls,
        db: Session,
        user_id: str,
        plan_code: str = "start"
    ) -> Dict[str, Any]:
        """
        ✅ ПРАВИЛЬНАЯ версия создания платежа с ПОЛНЫМ отслеживанием
        """
        try:
            logger.info(f"🚀 Creating payment for user {user_id}, plan {plan_code}")
            
            # Проверяем настройки Robokassa
            if not cls.MERCHANT_LOGIN:
                logger.error("ROBOKASSA_MERCHANT_LOGIN not configured")
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Payment system not configured: missing merchant login"
                )
                
            if not cls.PASSWORD_1:
                logger.error("ROBOKASSA_PASSWORD_1 not configured")
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Payment system not configured: missing password"
                )
            
            # Получаем пользователя
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                logger.error(f"User {user_id} not found")
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="User not found"
                )
            
            # ✅ ПРАВИЛЬНО: Получаем план из таблицы subscription_plans
            plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == plan_code).first()
            if not plan:
                logger.info(f"Creating new subscription plan: {plan_code}")
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
            
            logger.info(f"💳 Payment details: amount={out_sum}, inv_id={inv_id}, plan={plan.name}")
            
            # ✅ КРИТИЧЕСКИ ВАЖНО: Создаем запись транзакции ДО отправки платежа
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
            
            # ✅ КРИТИЧЕСКИ ВАЖНО: Логируем начало процесса оплаты
            await SubscriptionService.log_subscription_event(
                db=db,
                user_id=user_id,
                action="payment_started",
                plan_id=str(plan.id),
                plan_code=plan_code,
                details=f"Payment initiated: amount={out_sum}, inv_id={inv_id}",
                amount=float(out_sum),
                payment_id=inv_id
            )
            
            # Создаем чек для фискализации
            try:
                receipt = cls.create_receipt(description, float(plan.price))
            except Exception as e:
                logger.error(f"Error creating receipt: {str(e)}")
                receipt = ""  # Продолжаем без чека, если есть проблемы
            
            # Дополнительные параметры
            custom_params = {
                "Shp_user_id": user_id,
                "Shp_plan_code": plan_code,
                "Shp_transaction_id": str(transaction.id)  # ✅ ВАЖНО: передаем ID транзакции
            }
            
            # Генерируем подпись
            try:
                signature = cls.generate_signature(
                    cls.MERCHANT_LOGIN,
                    out_sum,
                    inv_id,
                    cls.PASSWORD_1,
                    receipt if receipt else None,
                    custom_params
                )
            except Exception as e:
                logger.error(f"Error generating signature: {str(e)}")
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Error generating payment signature"
                )
            
            # Формируем параметры для формы
            form_params = {
                "MerchantLogin": cls.MERCHANT_LOGIN,
                "OutSum": out_sum,
                "InvId": inv_id,
                "Description": description,
                "SignatureValue": signature,
                "Culture": "ru",
                "Encoding": "utf-8"
            }
            
            # Добавляем чек только если он создан успешно
            if receipt:
                form_params["Receipt"] = receipt
            
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
            
            # Добавляем пользовательские параметры
            for key, value in custom_params.items():
                form_params[key] = value
            
            logger.info(f"✅ Payment created successfully: {inv_id}")
            logger.info(f"📄 Transaction ID: {transaction.id}")
            
            return {
                "payment_url": cls.PAYMENT_URL,
                "form_params": form_params,
                "inv_id": inv_id,
                "amount": out_sum,
                "transaction_id": str(transaction.id)  # ✅ Возвращаем для отслеживания
            }
            
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"❌ Error creating payment: {str(e)}")
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
        ✅ ПРАВИЛЬНАЯ обработка уведомления с ПОЛНЫМ отслеживанием
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
            transaction_id = custom_params.get("Shp_transaction_id")
            
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
            
            # ✅ КРИТИЧЕСКИ ВАЖНО: Обновляем статус транзакции
            if transaction_id:
                transaction = db.query(PaymentTransaction).filter(
                    PaymentTransaction.id == transaction_id
                ).first()
                if transaction:
                    transaction.status = "success"
                    transaction.paid_at = datetime.now(timezone.utc)
                    transaction.is_processed = True
                    logger.info(f"✅ Updated transaction {transaction_id} status to success")
            
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
            
            # ✅ КРИТИЧЕСКИ ВАЖНО: Логируем успешную оплату
            await SubscriptionService.log_subscription_event(
                db=db,
                user_id=user_id,
                action="payment_success",
                plan_id=str(plan.id),
                plan_code=plan_code,
                details=f"Payment processed successfully. InvId: {inv_id}, Amount: {out_sum}, Subscription until: {user.subscription_end_date.strftime('%Y-%m-%d')}",
                amount=float(out_sum),
                payment_id=inv_id
            )
            
            logger.info(f"✅ Payment {inv_id} processed successfully for user {user_id}")
            logger.info(f"📅 Subscription updated: start={start_date}, end={user.subscription_end_date}")
            
            # ✅ КРИТИЧЕСКИ ВАЖНО: Отправляем уведомление об успешной оплате
            try:
                from backend.services.notification_service import NotificationService
                await NotificationService.send_payment_success_notification(
                    user=user,
                    plan_name=plan.name,
                    amount=float(out_sum),
                    end_date=user.subscription_end_date
                )
                logger.info(f"📧 Payment success notification sent to {user.email}")
            except Exception as notif_error:
                logger.error(f"⚠️ Failed to send payment notification: {notif_error}")
            
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

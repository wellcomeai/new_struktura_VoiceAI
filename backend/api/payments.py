# backend/api/payments.py

"""
Payment API endpoints for WellcomeAI application.
Handles Robokassa payment integration.

✅ ВЕРСИЯ 2.0 - Поддержка разных периодов оплаты:
   - 1 месяц: 1 490₽
   - 6 месяцев: 7 990₽ (скидка 10%)
   - 12 месяцев: 14 990₽ (скидка 15%)
"""

from fastapi import APIRouter, Depends, HTTPException, status, Request, Form, Body
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session
from typing import Optional, Dict, Any, Literal
from datetime import datetime, timedelta, timezone
from pydantic import BaseModel

from backend.core.logging import get_logger
from backend.core.dependencies import get_current_user
from backend.core.config import settings
from backend.db.session import get_db
from backend.models.user import User
from backend.models.subscription import SubscriptionPlan, PaymentTransaction
from backend.services.payment_service import RobokassaService
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
        "price": 1.0,          # Скидка 10% (было бы 8940)
        "discount_percent": 10,
        "savings": 950,           # 8940 - 7990
        "label": "6 месяцев",
        "description": "Полугодовая подписка со скидкой 10%"
    },
    12: {
        "months": 12,
        "days": 365,
        "price": 1.0,         # Скидка 15% (было бы 17880)
        "discount_percent": 15,
        "savings": 2890,          # 17880 - 14990
        "label": "1 год",
        "description": "Годовая подписка со скидкой 15%"
    }
}

# Настройки плана по умолчанию
SUBSCRIPTION_PLAN_NAME = "Тариф Старт"
SUBSCRIPTION_DESCRIPTION = "Стартовый тариф с доступом ко всем функциям"
MAX_ASSISTANTS = 3

# Create router
router = APIRouter()


# =============================================================================
# Pydantic модели для запросов
# =============================================================================

class CreatePaymentRequest(BaseModel):
    """Модель запроса на создание платежа"""
    plan_code: str = "start"
    duration_months: Literal[1, 6, 12] = 1  # Допустимые значения: 1, 6, 12


# =============================================================================
# Вспомогательные функции
# =============================================================================

def get_subscription_period_info(duration_months: int) -> Dict[str, Any]:
    """
    Получить информацию о периоде подписки
    
    Args:
        duration_months: Количество месяцев (1, 6, 12)
        
    Returns:
        Словарь с информацией о периоде
        
    Raises:
        ValueError: Если указан неподдерживаемый период
    """
    if duration_months not in SUBSCRIPTION_PERIODS:
        raise ValueError(f"Неподдерживаемый период подписки: {duration_months}. Допустимые значения: 1, 6, 12")
    
    return SUBSCRIPTION_PERIODS[duration_months]


# =============================================================================
# API Endpoints
# =============================================================================

@router.post("/create-payment", response_model=Dict[str, Any])
async def create_payment(
    request_data: CreatePaymentRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Создание платежа для подписки с поддержкой разных периодов
    
    ✅ ВЕРСИЯ 2.0: Поддержка 1, 6, 12 месяцев
    
    Args:
        request_data: Данные запроса (plan_code, duration_months)
        current_user: Текущий пользователь
        db: Сессия базы данных
        
    Returns:
        Данные для перенаправления на оплату
    """
    try:
        plan_code = request_data.plan_code
        duration_months = request_data.duration_months
        
        logger.info(f"🚀 Creating payment for user {current_user.id}")
        logger.info(f"   Plan: {plan_code}")
        logger.info(f"   Duration: {duration_months} months")
        
        # Получаем информацию о выбранном периоде
        try:
            period_info = get_subscription_period_info(duration_months)
        except ValueError as e:
            logger.error(f"❌ Invalid duration_months: {duration_months}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(e)
            )
        
        subscription_price = period_info["price"]
        subscription_days = period_info["days"]
        discount_percent = period_info["discount_percent"]
        savings = period_info["savings"]
        period_label = period_info["label"]
        
        logger.info(f"📋 Payment settings:")
        logger.info(f"   Period: {period_label}")
        logger.info(f"   Price: {subscription_price} руб")
        logger.info(f"   Days: {subscription_days}")
        logger.info(f"   Discount: {discount_percent}%")
        logger.info(f"   Savings: {savings} руб")
        logger.info(f"   HOST_URL: {settings.HOST_URL}")
        logger.info(f"   ROBOKASSA_MERCHANT_LOGIN: {settings.ROBOKASSA_MERCHANT_LOGIN}")
        logger.info(f"   ROBOKASSA_TEST_MODE: {settings.ROBOKASSA_TEST_MODE}")
        
        # Проверка настроек Robokassa
        if not settings.ROBOKASSA_MERCHANT_LOGIN:
            logger.error("❌ ROBOKASSA_MERCHANT_LOGIN is not configured")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Payment system not configured: missing merchant login. Contact administrator."
            )
            
        if not settings.ROBOKASSA_PASSWORD_1:
            logger.error("❌ ROBOKASSA_PASSWORD_1 is not configured")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Payment system not configured: missing password. Contact administrator."
            )
        
        logger.info(f"👤 User info: email={current_user.email}, is_trial={current_user.is_trial}")
        
        # Получаем пользователя
        user = db.query(User).filter(User.id == current_user.id).first()
        if not user:
            logger.error(f"❌ User {current_user.id} not found")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        # Получаем или создаем план подписки
        plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == plan_code).first()
        if not plan:
            logger.info(f"📋 Creating subscription plan: {plan_code}")
            plan = SubscriptionPlan(
                code=plan_code,
                name=SUBSCRIPTION_PLAN_NAME,
                price=BASE_MONTHLY_PRICE,  # Базовая месячная цена
                max_assistants=MAX_ASSISTANTS,
                description=SUBSCRIPTION_DESCRIPTION,
                is_active=True
            )
            db.add(plan)
            db.flush()
            logger.info(f"✅ Created subscription plan: {plan_code}")
        
        # Формируем параметры платежа
        out_sum = f"{subscription_price:.2f}"
        inv_id = f"{int(datetime.now().timestamp())}"
        
        # Формируем описание с учётом периода
        if duration_months == 1:
            description = f"Подписка на {subscription_days} дней за {subscription_price:.0f} рублей"
        else:
            description = f"Подписка на {period_label} за {subscription_price:.0f} рублей (скидка {discount_percent}%)"
        
        logger.info(f"💳 PAYMENT PARAMETERS:")
        logger.info(f"   out_sum: '{out_sum}'")
        logger.info(f"   inv_id: '{inv_id}'")
        logger.info(f"   description: '{description}'")
        
        # Создаем запись транзакции
        payment_details = (
            f"Plan: {plan_code}, "
            f"Duration: {duration_months} months ({subscription_days} days), "
            f"Price: {subscription_price}, "
            f"Discount: {discount_percent}%, "
            f"Savings: {savings}"
        )
        
        transaction = PaymentTransaction(
            user_id=user.id,
            plan_id=plan.id,
            external_payment_id=inv_id,
            payment_system="robokassa",
            amount=subscription_price,
            currency="RUB",
            status="pending",
            payment_details=payment_details
        )
        db.add(transaction)
        db.commit()
        db.refresh(transaction)
        
        logger.info(f"📋 Created payment transaction: {transaction.id}")
        
        # Дополнительные параметры для callback
        custom_params = None
        if not RobokassaService.DISABLE_SHP_PARAMS:
            custom_params = {
                "Shp_duration": str(duration_months),
                "Shp_plan_code": plan_code,
                "Shp_user_id": str(current_user.id)
            }
            logger.info(f"✅ Using Shp_ parameters: {custom_params}")
        else:
            logger.info(f"🔧 DIAGNOSTIC MODE: Shp_ parameters disabled")
        
        # Генерируем подпись
        logger.info(f"🔐 Generating signature with PASSWORD_1...")
        signature = RobokassaService.generate_signature(
            RobokassaService.MERCHANT_LOGIN,
            out_sum,
            inv_id,
            RobokassaService.PASSWORD_1,
            custom_params
        )
        
        # Базовые параметры формы
        form_params = {
            "MerchantLogin": RobokassaService.MERCHANT_LOGIN,
            "OutSum": out_sum,
            "InvId": inv_id,
            "Description": description,
            "SignatureValue": signature,
            "Culture": "ru",
            "Encoding": "utf-8"
        }
        
        # Добавляем URL'ы только для публичных доменов
        if RobokassaService.BASE_URL and not any(x in RobokassaService.BASE_URL for x in ["localhost", "127.0.0.1"]):
            form_params["ResultURL"] = RobokassaService.RESULT_URL
            form_params["SuccessURL"] = RobokassaService.SUCCESS_URL  
            form_params["FailURL"] = RobokassaService.FAIL_URL
            logger.info(f"✅ Added callback URLs")
        else:
            logger.warning(f"⚠️ Skipping callback URLs due to localhost")
        
        # Добавляем email пользователя
        if user.email:
            form_params["Email"] = user.email
        
        # Добавляем тестовый режим
        if RobokassaService.TEST_MODE:
            form_params["IsTest"] = "1"
            logger.info("🧪 Test mode enabled")
        
        # Добавляем пользовательские параметры
        if custom_params and not RobokassaService.DISABLE_SHP_PARAMS:
            for key, value in custom_params.items():
                form_params[key] = value
        
        logger.info(f"📋 FINAL FORM PARAMETERS:")
        for key, value in form_params.items():
            logger.info(f"   {key}: '{value}'")
        
        logger.info(f"✅ Payment created: {subscription_price} rubles for {subscription_days} days")
        
        # Логируем событие
        await SubscriptionService.log_subscription_event(
            db=db,
            user_id=str(current_user.id),
            action="payment_started",
            plan_id=str(plan.id),
            plan_code=plan_code,
            details=f"Payment initiated: {period_label}, price={subscription_price}, days={subscription_days}, inv_id={inv_id}"
        )
        
        return {
            "payment_url": RobokassaService.PAYMENT_URL,
            "form_params": form_params,
            "inv_id": inv_id,
            "amount": out_sum,
            "transaction_id": str(transaction.id),
            # Дополнительная информация о периоде
            "period_info": {
                "months": duration_months,
                "days": subscription_days,
                "price": subscription_price,
                "discount_percent": discount_percent,
                "savings": savings,
                "label": period_label
            }
        }
        
    except HTTPException as he:
        logger.error(f"❌ HTTP Exception in create_payment: {he.detail}")
        raise
    except Exception as e:
        logger.error(f"❌ Unexpected error in create_payment: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create payment: {str(e)}"
        )


@router.get("/subscription-periods", response_model=Dict[str, Any])
async def get_subscription_periods():
    """
    Получить информацию о доступных периодах подписки
    
    Возвращает список периодов с ценами и скидками для отображения на фронтенде
    """
    try:
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
        
    except Exception as e:
        logger.error(f"❌ Error in get_subscription_periods: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get subscription periods"
        )


@router.post("/robokassa-result")
async def robokassa_result(
    request: Request,
    db: Session = Depends(get_db),
    OutSum: str = Form(...),
    InvId: str = Form(...),
    SignatureValue: str = Form(...),
    Shp_user_id: Optional[str] = Form(None),
    Shp_plan_code: Optional[str] = Form(None),
    Shp_duration: Optional[str] = Form(None)  # ✅ НОВОЕ: период подписки
):
    """
    Обработка уведомления о результате платежа от Robokassa (ResultURL)
    
    ✅ ВЕРСИЯ 2.0: Поддержка параметра Shp_duration для разных периодов
    """
    try:
        # Собираем все данные формы
        form_data = await request.form()
        form_dict = dict(form_data)
        
        logger.info(f"📥 Received Robokassa result notification:")
        logger.info(f"   OutSum: {OutSum}")
        logger.info(f"   InvId: {InvId}")
        logger.info(f"   SignatureValue: {SignatureValue[:10]}...")
        logger.info(f"   Shp_user_id: {Shp_user_id}")
        logger.info(f"   Shp_plan_code: {Shp_plan_code}")
        logger.info(f"   Shp_duration: {Shp_duration}")
        logger.info(f"   All form data: {form_dict}")
        
        # Обрабатываем результат платежа
        result = await RobokassaService.process_payment_result(db, form_dict)
        
        logger.info(f"✅ Payment result processed: {result}")
        
        # Возвращаем ответ Robokassa
        return HTMLResponse(content=result, status_code=200)
        
    except Exception as e:
        logger.error(f"❌ Error in robokassa_result endpoint: {str(e)}", exc_info=True)
        return HTMLResponse(content="FAIL", status_code=200)


@router.get("/success", response_class=HTMLResponse)
@router.post("/success", response_class=HTMLResponse)
async def payment_success(
    request: Request,
    OutSum: Optional[str] = None,
    InvId: Optional[str] = None,
    SignatureValue: Optional[str] = None
):
    """
    Страница успешной оплаты (SuccessURL)
    
    Поддерживает как GET, так и POST запросы
    """
    try:
        # Получаем параметры из GET или POST
        if request.method == "POST":
            try:
                form_data = await request.form()
                OutSum = form_data.get("OutSum", OutSum)
                InvId = form_data.get("InvId", InvId)
                SignatureValue = form_data.get("SignatureValue", SignatureValue)
            except Exception as form_error:
                logger.warning(f"⚠️ Could not parse form data: {form_error}")
        
        logger.info(f"🎉 User redirected to success page:")
        logger.info(f"   Method: {request.method}")
        logger.info(f"   InvId: {InvId}")
        logger.info(f"   OutSum: {OutSum}")
        
        # Получаем данные для отображения
        status_data = RobokassaService.get_payment_status_message(success=True)
        
        # Возвращаем HTML страницу с результатом
        html_content = f"""
        <!DOCTYPE html>
        <html lang="ru">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>{status_data['title']}</title>
            <style>
                body {{
                    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    margin: 0;
                    padding: 20px;
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }}
                .container {{
                    background: white;
                    border-radius: 20px;
                    padding: 40px;
                    max-width: 500px;
                    text-align: center;
                    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.1);
                }}
                .icon {{
                    font-size: 4rem;
                    color: #10b981;
                    margin-bottom: 20px;
                }}
                .title {{
                    font-size: 1.8rem;
                    font-weight: 600;
                    color: #1f2937;
                    margin-bottom: 10px;
                }}
                .message {{
                    color: #6b7280;
                    margin-bottom: 30px;
                    line-height: 1.6;
                }}
                .button {{
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 12px 30px;
                    border: none;
                    border-radius: 10px;
                    font-weight: 500;
                    text-decoration: none;
                    display: inline-block;
                    transition: transform 0.2s;
                }}
                .button:hover {{
                    transform: translateY(-2px);
                }}
            </style>
        </head>
        <body>
            <div class="container">
                <div class="icon">✅</div>
                <h1 class="title">{status_data['title']}</h1>
                <p class="message">{status_data['message']}</p>
                <a href="{status_data['redirect_url']}?payment_result=success&payment_status=success" class="button">Перейти в панель управления</a>
            </div>
            <script>
                // Автоматическое перенаправление через 5 секунд
                setTimeout(() => {{
                    window.location.href = "{status_data['redirect_url']}?payment_result=success&payment_status=success";
                }}, 5000);
            </script>
        </body>
        </html>
        """
        
        return HTMLResponse(content=html_content)
        
    except Exception as e:
        logger.error(f"❌ Error in payment_success endpoint: {str(e)}", exc_info=True)
        return HTMLResponse(content="<h1>Произошла ошибка</h1>", status_code=500)


@router.get("/cancel", response_class=HTMLResponse)
@router.post("/cancel", response_class=HTMLResponse) 
async def payment_cancel(
    request: Request,
    OutSum: Optional[str] = None,
    InvId: Optional[str] = None
):
    """
    Страница отмены оплаты (FailURL)
    
    Поддерживает как GET, так и POST запросы
    """
    try:
        # Получаем параметры из GET или POST
        if request.method == "POST":
            try:
                form_data = await request.form()
                OutSum = form_data.get("OutSum", OutSum)
                InvId = form_data.get("InvId", InvId)
            except Exception as form_error:
                logger.warning(f"⚠️ Could not parse form data in cancel: {form_error}")
        
        logger.info(f"❌ User redirected to cancel page:")
        logger.info(f"   Method: {request.method}")
        logger.info(f"   InvId: {InvId}")
        logger.info(f"   OutSum: {OutSum}")
        
        # Получаем данные для отображения
        status_data = RobokassaService.get_payment_status_message(success=False)
        
        # Возвращаем HTML страницу с результатом
        html_content = f"""
        <!DOCTYPE html>
        <html lang="ru">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>{status_data['title']}</title>
            <style>
                body {{
                    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    background: linear-gradient(135deg, #ffeaa7 0%, #fab1a0 100%);
                    margin: 0;
                    padding: 20px;
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }}
                .container {{
                    background: white;
                    border-radius: 20px;
                    padding: 40px;
                    max-width: 500px;
                    text-align: center;
                    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.1);
                }}
                .icon {{
                    font-size: 4rem;
                    color: #f97316;
                    margin-bottom: 20px;
                }}
                .title {{
                    font-size: 1.8rem;
                    font-weight: 600;
                    color: #1f2937;
                    margin-bottom: 10px;
                }}
                .message {{
                    color: #6b7280;
                    margin-bottom: 30px;
                    line-height: 1.6;
                }}
                .button {{
                    background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
                    color: white;
                    padding: 12px 30px;
                    border: none;
                    border-radius: 10px;
                    font-weight: 500;
                    text-decoration: none;
                    display: inline-block;
                    transition: transform 0.2s;
                }}
                .button:hover {{
                    transform: translateY(-2px);
                }}
            </style>
        </head>
        <body>
            <div class="container">
                <div class="icon">⚠️</div>
                <h1 class="title">{status_data['title']}</h1>
                <p class="message">{status_data['message']}</p>
                <a href="{status_data['redirect_url']}" class="button">Вернуться в панель управления</a>
            </div>
            <script>
                // Автоматическое перенаправление через 10 секунд
                setTimeout(() => {{
                    window.location.href = "{status_data['redirect_url']}";
                }}, 10000);
            </script>
        </body>
        </html>
        """
        
        return HTMLResponse(content=html_content)
        
    except Exception as e:
        logger.error(f"❌ Error in payment_cancel endpoint: {str(e)}", exc_info=True)
        return HTMLResponse(content="<h1>Произошла ошибка</h1>", status_code=500)


@router.get("/status/{user_id}")
async def get_payment_status(
    user_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получение статуса платежа/подписки пользователя
    """
    try:
        # Проверяем права доступа
        if str(current_user.id) != user_id and not current_user.is_admin:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied"
            )
        
        # Получаем информацию о подписке
        from backend.api.subscriptions import get_my_subscription
        
        if str(current_user.id) == user_id:
            return await get_my_subscription(current_user, db)
        else:
            # Для админа - получаем информацию о другом пользователе
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="User not found"
                )
            return await get_my_subscription(user, db)
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Error in get_payment_status endpoint: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get payment status"
        )


# =============================================================================
# ДИАГНОСТИЧЕСКИЕ ЭНДПОИНТЫ
# =============================================================================

@router.get("/debug-prices")
async def debug_subscription_prices(db: Session = Depends(get_db)):
    """
    🔍 ДИАГНОСТИЧЕСКИЙ endpoint для проверки цен подписок
    """
    try:
        plans = db.query(SubscriptionPlan).all()
        result = {
            "subscription_periods": {},
            "database_plans": {}
        }
        
        # Информация о периодах
        for months, info in SUBSCRIPTION_PERIODS.items():
            result["subscription_periods"][f"{months}_months"] = {
                "price": info["price"],
                "days": info["days"],
                "discount_percent": info["discount_percent"],
                "savings": info["savings"],
                "label": info["label"]
            }
        
        # Информация из БД
        for plan in plans:
            result["database_plans"][plan.code] = {
                "name": plan.name,
                "price": float(plan.price),
                "max_assistants": plan.max_assistants,
                "is_active": plan.is_active,
                "created_at": plan.created_at.isoformat() if plan.created_at else None
            }
        
        logger.info(f"🔍 Debug prices requested")
        return result
        
    except Exception as e:
        logger.error(f"❌ Error in debug_subscription_prices: {str(e)}")
        return {
            "error": str(e),
            "subscription_periods": SUBSCRIPTION_PERIODS
        }


@router.get("/config-check")
async def check_robokassa_config():
    """
    🔍 ДИАГНОСТИЧЕСКИЙ endpoint для проверки конфигурации Robokassa
    """
    try:
        from backend.services.payment_service import RobokassaService
        
        config_check = RobokassaService.validate_configuration()
        
        logger.info(f"🔍 Configuration check requested")
        logger.info(f"   Valid: {config_check['valid']}")
        logger.info(f"   Issues: {config_check['issues']}")
        logger.info(f"   Warnings: {config_check['warnings']}")
        
        return {
            "status": "ok" if config_check["valid"] else "error",
            "valid": config_check["valid"],
            "issues": config_check["issues"],
            "warnings": config_check["warnings"],
            "subscription_periods": {
                f"{m}m": {"price": i["price"], "days": i["days"]} 
                for m, i in SUBSCRIPTION_PERIODS.items()
            },
            "config": {
                "merchant_login": config_check["config"]["merchant_login"],
                "merchant_login_length": config_check["config"]["merchant_login_length"],
                "password1_length": config_check["config"]["password1_length"],
                "password2_length": config_check["config"]["password2_length"],
                "base_url": config_check["config"]["base_url"],
                "test_mode": config_check["config"]["test_mode"],
                "disable_shp_params": config_check["config"]["disable_shp_params"]
            },
            "recommendations": [
                "Убедитесь, что MERCHANT_LOGIN точно скопирован из личного кабинета Robokassa",
                "Проверьте, что пароли #1 и #2 совпадают с техническими настройками",
                "Заполните блок 'Параметры проведения тестовых платежей' в кабинете",
                "Используйте публичный домен (не localhost) для HOST_URL",
                "Убедитесь, что магазин активирован в Robokassa"
            ]
        }
        
    except Exception as e:
        logger.error(f"❌ Error checking configuration: {str(e)}")
        return {
            "status": "error",
            "error": str(e),
            "message": "Ошибка при проверке конфигурации Robokassa"
        }


@router.post("/test-signature")
async def test_signature_generation(
    request: dict = Body(...)
):
    """
    🔧 ДИАГНОСТИЧЕСКИЙ endpoint для тестирования генерации подписи
    """
    try:
        from backend.services.payment_service import RobokassaService
        
        merchant_login = request.get("merchant_login", RobokassaService.MERCHANT_LOGIN)
        out_sum = request.get("out_sum", f"{SUBSCRIPTION_PERIODS[1]['price']:.2f}")
        inv_id = request.get("inv_id", "123456789")
        password = request.get("password", RobokassaService.PASSWORD_1)
        duration_months = request.get("duration_months", 1)
        
        custom_params = {
            "Shp_duration": str(duration_months),
            "Shp_plan_code": "start",
            "Shp_user_id": "test"
        }
        
        logger.info(f"🔧 Testing signature generation")
        logger.info(f"   duration_months: {duration_months}")
        
        signature = RobokassaService.generate_signature(
            merchant_login=merchant_login,
            out_sum=out_sum,
            inv_id=inv_id,
            password=password,
            custom_params=custom_params
        )
        
        sign_string = f"{merchant_login}:{out_sum}:{inv_id}:{password}"
        if custom_params and not RobokassaService.DISABLE_SHP_PARAMS:
            sorted_params = sorted(custom_params.items())
            for key, value in sorted_params:
                sign_string += f":{key}={value}"
        
        return {
            "status": "ok",
            "signature": signature,
            "sign_string": sign_string,
            "subscription_periods": SUBSCRIPTION_PERIODS,
            "parameters": {
                "merchant_login": merchant_login,
                "out_sum": out_sum,
                "inv_id": inv_id,
                "duration_months": duration_months,
                "custom_params": custom_params
            }
        }
        
    except Exception as e:
        logger.error(f"❌ Error testing signature: {str(e)}")
        return {
            "status": "error",
            "error": str(e)
        }


@router.post("/enable-diagnostic-mode")
async def enable_diagnostic_mode():
    """
    🔧 ДИАГНОСТИЧЕСКИЙ endpoint для включения режима без Shp_ параметров
    """
    try:
        from backend.services.payment_service import RobokassaService
        
        RobokassaService.DISABLE_SHP_PARAMS = True
        
        logger.info(f"🔧 Diagnostic mode enabled: Shp_ parameters disabled")
        
        return {
            "status": "ok",
            "message": "Диагностический режим включен - Shp_ параметры отключены",
            "disable_shp_params": True,
            "subscription_periods": SUBSCRIPTION_PERIODS
        }
        
    except Exception as e:
        logger.error(f"❌ Error enabling diagnostic mode: {str(e)}")
        return {
            "status": "error",
            "error": str(e)
        }


@router.post("/disable-diagnostic-mode")
async def disable_diagnostic_mode():
    """
    🔧 ДИАГНОСТИЧЕСКИЙ endpoint для выключения режима без Shp_ параметров
    """
    try:
        from backend.services.payment_service import RobokassaService
        
        RobokassaService.DISABLE_SHP_PARAMS = False
        
        logger.info(f"🔧 Diagnostic mode disabled: Shp_ parameters enabled")
        
        return {
            "status": "ok",
            "message": "Диагностический режим выключен - Shp_ параметры включены",
            "disable_shp_params": False
        }
        
    except Exception as e:
        logger.error(f"❌ Error disabling diagnostic mode: {str(e)}")
        return {
            "status": "error",
            "error": str(e)
        }

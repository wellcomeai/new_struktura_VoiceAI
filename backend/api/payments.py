# backend/api/payments.py

"""
Payment API endpoints for WellcomeAI application.
Handles Robokassa payment integration.
ИСПРАВЛЕННАЯ ВЕРСИЯ - поддержка GET/POST для всех endpoints + фиксированная цена 1490 рублей
"""

from fastapi import APIRouter, Depends, HTTPException, status, Request, Form, Body
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session
from typing import Optional, Dict, Any
from datetime import datetime, timedelta, timezone

from backend.core.logging import get_logger
from backend.core.dependencies import get_current_user
from backend.core.config import settings
from backend.db.session import get_db
from backend.models.user import User
from backend.models.subscription import SubscriptionPlan, PaymentTransaction
from backend.services.payment_service import RobokassaService
from backend.services.subscription_service import SubscriptionService

logger = get_logger(__name__)

# ✅ ФИКСИРОВАННЫЕ НАСТРОЙКИ ПОДПИСКИ
FIXED_SUBSCRIPTION_PRICE = 1490.0  # Фиксированная цена в рублях
SUBSCRIPTION_DURATION_DAYS = 30     # Длительность подписки в днях
SUBSCRIPTION_PLAN_NAME = "Тариф Старт"
SUBSCRIPTION_DESCRIPTION = "Стартовый тариф с доступом ко всем функциям"
MAX_ASSISTANTS = 3

# Create router
router = APIRouter()

@router.post("/create-payment", response_model=Dict[str, Any])
async def create_payment(
    plan_code: str = "start",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Создание платежа для подписки с ФИКСИРОВАННОЙ ЦЕНОЙ 1490 рублей
    
    Args:
        plan_code: Код тарифного плана (по умолчанию "start")
        current_user: Текущий пользователь
        db: Сессия базы данных
        
    Returns:
        Данные для перенаправления на оплату
    """
    try:
        logger.info(f"🚀 Creating payment for user {current_user.id}, plan {plan_code}")
        
        # ДОБАВЛЕНО: Детальное логирование настроек
        logger.info(f"📋 Payment settings (FIXED PRICE):")
        logger.info(f"   HOST_URL: {settings.HOST_URL}")
        logger.info(f"   ROBOKASSA_MERCHANT_LOGIN: {settings.ROBOKASSA_MERCHANT_LOGIN}")
        logger.info(f"   ROBOKASSA_TEST_MODE: {settings.ROBOKASSA_TEST_MODE}")
        logger.info(f"   FIXED_SUBSCRIPTION_PRICE: {FIXED_SUBSCRIPTION_PRICE} руб")
        
        # ДОБАВЛЕНО: Проверка настроек перед созданием платежа
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
        
        # Проверяем, что у пользователя нет активной подписки (опционально)
        # Можно убрать эту проверку, если разрешаем продление
        logger.info(f"👤 User info: email={current_user.email}, is_trial={current_user.is_trial}")
        
        # Получаем пользователя
        user = db.query(User).filter(User.id == current_user.id).first()
        if not user:
            logger.error(f"❌ User {current_user.id} not found")
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        # Получаем или создаем план (только для записи в БД, цена фиксированная)
        plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == plan_code).first()
        if not plan:
            logger.info(f"📋 Creating subscription plan: {plan_code}")
            plan = SubscriptionPlan(
                code=plan_code,
                name=SUBSCRIPTION_PLAN_NAME,
                price=FIXED_SUBSCRIPTION_PRICE,  # Сохраняем в БД для истории
                max_assistants=MAX_ASSISTANTS,
                description=SUBSCRIPTION_DESCRIPTION,
                is_active=True
            )
            db.add(plan)
            db.flush()
            logger.info(f"✅ Created subscription plan: {plan_code}")
        
        # ✅ ИСПОЛЬЗУЕМ ФИКСИРОВАННУЮ ЦЕНУ (не зависит от БД)
        out_sum = f"{FIXED_SUBSCRIPTION_PRICE:.2f}"  # Всегда 1490.00
        inv_id = f"{int(datetime.now().timestamp())}"
        description = f"Подписка на {SUBSCRIPTION_DURATION_DAYS} дней за {FIXED_SUBSCRIPTION_PRICE:.0f} рублей"
        
        logger.info(f"💳 PAYMENT PARAMETERS (FIXED PRICE):")
        logger.info(f"   out_sum: '{out_sum}' (FIXED: {FIXED_SUBSCRIPTION_PRICE} руб)")
        logger.info(f"   inv_id: '{inv_id}'")
        logger.info(f"   description: '{description}'")
        
        # Создаем запись транзакции
        transaction = PaymentTransaction(
            user_id=user.id,
            plan_id=plan.id,
            external_payment_id=inv_id,
            payment_system="robokassa",
            amount=FIXED_SUBSCRIPTION_PRICE,  # Фиксированная сумма
            currency="RUB",
            status="pending",
            payment_details=f"Plan: {plan_code}, Fixed price: {FIXED_SUBSCRIPTION_PRICE}"
        )
        db.add(transaction)
        db.commit()
        db.refresh(transaction)
        
        logger.info(f"📋 Created payment transaction: {transaction.id}")
        
        # Дополнительные параметры
        custom_params = None
        if not RobokassaService.DISABLE_SHP_PARAMS:
            custom_params = {
                "Shp_user_id": str(current_user.id),
                "Shp_plan_code": plan_code
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
        
        # Добавляем пользовательские параметры только если они не отключены
        if custom_params and not RobokassaService.DISABLE_SHP_PARAMS:
            for key, value in custom_params.items():
                form_params[key] = value
        
        # ✅ ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ ФИНАЛЬНЫХ ПАРАМЕТРОВ
        logger.info(f"📋 FINAL FORM PARAMETERS:")
        for key, value in form_params.items():
            if key == "SignatureValue":
                logger.info(f"   {key}: '{value}'")
            else:
                logger.info(f"   {key}: '{value}'")
        
        logger.info(f"✅ Payment created with FIXED PRICE: {FIXED_SUBSCRIPTION_PRICE} rubles")
        
        # Логируем в базу
        await SubscriptionService.log_subscription_event(
            db=db,
            user_id=str(current_user.id),
            action="payment_started",
            plan_id=str(plan.id),
            plan_code=plan_code,
            details=f"Payment initiated with fixed price: {FIXED_SUBSCRIPTION_PRICE} rubles, inv_id={inv_id}"
        )
        
        return {
            "payment_url": RobokassaService.PAYMENT_URL,
            "form_params": form_params,
            "inv_id": inv_id,
            "amount": out_sum,
            "transaction_id": str(transaction.id),
            "fixed_price": FIXED_SUBSCRIPTION_PRICE  # Для информации
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

@router.post("/robokassa-result")
async def robokassa_result(
    request: Request,
    db: Session = Depends(get_db),
    OutSum: str = Form(...),
    InvId: str = Form(...),
    SignatureValue: str = Form(...),
    Shp_user_id: Optional[str] = Form(None),
    Shp_plan_code: Optional[str] = Form(None)
):
    """
    Обработка уведомления о результате платежа от Robokassa (ResultURL)
    
    Этот endpoint вызывается Robokassa автоматически при успешной оплате
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
        logger.info(f"   All form data: {form_dict}")
        
        # Обрабатываем результат платежа
        result = await RobokassaService.process_payment_result(db, form_dict)
        
        logger.info(f"✅ Payment result processed: {result}")
        
        # Возвращаем ответ Robokassa
        return HTMLResponse(content=result, status_code=200)
        
    except Exception as e:
        logger.error(f"❌ Error in robokassa_result endpoint: {str(e)}", exc_info=True)
        # В случае ошибки возвращаем FAIL
        return HTMLResponse(content="FAIL", status_code=200)

# ✅ ИСПРАВЛЕНО: Поддержка как GET, так и POST для Success URL
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
    
    Сюда перенаправляется пользователь после успешной оплаты
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
        logger.info(f"   SignatureValue: {SignatureValue[:10] if SignatureValue else None}...")
        
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

# ✅ ИСПРАВЛЕНО: Поддержка как GET, так и POST для Cancel URL
@router.get("/cancel", response_class=HTMLResponse)
@router.post("/cancel", response_class=HTMLResponse) 
async def payment_cancel(
    request: Request,
    OutSum: Optional[str] = None,
    InvId: Optional[str] = None
):
    """
    Страница отмены оплаты (FailURL)
    
    Сюда перенаправляется пользователь при отмене или неуспешной оплате
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
# ДИАГНОСТИЧЕСКИЕ ЭНДПОИНТЫ для отладки проблем с Robokassa
# =============================================================================

@router.get("/debug-prices")
async def debug_subscription_prices(db: Session = Depends(get_db)):
    """
    🔍 ДИАГНОСТИЧЕСКИЙ endpoint для проверки цен подписок
    """
    try:
        plans = db.query(SubscriptionPlan).all()
        result = {
            "fixed_price_config": {
                "FIXED_SUBSCRIPTION_PRICE": FIXED_SUBSCRIPTION_PRICE,
                "SUBSCRIPTION_DURATION_DAYS": SUBSCRIPTION_DURATION_DAYS,
                "SUBSCRIPTION_PLAN_NAME": SUBSCRIPTION_PLAN_NAME,
                "MAX_ASSISTANTS": MAX_ASSISTANTS
            },
            "database_plans": {}
        }
        
        for plan in plans:
            result["database_plans"][plan.code] = {
                "name": plan.name,
                "price": float(plan.price),
                "max_assistants": plan.max_assistants,
                "is_active": plan.is_active,
                "created_at": plan.created_at.isoformat() if plan.created_at else None
            }
        
        logger.info(f"🔍 Debug prices requested - fixed: {FIXED_SUBSCRIPTION_PRICE}, db plans: {len(plans)}")
        return result
        
    except Exception as e:
        logger.error(f"❌ Error in debug_subscription_prices: {str(e)}")
        return {
            "error": str(e),
            "fixed_price_config": {
                "FIXED_SUBSCRIPTION_PRICE": FIXED_SUBSCRIPTION_PRICE,
                "SUBSCRIPTION_DURATION_DAYS": SUBSCRIPTION_DURATION_DAYS
            }
        }

@router.get("/config-check")
async def check_robokassa_config():
    """
    🔍 ДИАГНОСТИЧЕСКИЙ endpoint для проверки конфигурации Robokassa
    Помогает диагностировать ошибку 29 и другие проблемы конфигурации
    """
    try:
        from backend.services.payment_service import RobokassaService
        
        # Получаем результаты проверки конфигурации
        config_check = RobokassaService.validate_configuration()
        
        logger.info(f"🔍 Configuration check requested")
        logger.info(f"   Valid: {config_check['valid']}")
        logger.info(f"   Issues: {config_check['issues']}")
        logger.info(f"   Warnings: {config_check['warnings']}")
        
        # Возвращаем результат (скрываем чувствительную информацию)
        return {
            "status": "ok" if config_check["valid"] else "error",
            "valid": config_check["valid"],
            "issues": config_check["issues"],
            "warnings": config_check["warnings"],
            "fixed_price": FIXED_SUBSCRIPTION_PRICE,
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
            ],
            "help_links": [
                "https://auth.robokassa.ru/ - Личный кабинет Robokassa",
                "https://docs.robokassa.ru/ - Документация",
                "https://robokassa.com/content/tipichnye-oshibki.html - Типичные ошибки"
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
    Помогает отладить проблемы с подписью при ошибке 29
    """
    try:
        from backend.services.payment_service import RobokassaService
        
        # Получаем параметры из запроса
        merchant_login = request.get("merchant_login", RobokassaService.MERCHANT_LOGIN)
        out_sum = request.get("out_sum", f"{FIXED_SUBSCRIPTION_PRICE:.2f}")  # Используем фиксированную цену
        inv_id = request.get("inv_id", "123456789")
        password = request.get("password", RobokassaService.PASSWORD_1)
        custom_params = request.get("custom_params", {"Shp_user_id": "test", "Shp_plan_code": "start"})
        
        logger.info(f"🔧 Testing signature generation")
        logger.info(f"   merchant_login: '{merchant_login}'")
        logger.info(f"   out_sum: '{out_sum}' (fixed price: {FIXED_SUBSCRIPTION_PRICE})")
        logger.info(f"   inv_id: '{inv_id}'")
        logger.info(f"   custom_params: {custom_params}")
        
        # Генерируем подпись
        signature = RobokassaService.generate_signature(
            merchant_login=merchant_login,
            out_sum=out_sum,
            inv_id=inv_id,
            password=password,
            custom_params=custom_params
        )
        
        # Формируем строку для подписи вручную для проверки
        sign_string = f"{merchant_login}:{out_sum}:{inv_id}:{password}"
        if custom_params and not RobokassaService.DISABLE_SHP_PARAMS:
            sorted_params = sorted(custom_params.items())
            for key, value in sorted_params:
                sign_string += f":{key}={value}"
        
        return {
            "status": "ok",
            "signature": signature,
            "sign_string": sign_string,
            "fixed_price": FIXED_SUBSCRIPTION_PRICE,
            "parameters": {
                "merchant_login": merchant_login,
                "out_sum": out_sum,
                "inv_id": inv_id,
                "password_length": len(password),
                "custom_params": custom_params
            },
            "debug_info": {
                "sign_string_length": len(sign_string),
                "signature_length": len(signature),
                "disable_shp_params": RobokassaService.DISABLE_SHP_PARAMS
            }
        }
        
    except Exception as e:
        logger.error(f"❌ Error testing signature: {str(e)}")
        return {
            "status": "error",
            "error": str(e),
            "message": "Ошибка при тестировании подписи"
        }

@router.post("/enable-diagnostic-mode")
async def enable_diagnostic_mode():
    """
    🔧 ДИАГНОСТИЧЕСКИЙ endpoint для включения режима без Shp_ параметров
    Помогает протестировать платеж без дополнительных параметров при ошибке 29
    """
    try:
        from backend.services.payment_service import RobokassaService
        
        # Включаем диагностический режим
        RobokassaService.DISABLE_SHP_PARAMS = True
        
        logger.info(f"🔧 Diagnostic mode enabled: Shp_ parameters disabled")
        
        return {
            "status": "ok",
            "message": "Диагностический режим включен - Shp_ параметры отключены",
            "disable_shp_params": True,
            "fixed_price": FIXED_SUBSCRIPTION_PRICE,
            "instructions": [
                "Попробуйте создать платеж снова",
                "Если ошибка 29 исчезла, проблема в обработке Shp_ параметров",
                "Проверьте формулу генерации подписи для Shp_ параметров",
                "Не забудьте выключить диагностический режим после тестирования"
            ]
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
        
        # Выключаем диагностический режим
        RobokassaService.DISABLE_SHP_PARAMS = False
        
        logger.info(f"🔧 Diagnostic mode disabled: Shp_ parameters enabled")
        
        return {
            "status": "ok",
            "message": "Диагностический режим выключен - Shp_ параметры включены",
            "disable_shp_params": False,
            "fixed_price": FIXED_SUBSCRIPTION_PRICE
        }
        
    except Exception as e:
        logger.error(f"❌ Error disabling diagnostic mode: {str(e)}")
        return {
            "status": "error",
            "error": str(e)
        }

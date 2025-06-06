# backend/api/payments.py

"""
Payment API endpoints for WellcomeAI application.
Handles Robokassa payment integration.
"""

from fastapi import APIRouter, Depends, HTTPException, status, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session
from typing import Optional, Dict, Any
from datetime import datetime, timedelta, timezone

from backend.core.logging import get_logger
from backend.core.dependencies import get_current_user
from backend.core.config import settings
from backend.db.session import get_db
from backend.models.user import User
from backend.models.subscription import SubscriptionPlan
from backend.services.payment_service import RobokassaService
from backend.services.subscription_service import SubscriptionService

logger = get_logger(__name__)

# Create router
router = APIRouter()

@router.post("/create-payment", response_model=Dict[str, Any])
async def create_payment(
    plan_code: str = "start",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Создание платежа для подписки
    
    Args:
        plan_code: Код тарифного плана (по умолчанию "start")
        current_user: Текущий пользователь
        db: Сессия базы данных
        
    Returns:
        Данные для перенаправления на оплату
    """
    try:
        # Проверяем, что пользователь не имеет активной подписки
        # (можно убрать эту проверку, если разрешаем продление)
        
        # Создаем платеж
        payment_data = await RobokassaService.create_payment(
            db=db,
            user_id=str(current_user.id),
            plan_code=plan_code
        )
        
        logger.info(f"Payment created for user {current_user.id}, plan {plan_code}")
        
        return payment_data
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in create_payment endpoint: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create payment"
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
        
        logger.info(f"Received Robokassa result notification: {form_dict}")
        
        # Обрабатываем результат платежа
        result = await RobokassaService.process_payment_result(db, form_dict)
        
        logger.info(f"Payment result processed: {result}")
        
        # Возвращаем ответ Robokassa
        return HTMLResponse(content=result, status_code=200)
        
    except Exception as e:
        logger.error(f"Error in robokassa_result endpoint: {str(e)}")
        # В случае ошибки возвращаем FAIL
        return HTMLResponse(content="FAIL", status_code=200)

@router.get("/success", response_class=HTMLResponse)
async def payment_success(
    OutSum: Optional[str] = None,
    InvId: Optional[str] = None,
    SignatureValue: Optional[str] = None
):
    """
    Страница успешной оплаты (SuccessURL)
    
    Сюда перенаправляется пользователь после успешной оплаты
    """
    try:
        logger.info(f"User redirected to success page. InvId: {InvId}, OutSum: {OutSum}")
        
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
        logger.error(f"Error in payment_success endpoint: {str(e)}")
        return HTMLResponse(content="<h1>Произошла ошибка</h1>", status_code=500)

@router.get("/cancel", response_class=HTMLResponse)
async def payment_cancel(
    OutSum: Optional[str] = None,
    InvId: Optional[str] = None
):
    """
    Страница отмены оплаты (FailURL)
    
    Сюда перенаправляется пользователь при отмене или неуспешной оплате
    """
    try:
        logger.info(f"User redirected to cancel page. InvId: {InvId}, OutSum: {OutSum}")
        
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
        logger.error(f"Error in payment_cancel endpoint: {str(e)}")
        return HTMLResponse(content="<h1>Произошла ошибка</h1>", status_code=500)

@router.get("/status/{user_id}")
async def get_payment_status(
    user_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получение статуса платежа/подписки пользователя
    
    Args:
        user_id: ID пользователя
        current_user: Текущий пользователь
        db: Сессия базы данных
        
    Returns:
        Статус подписки пользователя
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
        logger.error(f"Error in get_payment_status endpoint: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get payment status"
        )

# 🧪 ТЕСТОВЫЙ ENDPOINT - ТОЛЬКО ДЛЯ РАЗРАБОТКИ
@router.post("/test-payment-success")
async def test_payment_success(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    🧪 ТОЛЬКО ДЛЯ ТЕСТИРОВАНИЯ: симулирует успешную оплату
    
    Этот endpoint позволяет быстро протестировать обновление подписки
    без реального платежа. Работает только в режиме отладки.
    """
    if not settings.DEBUG:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Доступно только в режиме отладки"
        )
    
    try:
        logger.info(f"🧪 Processing test payment for user {current_user.id}")
        
        # Получаем или создаем план "start"
        plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == "start").first()
        if not plan:
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
        
        # Обновляем подписку пользователя
        now = datetime.now(timezone.utc)
        
        # Если у пользователя уже есть активная подписка, продлеваем от её окончания
        start_date = now
        if current_user.subscription_end_date and current_user.subscription_end_date > now:
            start_date = current_user.subscription_end_date
        
        current_user.subscription_start_date = start_date
        current_user.subscription_end_date = start_date + timedelta(days=settings.SUBSCRIPTION_DURATION_DAYS)
        current_user.subscription_plan_id = plan.id
        current_user.is_trial = False  # Больше не триал
        
        db.commit()
        db.refresh(current_user)
        
        # Логируем событие через SubscriptionService
        await SubscriptionService.log_subscription_event(
            db=db,
            user_id=str(current_user.id),
            action="test_payment_success",
            plan_id=str(plan.id),
            plan_code="start",
            details=f"🧪 Тестовая оплата. Подписка продлена до {current_user.subscription_end_date.strftime('%Y-%m-%d')}"
        )
        
        logger.info(f"✅ Test payment processed successfully for user {current_user.id}")
        
        return {
            "success": True,
            "message": "🧪 Тестовая оплата успешно обработана",
            "subscription": {
                "plan": plan.name,
                "start_date": current_user.subscription_start_date.isoformat(),
                "end_date": current_user.subscription_end_date.isoformat(),
                "days_total": settings.SUBSCRIPTION_DURATION_DAYS,
                "is_trial": current_user.is_trial
            }
        }
        
    except Exception as e:
        db.rollback()
        logger.error(f"❌ Error in test payment: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Ошибка при обработке тестовой оплаты: {str(e)}"
        )

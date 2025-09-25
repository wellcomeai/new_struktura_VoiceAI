# backend/services/partner_service.py - НОВЫЙ файл
"""
Partner service for WellcomeAI application.
Сервис партнерской программы без изменения существующих таблиц.
"""

import secrets
import string
from datetime import datetime, timezone
from typing import Dict, Any, Optional, List
from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func

from backend.core.logging import get_logger
from backend.core.config import settings
from backend.models.user import User
from backend.models.partner import Partner, ReferralRelationship, PartnerCommission
from backend.models.subscription import PaymentTransaction
from backend.services.subscription_service import SubscriptionService

logger = get_logger(__name__)

class PartnerService:
    """Сервис для работы с партнерской программой"""
    
    COMMISSION_RATE = 30.00  # 30% комиссии
    
    @staticmethod
    async def activate_partnership(db: Session, user_id: str) -> Dict[str, Any]:
        """
        Активация партнерства для пользователя
        """
        try:
            # Проверяем существование пользователя
            user = db.query(User).filter(User.id == user_id).first()
            if not user:
                raise HTTPException(404, "User not found")
            
            # Проверяем, уже ли партнер
            existing_partner = db.query(Partner).filter(Partner.user_id == user.id).first()
            if existing_partner:
                return {
                    "success": True,
                    "already_partner": True,
                    "referral_code": existing_partner.referral_code,
                    "referral_link": PartnerService._generate_referral_link(existing_partner.referral_code),
                    "commission_rate": float(existing_partner.commission_rate)
                }
            
            # Генерируем уникальный код
            referral_code = PartnerService._generate_unique_referral_code(db)
            
            # Создаем партнера
            partner = Partner(
                user_id=user.id,
                referral_code=referral_code,
                commission_rate=PartnerService.COMMISSION_RATE,
                is_active=True
            )
            
            db.add(partner)
            db.commit()
            db.refresh(partner)
            
            logger.info(f"✅ Partnership activated for user {user_id} with code {referral_code}")
            
            return {
                "success": True,
                "referral_code": referral_code,
                "referral_link": PartnerService._generate_referral_link(referral_code),
                "commission_rate": float(partner.commission_rate),
                "activated_at": partner.activated_at
            }
            
        except Exception as e:
            db.rollback()
            logger.error(f"❌ Error activating partnership: {str(e)}")
            raise HTTPException(500, f"Failed to activate partnership: {str(e)}")
    
    @staticmethod
    def _generate_unique_referral_code(db: Session) -> str:
        """Генерация уникального реферального кода"""
        max_attempts = 100
        
        for _ in range(max_attempts):
            # Генерируем код: 2 буквы + 6 цифр
            letters = ''.join(secrets.choice(string.ascii_uppercase) for _ in range(2))
            numbers = ''.join(secrets.choice(string.digits) for _ in range(6))
            code = letters + numbers
            
            # Проверяем уникальность
            existing = db.query(Partner).filter(Partner.referral_code == code).first()
            if not existing:
                return code
        
        raise Exception("Failed to generate unique referral code")
    
    @staticmethod
    def _generate_referral_link(referral_code: str) -> str:
        """Генерация полной реферальной ссылки с UTM метками"""
        base_url = settings.HOST_URL.rstrip('/')
        utm_params = [
            f"utm_source=partner",
            f"utm_medium=referral", 
            f"utm_campaign={referral_code}",
            f"utm_content=registration"
        ]
        return f"{base_url}/register?{'&'.join(utm_params)}"
    
    @staticmethod
    async def process_referral_registration(
        db: Session, 
        new_user_id: str, 
        referral_code: str,
        utm_data: Optional[Dict[str, str]] = None
    ) -> bool:
        """
        Обработка регистрации по реферальной ссылке
        """
        try:
            # Находим партнера по коду
            partner = db.query(Partner).filter(
                Partner.referral_code == referral_code.upper(),
                Partner.is_active == True
            ).first()
            
            if not partner:
                logger.warning(f"❌ Invalid referral code: {referral_code}")
                return False
            
            # Проверяем, что пользователь еще не привязан
            existing_relationship = db.query(ReferralRelationship).filter(
                ReferralRelationship.referral_user_id == new_user_id
            ).first()
            
            if existing_relationship:
                logger.warning(f"❌ User {new_user_id} already has referral relationship")
                return False
            
            # Создаем связь реферер-реферал
            relationship = ReferralRelationship(
                partner_id=partner.id,
                referral_user_id=new_user_id,
                utm_source=utm_data.get('utm_source') if utm_data else 'partner',
                utm_medium=utm_data.get('utm_medium') if utm_data else 'referral',
                utm_campaign=utm_data.get('utm_campaign') if utm_data else referral_code,
                utm_content=utm_data.get('utm_content') if utm_data else 'registration'
            )
            
            # Обновляем счетчик рефералов
            partner.total_referrals += 1
            
            db.add(relationship)
            db.commit()
            
            logger.info(f"✅ Referral relationship created: partner {partner.id} -> user {new_user_id}")
            
            return True
            
        except Exception as e:
            db.rollback()
            logger.error(f"❌ Error processing referral registration: {str(e)}")
            return False
    
    @staticmethod
    async def process_referral_payment(
        db: Session,
        user_id: str,
        transaction: PaymentTransaction,
        amount: float
    ):
        """
        Обработка платежа реферала и начисление комиссии
        """
        try:
            # Ищем реферальную связь
            referral_relationship = db.query(ReferralRelationship).filter(
                ReferralRelationship.referral_user_id == user_id,
                ReferralRelationship.is_active == True
            ).first()
            
            if not referral_relationship:
                logger.info(f"No referral relationship found for user {user_id}")
                return
            
            # Получаем партнера
            partner = referral_relationship.partner
            if not partner or not partner.is_active:
                logger.warning(f"Partner {partner.id if partner else 'None'} is not active")
                return
            
            # Проверяем, не начислялась ли уже комиссия за эту транзакцию
            existing_commission = db.query(PartnerCommission).filter(
                PartnerCommission.payment_transaction_id == transaction.id
            ).first()
            
            if existing_commission:
                logger.warning(f"Commission already exists for transaction {transaction.id}")
                return
            
            # Вычисляем комиссию
            commission_amount = (amount * float(partner.commission_rate)) / 100
            
            # Создаем запись о комиссии
            commission = PartnerCommission(
                partner_id=partner.id,
                referral_relationship_id=referral_relationship.id,
                payment_transaction_id=transaction.id,
                original_amount=amount,
                commission_rate=partner.commission_rate,
                commission_amount=commission_amount,
                status="confirmed",
                confirmed_at=datetime.now(timezone.utc)
            )
            
            # Обновляем статистику партнера
            partner.total_earnings += commission_amount
            
            # Отмечаем первый платеж реферала
            if not referral_relationship.first_payment_made:
                referral_relationship.first_payment_made = True
                referral_relationship.first_payment_at = datetime.now(timezone.utc)
            
            db.add(commission)
            db.commit()
            
            logger.info(f"✅ Partner commission processed: {commission_amount}₽ for partner {partner.id}")
            
            # Логируем событие
            await SubscriptionService.log_subscription_event(
                db=db,
                user_id=str(partner.user_id),
                action="partner_commission_earned",
                plan_id=None,
                plan_code="commission",
                details=f"Earned {commission_amount}₽ commission from referral payment {amount}₽ (transaction: {transaction.id})"
            )
            
        except Exception as e:
            db.rollback()
            logger.error(f"❌ Error processing partner commission: {str(e)}")
    
    @staticmethod
    async def get_partner_stats(db: Session, user_id: str) -> Dict[str, Any]:
        """
        Получение статистики партнера
        """
        try:
            # Получаем партнера
            partner = db.query(Partner).filter(Partner.user_id == user_id).first()
            if not partner:
                raise HTTPException(404, "Partnership not found")
            
            # Базовая статистика
            total_referrals = db.query(ReferralRelationship).filter(
                ReferralRelationship.partner_id == partner.id,
                ReferralRelationship.is_active == True
            ).count()
            
            # Статистика по платежам
            paid_referrals = db.query(ReferralRelationship).filter(
                ReferralRelationship.partner_id == partner.id,
                ReferralRelationship.first_payment_made == True
            ).count()
            
            # Общие заработки
            total_earnings = db.query(func.sum(PartnerCommission.commission_amount)).filter(
                PartnerCommission.partner_id == partner.id,
                PartnerCommission.status.in_(["confirmed", "paid"])
            ).scalar() or 0
            
            # Заработки в этом месяце
            from datetime import datetime
            current_month_start = datetime.now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            this_month_earnings = db.query(func.sum(PartnerCommission.commission_amount)).filter(
                PartnerCommission.partner_id == partner.id,
                PartnerCommission.earned_at >= current_month_start,
                PartnerCommission.status.in_(["confirmed", "paid"])
            ).scalar() or 0
            
            # Последние комиссии
            recent_commissions = db.query(PartnerCommission).filter(
                PartnerCommission.partner_id == partner.id
            ).order_by(PartnerCommission.earned_at.desc()).limit(10).all()
            
            return {
                "partner_info": {
                    "referral_code": partner.referral_code,
                    "referral_link": PartnerService._generate_referral_link(partner.referral_code),
                    "commission_rate": float(partner.commission_rate),
                    "is_active": partner.is_active,
                    "activated_at": partner.activated_at
                },
                "statistics": {
                    "total_referrals": total_referrals,
                    "paid_referrals": paid_referrals,
                    "conversion_rate": round((paid_referrals / total_referrals * 100) if total_referrals > 0 else 0, 2),
                    "total_earnings": float(total_earnings),
                    "this_month_earnings": float(this_month_earnings)
                },
                "recent_commissions": [
                    {
                        "id": str(comm.id),
                        "amount": float(comm.commission_amount),
                        "original_payment": float(comm.original_amount),
                        "status": comm.status,
                        "earned_at": comm.earned_at,
                        "referral_user": {
                            "email": comm.referral_relationship.referral_user.email
                        } if comm.referral_relationship and comm.referral_relationship.referral_user else None
                    }
                    for comm in recent_commissions
                ]
            }
            
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"❌ Error getting partner stats: {str(e)}")
            raise HTTPException(500, f"Failed to get partner stats: {str(e)}")

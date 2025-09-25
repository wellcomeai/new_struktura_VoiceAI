# backend/api/partners.py - НОВЫЙ файл
"""
Partner API endpoints for WellcomeAI application.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import Dict, Any, List, Optional

from backend.core.logging import get_logger
from backend.core.dependencies import get_current_user
from backend.db.session import get_db
from backend.models.user import User
from backend.models.partner import Partner, ReferralRelationship
from backend.services.partner_service import PartnerService

logger = get_logger(__name__)

router = APIRouter()

@router.post("/activate")
async def activate_partnership(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Активация партнерской программы для текущего пользователя
    """
    result = await PartnerService.activate_partnership(db, str(current_user.id))
    return result

@router.get("/dashboard")
async def get_partner_dashboard(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получение полной статистики партнера для дашборда
    """
    # Проверяем, является ли пользователь партнером
    partner = db.query(Partner).filter(Partner.user_id == current_user.id).first()
    if not partner:
        raise HTTPException(404, "Partnership not found. Please activate partnership first.")
    
    result = await PartnerService.get_partner_stats(db, str(current_user.id))
    return result

@router.get("/referrals")
async def get_my_referrals(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Получение списка рефералов партнера
    """
    # Проверяем партнерство
    partner = db.query(Partner).filter(Partner.user_id == current_user.id).first()
    if not partner:
        raise HTTPException(404, "Partnership not found")
    
    # Получаем рефералов
    referrals_query = db.query(ReferralRelationship).filter(
        ReferralRelationship.partner_id == partner.id,
        ReferralRelationship.is_active == True
    ).order_by(ReferralRelationship.referred_at.desc())
    
    total_count = referrals_query.count()
    referrals = referrals_query.offset(skip).limit(limit).all()
    
    result = []
    for ref in referrals:
        user = ref.referral_user
        
        # Считаем заработанное с этого реферала
        from sqlalchemy import func
        from backend.models.partner import PartnerCommission
        
        earned_from_referral = db.query(func.sum(PartnerCommission.commission_amount)).filter(
            PartnerCommission.referral_relationship_id == ref.id,
            PartnerCommission.status.in_(["confirmed", "paid"])
        ).scalar() or 0
        
        result.append({
            "id": str(ref.id),
            "referral_user": {
                "id": str(user.id),
                "email": user.email,
                "name": f"{user.first_name or ''} {user.last_name or ''}".strip(),
                "registered_at": user.created_at
            },
            "utm_data": {
                "utm_source": ref.utm_source,
                "utm_medium": ref.utm_medium,
                "utm_campaign": ref.utm_campaign,
                "utm_content": ref.utm_content
            },
            "stats": {
                "referred_at": ref.referred_at,
                "first_payment_made": ref.first_payment_made,
                "first_payment_at": ref.first_payment_at,
                "total_earned": float(earned_from_referral)
            }
        })
    
    return {
        "referrals": result,
        "pagination": {
            "total": total_count,
            "skip": skip,
            "limit": limit,
            "has_more": skip + limit < total_count
        }
    }

@router.get("/check-status")
async def check_partner_status(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Проверка статуса партнерства пользователя
    """
    partner = db.query(Partner).filter(Partner.user_id == current_user.id).first()
    
    if not partner:
        return {
            "is_partner": False,
            "can_activate": True,
            "commission_rate": PartnerService.COMMISSION_RATE
        }
    
    return {
        "is_partner": True,
        "is_active": partner.is_active,
        "referral_code": partner.referral_code,
        "referral_link": PartnerService._generate_referral_link(partner.referral_code),
        "commission_rate": float(partner.commission_rate),
        "activated_at": partner.activated_at,
        "total_referrals": partner.total_referrals,
        "total_earnings": float(partner.total_earnings)
    }

@router.get("/generate-link")
async def generate_referral_link(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Генерация реферальной ссылки (активирует партнерство если нужно)
    """
    partner = db.query(Partner).filter(Partner.user_id == current_user.id).first()
    
    if not partner:
        # Автоматически активируем партнерство
        result = await PartnerService.activate_partnership(db, str(current_user.id))
        return {
            "success": True,
            "auto_activated": True,
            **result
        }
    
    return {
        "success": True,
        "auto_activated": False,
        "referral_code": partner.referral_code,
        "referral_link": PartnerService._generate_referral_link(partner.referral_code),
        "commission_rate": float(partner.commission_rate)
    }

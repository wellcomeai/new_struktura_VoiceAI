"""
Database initialization script for WellcomeAI application.
This script creates initial subscription plans and sets up admin user.
"""

import os
import sys
from pathlib import Path
import asyncio

# Add project root to path
project_root = Path(__file__).parent.parent.absolute()
if str(project_root) not in sys.path:
    sys.path.append(str(project_root))

from backend.db.session import SessionLocal
from backend.models.base import Base, engine
from backend.models.subscription import SubscriptionPlan
from backend.models.user import User
from backend.core.security import hash_password
from backend.services.subscription_service import SubscriptionService
import backend.models  # Import all models for Base.metadata.create_all

async def init_subscription_plans(db):
    """Create initial subscription plans"""
    plans = [
        {
            "name": "Бесплатный пробный период",
            "code": "free",
            "price": 0,
            "max_assistants": 1,
            "description": "Бесплатный пробный период на 3 дня"
        },
        {
            "name": "Старт",
            "code": "start",
            "price": 1990,
            "max_assistants": 3,
            "description": "Тариф 'Старт' - 3 ассистента, все функции"
        }
    ]
    
    for plan_data in plans:
        # Check if plan already exists
        existing_plan = db.query(SubscriptionPlan).filter(SubscriptionPlan.code == plan_data["code"]).first()
        if not existing_plan:
            plan = SubscriptionPlan(**plan_data)
            db.add(plan)
            print(f"Created plan: {plan_data['name']}")
        else:
            print(f"Plan already exists: {plan_data['name']}")
    
    db.commit()

def ensure_admin_user(db):
    """Ensure admin user exists"""
    admin_email = "well96well@gmail.com"
    
    # Check if admin already exists
    admin = db.query(User).filter(User.email == admin_email).first()
    if admin:
        # Ensure admin flag is set
        if not admin.is_admin:
            admin.is_admin = True
            db.commit()
            print(f"Updated admin status for {admin_email}")
        else:
            print(f"Admin user already exists: {admin_email}")
    else:
        print(f"Admin user not found: {admin_email}. Please register with this email to get admin privileges.")

async def main():
    """Main function"""
    print("Creating tables...")
    Base.metadata.create_all(bind=engine)
    
    db = SessionLocal()
    try:
        print("Initializing subscription plans...")
        await init_subscription_plans(db)
        
        print("Ensuring admin user...")
        ensure_admin_user(db)
        
        print("Database initialization completed!")
    finally:
        db.close()

if __name__ == "__main__":
    asyncio.run(main())

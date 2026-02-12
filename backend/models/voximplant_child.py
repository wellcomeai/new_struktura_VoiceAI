"""
Модель дочернего аккаунта Voximplant для партнерской интеграции.

Каждый пользователь платформы может создать свой дочерний аккаунт Voximplant
для использования телефонии. Это требование российского законодательства -
каждый пользователь телефонии должен быть прямым абонентом провайдера.

✅ v1.0: Базовая модель дочернего аккаунта и номеров телефонов
✅ v1.1: Исправлен регистр enum (lowercase)
✅ v1.2: Добавлена поддержка сценариев (vox_scenario_ids) и правил (vox_rule_id)
✅ v1.3: Добавлено поле vox_rule_ids для исходящих звонков (outbound)
✅ v1.4: Добавлено поле enable_background_noise для фоновых шумов офиса
"""

import uuid
import enum
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import (
    Column, String, DateTime, ForeignKey, Boolean, 
    Text, Integer, Enum as SQLEnum, JSON
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship, backref
from sqlalchemy.sql import func

from backend.models.base import Base, BaseModel


class VoximplantVerificationStatus(str, enum.Enum):
    """Статусы верификации аккаунта Voximplant"""
    not_started = "not_started"                      # Не начата
    awaiting_documents = "awaiting_documents"        # Ожидает загрузки документов
    awaiting_agreement = "awaiting_agreement"        # Ожидает загрузки договора
    awaiting_verification = "awaiting_verification"  # На проверке
    verified = "verified"                            # Верифицирован
    rejected = "rejected"                            # Отклонён


class VoximplantChildAccount(Base, BaseModel):
    """
    Дочерний аккаунт Voximplant, привязанный к пользователю платформы.
    
    Создаётся при нажатии "Подключить телефонию" через CloneAccount API.
    Хранит все необходимые данные для управления аккаунтом.
    """
    __tablename__ = "voximplant_child_accounts"
    
    # =========================================================================
    # ОСНОВНЫЕ ИДЕНТИФИКАТОРЫ
    # =========================================================================
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(
        UUID(as_uuid=True), 
        ForeignKey("users.id", ondelete="CASCADE"), 
        nullable=False, 
        unique=True,
        index=True
    )
    
    # =========================================================================
    # ДАННЫЕ АККАУНТА VOXIMPLANT
    # =========================================================================
    
    # Основные данные аккаунта
    vox_account_id = Column(String(50), nullable=False, unique=True, index=True)
    vox_account_name = Column(String(255), nullable=False)
    vox_account_email = Column(String(255), nullable=False)
    vox_api_key = Column(String(255), nullable=False)  # API ключ дочернего аккаунта
    
    # Service Account для управления дочкой (более безопасно чем главный ключ)
    vox_service_account_id = Column(String(50), nullable=True)
    vox_service_account_key = Column(Text, nullable=True)
    
    # Данные SubUser для верификации/биллинга
    vox_subuser_login = Column(String(255), nullable=True)
    vox_subuser_password = Column(String(255), nullable=True)  # TODO: Зашифровать в проде!
    
    # =========================================================================
    # ПРИЛОЖЕНИЕ И СЦЕНАРИИ VOXIMPLANT
    # =========================================================================
    
    # ID приложения на дочернем аккаунте
    vox_application_id = Column(String(50), nullable=True)
    vox_application_name = Column(String(255), nullable=True)
    
    # Маппинг сценариев: {"inbound_gemini": 123, "inbound_openai": 124, "outbound_gemini": 125, ...}
    # Хранит ID сценариев, созданных на дочернем аккаунте
    vox_scenario_ids = Column(JSON, nullable=True, default=dict)
    
    # =========================================================================
    # 🆕 v1.3: ПРАВИЛА МАРШРУТИЗАЦИИ ДЛЯ ИСХОДЯЩИХ ЗВОНКОВ
    # =========================================================================
    
    # Маппинг правил для исходящих: {"outbound_openai": 789, "outbound_gemini": 790}
    # Rule ID нужен для запуска сценария через StartScenarios API
    # Для входящих звонков rule_id хранится в VoximplantPhoneNumber.vox_rule_id
    vox_rule_ids = Column(JSON, nullable=True, default=dict)
    
    # Устаревшее поле - правила теперь на уровне номеров (для inbound) 
    # и в vox_rule_ids (для outbound)
    vox_rule_id = Column(String(50), nullable=True)
    
    # =========================================================================
    # СТАТУСЫ
    # =========================================================================
    
    verification_status = Column(
        SQLEnum(VoximplantVerificationStatus, name='voximplant_verification_status'),
        default=VoximplantVerificationStatus.not_started,  # ✅ lowercase
        nullable=False
    )
    is_active = Column(Boolean, default=True, nullable=False)
    
    # =========================================================================
    # ВРЕМЕННЫЕ МЕТКИ
    # =========================================================================
    
    created_at = Column(
        DateTime(timezone=True), 
        server_default=func.now(), 
        nullable=False
    )
    updated_at = Column(
        DateTime(timezone=True), 
        onupdate=func.now()
    )
    verified_at = Column(DateTime(timezone=True), nullable=True)
    
    # =========================================================================
    # СВЯЗИ
    # =========================================================================
    
    # Связь с пользователем
    user = relationship("User", backref=backref("voximplant_child_account", uselist=False))
    
    # Связь с номерами
    phone_numbers = relationship(
        "VoximplantPhoneNumber", 
        back_populates="child_account", 
        cascade="all, delete-orphan"
    )
    
    # =========================================================================
    # МЕТОДЫ
    # =========================================================================
    
    def __repr__(self):
        return f"<VoximplantChildAccount {self.vox_account_name} (user={self.user_id})>"
    
    @property
    def is_verified(self) -> bool:
        """Проверяет, верифицирован ли аккаунт"""
        return self.verification_status == VoximplantVerificationStatus.verified  # ✅ lowercase
    
    @property
    def can_buy_numbers(self) -> bool:
        """Может ли аккаунт покупать номера"""
        return self.is_verified and self.is_active
    
    @property
    def can_make_outbound_calls(self) -> bool:
        """
        Может ли аккаунт совершать исходящие звонки.
        
        Требуется:
        - Верифицированный аккаунт
        - Наличие хотя бы одного купленного номера (для caller_id)
        - Наличие outbound rules
        """
        return (
            self.is_verified 
            and self.is_active 
            and self.phone_numbers 
            and len(self.phone_numbers) > 0
            and self.vox_rule_ids
            and len(self.vox_rule_ids) > 0
        )
    
    def get_scenario_id(self, scenario_name: str) -> Optional[int]:
        """Получить ID сценария по имени"""
        if self.vox_scenario_ids:
            return self.vox_scenario_ids.get(scenario_name)
        return None
    
    def get_inbound_scenario_id(self, assistant_type: str) -> Optional[int]:
        """
        Получить ID входящего сценария для типа ассистента.
        
        Args:
            assistant_type: 'gemini', 'openai', или 'yandex'
        """
        scenario_name = f"inbound_{assistant_type}"
        return self.get_scenario_id(scenario_name)
    
    def get_outbound_scenario_id(self, assistant_type: str) -> Optional[int]:
        """
        Получить ID исходящего сценария для типа ассистента.
        
        Args:
            assistant_type: 'gemini', 'openai', 'yandex', или 'crm'
        """
        scenario_name = f"outbound_{assistant_type}"
        return self.get_scenario_id(scenario_name)
    
    def get_rule_id(self, rule_name: str) -> Optional[int]:
        """
        🆕 v1.3: Получить ID правила по имени.
        
        Args:
            rule_name: Имя правила (например, 'outbound_openai', 'outbound_gemini')
            
        Returns:
            ID правила или None
        """
        if self.vox_rule_ids:
            return self.vox_rule_ids.get(rule_name)
        return None
    
    def get_outbound_rule_id(self, assistant_type: str) -> Optional[int]:
        """
        🆕 v1.3: Получить ID правила для исходящего сценария.
        
        Args:
            assistant_type: 'gemini', 'openai', 'yandex', или 'crm'
            
        Returns:
            ID правила для запуска через StartScenarios API
        """
        rule_name = f"outbound_{assistant_type}"
        return self.get_rule_id(rule_name)
    
    def set_outbound_rule_id(self, assistant_type: str, rule_id: int) -> None:
        """
        🆕 v1.3: Установить ID правила для исходящего сценария.
        
        Args:
            assistant_type: 'gemini', 'openai', etc.
            rule_id: ID правила в Voximplant
        """
        if self.vox_rule_ids is None:
            self.vox_rule_ids = {}
        
        rule_name = f"outbound_{assistant_type}"
        self.vox_rule_ids[rule_name] = rule_id
    
    def to_dict(self):
        """Преобразовать в словарь, исключая конфиденциальные поля"""
        data = super().to_dict()
        
        # Удаляем конфиденциальные данные
        data.pop("vox_api_key", None)
        data.pop("vox_service_account_key", None)
        data.pop("vox_subuser_password", None)
        
        # Преобразуем UUID в строку
        if isinstance(data.get("id"), uuid.UUID):
            data["id"] = str(data["id"])
        if isinstance(data.get("user_id"), uuid.UUID):
            data["user_id"] = str(data["user_id"])
        
        # Преобразуем Enum в строку
        if data.get("verification_status"):
            data["verification_status"] = data["verification_status"].value
            
        return data


class VoximplantPhoneNumber(Base, BaseModel):
    """
    Телефонный номер, купленный на дочернем аккаунте.
    
    Номер привязывается к конкретному ассистенту (OpenAI или Gemini).
    При входящем звонке на номер сценарий получает конфиг ассистента.
    """
    __tablename__ = "voximplant_phone_numbers"
    
    # =========================================================================
    # ОСНОВНЫЕ ИДЕНТИФИКАТОРЫ
    # =========================================================================
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    child_account_id = Column(
        UUID(as_uuid=True), 
        ForeignKey("voximplant_child_accounts.id", ondelete="CASCADE"), 
        nullable=False,
        index=True
    )
    
    # =========================================================================
    # ДАННЫЕ НОМЕРА
    # =========================================================================
    
    phone_number = Column(String(20), nullable=False, unique=True, index=True)  # E.164 формат
    phone_number_id = Column(String(50), nullable=False)  # ID в Voximplant
    phone_region = Column(String(100), nullable=True)  # Регион номера
    
    # =========================================================================
    # ПРИВЯЗКА К АССИСТЕНТУ
    # =========================================================================
    
    assistant_type = Column(String(20), nullable=True)  # 'openai', 'gemini', 'yandex'
    assistant_id = Column(UUID(as_uuid=True), nullable=True)  # ID ассистента в нашей БД
    
    # =========================================================================
    # ПРАВИЛО МАРШРУТИЗАЦИИ VOXIMPLANT (для входящих звонков)
    # =========================================================================
    
    # ID правила в Voximplant (связывает номер со сценарием для INBOUND)
    # Для исходящих звонков rule_id хранится в VoximplantChildAccount.vox_rule_ids
    vox_rule_id = Column(String(50), nullable=True)
    
    # =========================================================================
    # НАСТРОЙКИ ДЛЯ ЗВОНКОВ
    # =========================================================================
    
    first_phrase = Column(Text, nullable=True)  # Первая фраза ассистента
    caller_id = Column(String(20), nullable=True)  # CallerID для исходящих
    
    # =========================================================================
    # 🆕 v1.4: ФОНОВЫЕ ШУМЫ
    # =========================================================================
    
    # Включение фонового шума офиса при звонке
    # Если True — сценарий использует Conference для микширования аудио
    # с фоновым шумом офиса. Если False — прямое соединение без шума.
    enable_background_noise = Column(Boolean, default=False, nullable=False)
    
    # =========================================================================
    # СТАТУС
    # =========================================================================
    
    is_active = Column(Boolean, default=True, nullable=False)
    
    # =========================================================================
    # ВРЕМЕННЫЕ МЕТКИ
    # =========================================================================
    
    purchased_at = Column(
        DateTime(timezone=True), 
        server_default=func.now(), 
        nullable=False
    )
    expires_at = Column(DateTime(timezone=True), nullable=True)  # Дата окончания аренды
    
    # =========================================================================
    # СВЯЗИ
    # =========================================================================
    
    child_account = relationship("VoximplantChildAccount", back_populates="phone_numbers")
    
    # =========================================================================
    # МЕТОДЫ
    # =========================================================================
    
    def __repr__(self):
        return f"<VoximplantPhoneNumber {self.phone_number}>"
    
    @property
    def can_be_caller_id(self) -> bool:
        """Может ли номер использоваться как Caller ID для исходящих"""
        return self.is_active
    
    def to_dict(self):
        """Преобразовать в словарь"""
        data = super().to_dict()
        
        # Преобразуем UUID в строку
        if isinstance(data.get("id"), uuid.UUID):
            data["id"] = str(data["id"])
        if isinstance(data.get("child_account_id"), uuid.UUID):
            data["child_account_id"] = str(data["child_account_id"])
        if isinstance(data.get("assistant_id"), uuid.UUID):
            data["assistant_id"] = str(data["assistant_id"])
            
        return data

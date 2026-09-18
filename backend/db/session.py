# backend/db/session.py

import os
from typing import Generator

from sqlalchemy import create_engine, text
from sqlalchemy.exc import InterfaceError, OperationalError
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import NullPool

from backend.core.config import settings
from backend.core.logging import get_logger

logger = get_logger(__name__)

# Build the database URL
DATABASE_URL = os.getenv("DATABASE_URL", settings.DATABASE_URL)
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL environment variable is not set")

# Пул соединений. Раньше стоял NullPool: каждый Depends(get_db) открывал новое
# TCP+TLS соединение к Postgres (20-60 мс на запрос, у части эндпоинтов 2-3 раза).
# pool_size держится постоянно, max_overflow открывается по требованию и закрывается
# при возврате, поэтому долгие голосовые сессии не упираются в лимит.
DB_POOL_SIZE = int(os.getenv("DB_POOL_SIZE", "5"))
DB_MAX_OVERFLOW = int(os.getenv("DB_MAX_OVERFLOW", "25"))
DB_POOL_RECYCLE = int(os.getenv("DB_POOL_RECYCLE", "1800"))
# Сколько ждать свободное соединение из пула. Прод работает одним процессом с одним
# event loop, а запросы к БД синхронные: каждая секунда ожидания здесь — секунда,
# на которую замирает весь сервер (звонки, виджеты, /health). Поэтому коротко.
DB_POOL_TIMEOUT = int(os.getenv("DB_POOL_TIMEOUT", "10"))
# Таймаут установки TCP+TLS соединения с Postgres. Без него psycopg2 при недоступной
# базе висит до системного TCP-таймаута (минуты), и сервер не отвечает, пока его не
# перезапустят руками.
DB_CONNECT_TIMEOUT = int(os.getenv("DB_CONNECT_TIMEOUT", "5"))

# TCP keepalive: соединение, которое база или сеть оборвали молча (SSL SYSCALL error:
# EOF detected), обнаруживается за ~1 минуту, а не при следующем запросе через полчаса.
CONNECT_ARGS = {
    "sslmode": "require",                            # Adjust sslmode as needed (e.g. 'disable' in dev)
    "connect_timeout": DB_CONNECT_TIMEOUT,
    "keepalives": 1,
    "keepalives_idle": 30,
    "keepalives_interval": 10,
    "keepalives_count": 3,
}

try:
    engine = create_engine(
        DATABASE_URL,
        echo=settings.DEBUG,
        pool_pre_ping=True,                          # Проверка соединения перед выдачей из пула
        pool_size=DB_POOL_SIZE,
        max_overflow=DB_MAX_OVERFLOW,
        pool_timeout=DB_POOL_TIMEOUT,
        pool_recycle=DB_POOL_RECYCLE,                # Переоткрывать соединения старше 30 минут
        connect_args=CONNECT_ARGS,
    )

    # Mask sensitive parts for logging
    database_url_masked = DATABASE_URL.split("@")[-1] if "@" in DATABASE_URL else "database"
    logger.info(f"Database engine created for {database_url_masked}")

except Exception as e:
    logger.error(f"Failed to create database engine: {e}")
    raise

# Configure a session factory
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

def get_db() -> Generator[Session, None, None]:
    """
    FastAPI dependency that yields a database session and ensures it's closed.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Хелперы для долгоживущих соединений (WebSocket голосовых сессий)
# ---------------------------------------------------------------------------

# Ошибки, которые означают «соединение с базой потеряно», а не ошибку в данных:
# обрыв сети, перезапуск Postgres, SSL EOF, could not connect.
DB_CONNECTION_ERRORS = (OperationalError, InterfaceError)


def safe_rollback(db: Session) -> None:
    """rollback, который не бросает исключение на уже мёртвом соединении."""
    try:
        db.rollback()
    except Exception as e:  # noqa: BLE001 — соединение уже потеряно, это ожидаемо
        logger.warning(f"[DB] rollback on a dead connection ignored: {e}")


def release_db_connection(db: Session) -> None:
    """
    Вернуть соединение в пул, не закрывая сессию и не выгружая загруженные объекты.

    Зачем: WebSocket-хендлер голосовой сессии загружает ассистента и пользователя
    в начале, а сессию БД держит до конца звонка. Без commit/rollback SQLAlchemy
    держит соединение из пула всё это время: 30 одновременных звонков — пул пуст,
    а обрыв базы посреди звонка превращает это соединение в мёртвое.

    Что делает: завершает открытую (только читающую) транзакцию через commit, при
    этом отключает expire_on_commit для сессии — иначе следующий доступ к атрибуту
    assistant/user перечитал бы объект из БД и снова занял соединение до конца
    звонка. Следующий запрос через ту же сессию возьмёт соединение из пула заново
    (с pre-ping) и после своего commit снова его отпустит.

    Явный db.refresh(obj) по-прежнему перечитывает объект, если это нужно.
    """
    db.expire_on_commit = False
    try:
        db.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[DB] release_db_connection: commit failed ({e}), rolling back")
        safe_rollback(db)


# ---------------------------------------------------------------------------
# Проверка здоровья базы для /health (Render перезапускает инстанс по нему)
# ---------------------------------------------------------------------------

# Отдельный engine без пула: /health не должен зависеть от того, свободен ли
# основной пул, и не должен занимать в нём соединение. Одно короткое TLS-соединение
# на проверку — Render дёргает /health раз в несколько секунд, это дёшево.
_health_engine = create_engine(
    DATABASE_URL,
    poolclass=NullPool,
    connect_args={**CONNECT_ARGS, "connect_timeout": int(os.getenv("DB_HEALTH_CONNECT_TIMEOUT", "3"))},
)


def check_database_connection() -> None:
    """SELECT 1 через отдельное соединение. Бросает исключение, если база недоступна."""
    with _health_engine.connect() as conn:
        conn.execute(text("SELECT 1"))

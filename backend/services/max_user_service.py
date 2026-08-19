"""
MAX User Service — работа с ЛИЧНЫМ аккаунтом мессенджера MAX (max.ru) агента.

Зеркалит telegram_user_service.py (Telethon), но поверх реверснутой библиотеки
PyMax (pip: maxapi-python): авторизация личного аккаунта (телефон → SMS-код →
пароль 2FA), отправка сообщений клиентам от имени владельца и чтение новых
входящих поллером (backend/core/max_poller.py).

Ключевые решения:
- Сессия PyMax (token/device_id/phone/mt_instance_id/sync-маркеры) живёт в БД
  (agent_max_accounts.session_encrypted), зашифрованная Fernet (MAX_SESSION_KEY).
  Файловых SQLite-сессий нет — ФС Render эфемерная. Вместо файла PyMax получает
  кастомный StoreProtocol (_DbSessionStore) поверх этой колонки.
- Клиент создаётся НА КАЖДУЮ операцию (start → действие → close): вариант B из
  проектного решения — постоянные соединения в 4 gunicorn-воркерах с рециклингом
  не живут. client.start() запускается фоновой задачей, работа идёт после
  события on_start, затем close().
- Авторизация PyMax проходит ВНУТРИ client.start() (SmsAuthFlow), поэтому шаги
  «ввести код/пароль» реализованы DB-провайдерами: фоновая задача run_auth ждёт,
  пока UI положит значение в транзитные колонки sms_code/password_2fa.
- Совместимость с websockets<12: проект пинит websockets 11 (голосовые прокси
  используют extra_headers), а pymax на импорте тянет websockets.asyncio (>=13)
  — но только ради WebClient, который здесь не используется (TCP Client).
  _ensure_ws_compat() подкладывает заглушки, WebClient при попытке использования
  упадёт с понятной ошибкой. Ставить maxapi-python нужно с --no-deps
  (см. requirements-max.txt).
- Все ошибки PyMax конвертируются в {ok: False, error: <код>} — коды маппятся
  на человекочитаемые сообщения в UI и тулзах (error_human).

Анти-бан: userbot нарушает ToS MAX. Лимиты (MAX_SEND_HOURLY_LIMIT,
MAX_PHONE_RESOLVE_HOURLY_LIMIT) проверяются в agent_tools по данным БД;
использовать только выделенные номера с согласия владельца.
"""

import asyncio
import json
from datetime import datetime
from typing import Any, Dict, List, Optional

from backend.core.logging import get_logger
from backend.core.config import settings

logger = get_logger(__name__)

# Лимиты безопасности (анти-бан). Проверяются в agent_tools по данным БД.
MAX_SEND_HOURLY_LIMIT = 30          # исходящих сообщений с аккаунта в час
MAX_PHONE_RESOLVE_HOURLY_LIMIT = 5  # новых диалогов через поиск по номеру в час

# Сколько диалогов просматривает поллер за тик и сколько сообщений берёт
# из одного диалога за раз.
POLL_DIALOGS_LIMIT = 30
POLL_MAX_MESSAGES_PER_DIALOG = 10

# Таймауты клиента
CLIENT_START_TIMEOUT = 60     # сек: connect + handshake + login по сессии
AUTH_FLOW_TIMEOUT = 420       # сек: весь интерактивный флоу авторизации
CODE_WAIT_TIMEOUT = 300       # сек: ожидание ввода SMS-кода / пароля из UI
CODE_POLL_INTERVAL = 2        # сек: период опроса транзитных колонок

_pymax_import_error: Optional[str] = None
_pymax_module = None            # кэш успешного импорта
_pymax_import_attempted = False  # чтобы не пытаться (и не спамить в лог) повторно


def _ensure_ws_compat() -> None:
    """
    Заглушки для импорта pymax при websockets<13.

    pymax/transport/websocket.py делает `from websockets import ClientConnection,
    Origin` и `from websockets.asyncio import client` на уровне модуля — эти
    имена появились в websockets 13+. Используются они только WebClient-ом
    (WS-транспорт), а мы работаем через TCP Client. Проект не может поднять
    websockets из-за голосовых прокси (extra_headers API), поэтому недостающие
    имена подкладываются муляжами.
    """
    import sys
    import types

    import websockets

    if not hasattr(websockets, "ClientConnection"):
        websockets.ClientConnection = type("ClientConnection", (), {})
    if not hasattr(websockets, "Origin"):
        websockets.Origin = str
    try:
        import websockets.asyncio  # noqa: F401
    except ImportError:
        def _web_client_unavailable(*args, **kwargs):
            raise RuntimeError(
                "pymax WebClient недоступен: в проекте websockets<13 "
                "(совместимость голосовых прокси). Используйте TCP Client."
            )

        asyncio_mod = types.ModuleType("websockets.asyncio")
        client_mod = types.ModuleType("websockets.asyncio.client")
        client_mod.connect = _web_client_unavailable
        asyncio_mod.client = client_mod
        sys.modules["websockets.asyncio"] = asyncio_mod
        sys.modules["websockets.asyncio.client"] = client_mod
        websockets.asyncio = asyncio_mod


def _import_pymax():
    """Импорт pymax с shim-ом совместимости. Кэширует результат (успех и ошибку)."""
    global _pymax_import_error, _pymax_module, _pymax_import_attempted
    if _pymax_module is not None:
        return _pymax_module
    if _pymax_import_attempted and _pymax_import_error:
        raise ImportError(_pymax_import_error)
    _pymax_import_attempted = True
    _ensure_ws_compat()
    try:
        import pymax
        _pymax_module = pymax
        return pymax
    except Exception as e:
        _pymax_import_error = f"{type(e).__name__}: {e}"
        logger.warning(f"[MAX-USER] pymax import failed (connector disabled): {_pymax_import_error}")
        raise


def is_configured() -> bool:
    """True, если задан ключ шифрования сессий и библиотека PyMax доступна."""
    if not settings.MAX_SESSION_KEY:
        return False
    try:
        _import_pymax()
        return True
    except Exception:
        return False


# ============================================================================
# ШИФРОВАНИЕ СЕССИИ
# ============================================================================

def _fernet():
    from cryptography.fernet import Fernet
    key = (settings.MAX_SESSION_KEY or "").strip()
    return Fernet(key.encode())


def encrypt_session(session_json: str) -> str:
    return _fernet().encrypt((session_json or "").encode()).decode()


def decrypt_session(token: str) -> str:
    return _fernet().decrypt((token or "").encode()).decode()


# ============================================================================
# DB-СТОР СЕССИИ (StoreProtocol PyMax поверх agent_max_accounts)
# ============================================================================

class _DbSessionStore:
    """
    Хранилище сессии PyMax в PostgreSQL: SessionInfo сериализуется в JSON и
    шифруется Fernet в agent_max_accounts.session_encrypted. У аккаунта ровно
    одна сессия, поэтому load_session_by_* эквивалентны load_session.

    Методы вызываются из event loop клиента; SQLAlchemy-сессия синхронная и
    короткоживущая — тот же паттерн, что во всём проекте.
    """

    def __init__(self, account_id: str):
        self.account_id = str(account_id)

    def _load_row(self, db):
        from backend.models.agent_max_account import AgentMaxAccount
        return db.query(AgentMaxAccount).filter(
            AgentMaxAccount.id == self.account_id
        ).first()

    async def save_session(self, session_info) -> None:
        from backend.db.session import SessionLocal
        payload = json.dumps({
            "token": session_info.token,
            "device_id": session_info.device_id,
            "phone": session_info.phone,
            "mt_instance_id": session_info.mt_instance_id or "",
            "sync": {
                "chats_sync": session_info.sync.chats_sync,
                "contacts_sync": session_info.sync.contacts_sync,
                "drafts_sync": session_info.sync.drafts_sync,
                "presence_sync": session_info.sync.presence_sync,
                "config_hash": session_info.sync.config_hash,
            },
        })
        db = SessionLocal()
        try:
            row = self._load_row(db)
            if row is not None:
                row.session_encrypted = encrypt_session(payload)
                db.commit()
        finally:
            db.close()

    async def load_session(self):
        from backend.db.session import SessionLocal
        pymax = _import_pymax()
        from pymax.session.models import SessionInfo
        from pymax.types.domain.sync import SyncState  # noqa: F401

        db = SessionLocal()
        try:
            row = self._load_row(db)
            if row is None or not row.session_encrypted:
                return None
            try:
                data = json.loads(decrypt_session(row.session_encrypted))
            except Exception as e:
                logger.error(f"[MAX-USER] session decrypt failed for {self.account_id}: {e}")
                return None
            return SessionInfo(
                token=data["token"],
                device_id=data["device_id"],
                phone=data.get("phone") or "",
                mt_instance_id=data.get("mt_instance_id") or "",
                sync=SyncState(**(data.get("sync") or {})),
            )
        finally:
            db.close()

    async def load_session_by_device_id(self, device_id: str):
        return await self.load_session()

    async def load_session_by_phone(self, phone: str):
        return await self.load_session()

    async def update_token(self, old_token: str, new_token: str) -> None:
        session = await self.load_session()
        if session is None:
            return
        session.token = new_token
        await self.save_session(session)

    async def delete_session(self, token: str) -> None:
        from backend.db.session import SessionLocal
        db = SessionLocal()
        try:
            row = self._load_row(db)
            if row is not None:
                row.session_encrypted = None
                db.commit()
        finally:
            db.close()

    async def close(self) -> None:
        return None


# ============================================================================
# ОШИБКИ
# ============================================================================

def _error_code(e: Exception) -> str:
    """Исключение PyMax → стабильный код ошибки для UI/тулз."""
    try:
        pymax = _import_pymax()
        if isinstance(e, pymax.ApiError):
            codes = " ".join(str(x) for x in (e.error, e.message) if x)
            if "FAIL_LOGIN_TOKEN" in codes or "FAIL_LOGOUT_ALL" in codes:
                return "session_revoked"
            if "phone" in codes.lower():
                return "phone_invalid"
            if "code" in codes.lower():
                return "code_invalid"
            return f"max_error: {e.error or e.message}"
    except Exception:
        pass
    if isinstance(e, asyncio.TimeoutError) or isinstance(e, TimeoutError):
        msg = str(e) or "max_connect_timeout"
        return msg if msg in ("sms_code_timeout", "password_timeout") else "max_connect_timeout"
    if isinstance(e, (ConnectionError, EOFError, OSError)):
        return "max_unavailable"
    if isinstance(e, RuntimeError) and "RegistrationConfig" in str(e):
        return "max_not_registered"
    return f"max_error: {type(e).__name__}: {e}"


def error_human(code: str) -> str:
    """Код ошибки → человекочитаемое сообщение (для тулз и UI)."""
    if not code:
        return "Неизвестная ошибка MAX"
    mapping = {
        "phone_invalid": "Неверный номер телефона",
        "code_invalid": "Неверный SMS-код — начните подключение заново",
        "code_expired": "Код истёк — начните подключение заново",
        "password_invalid": "Неверный пароль (2FA)",
        "sms_code_timeout": "Код не был введён вовремя — начните подключение заново",
        "password_timeout": "Пароль не был введён вовремя — начните подключение заново",
        "session_revoked": "Сессия отозвана — переподключите MAX",
        "session_missing": "Сессия MAX не найдена — переподключите аккаунт",
        "max_not_registered": "На этом номере нет аккаунта MAX — зарегистрируйтесь в приложении MAX",
        "max_connect_timeout": "MAX не отвечает — попробуйте позже",
        "max_unavailable": "Не удалось соединиться с MAX — попробуйте позже",
        "phone_not_on_max": "У этого номера не найден аккаунт MAX",
        "recipient_not_resolved": "Не удалось найти получателя (нет диалога и номера телефона)",
        "empty_text": "Пустой текст сообщения",
        "send_limit_reached": "Достигнут почасовой лимит исходящих сообщений (защита от бана)",
        "phone_resolve_limit_reached": "Достигнут почасовой лимит новых диалогов по номеру телефона (защита от бана)",
        "not_connected": "Личный MAX не подключён к агенту",
        "not_configured": "Коннектор MAX не настроен на сервере",
        "auth_in_progress": "Авторизация уже идёт — введите код или начните заново",
    }
    return mapping.get(code, code)


# ============================================================================
# КЛИЕНТ (жизненный цикл на одну операцию)
# ============================================================================

class _FailingSmsProvider:
    """Для не-авторизационных клиентов: сессии нет → не пытаемся авторизоваться."""

    async def get_code(self, phone: str) -> str:
        raise TimeoutError("session_missing")


class _FailingPasswordProvider:
    async def get_password(self, hint: Optional[str] = None) -> str:
        raise TimeoutError("session_missing")


async def _start_client(
    account_id: str,
    phone: str,
    sms_code_provider=None,
    password_provider=None,
    start_timeout: float = CLIENT_START_TIMEOUT,
):
    """
    Создать TCP-клиента PyMax и дождаться on_start (успешного логина).
    Возвращает (client, runner_task). Вызывающий ОБЯЗАН вызвать
    _close_client(client, runner) в finally.
    """
    pymax = _import_pymax()

    client = pymax.Client(
        phone=phone or "",
        extra_config=pymax.ExtraConfig(
            store=_DbSessionStore(account_id),
            reconnect=False,     # поллинг-модель: короткая сессия, без вечного цикла
            telemetry=False,
            log_level="WARNING",
        ),
        sms_code_provider=sms_code_provider or _FailingSmsProvider(),
        password_provider=password_provider or _FailingPasswordProvider(),
    )

    started = asyncio.Event()

    @client.on_start()
    async def _on_started(c) -> None:  # noqa: ANN001
        started.set()

    runner = asyncio.create_task(client.start())
    waiter = asyncio.create_task(started.wait())
    try:
        done, _pending = await asyncio.wait(
            {runner, waiter}, timeout=start_timeout, return_when=asyncio.FIRST_COMPLETED
        )
    except Exception:
        waiter.cancel()
        await _close_client(client, runner)
        raise

    if started.is_set():
        waiter.cancel()
        return client, runner

    waiter.cancel()
    if runner in done:
        exc = runner.exception()
        await _close_client(client, None)
        raise exc if exc else ConnectionError("max client stopped before start")

    await _close_client(client, runner)
    raise TimeoutError("max_connect_timeout")


async def _close_client(client, runner) -> None:
    """Закрыть клиента и дождаться завершения фоновой задачи start() (best-effort)."""
    try:
        await client.close()
    except Exception:
        pass
    if runner is not None:
        try:
            await asyncio.wait_for(asyncio.shield(runner), timeout=10)
        except Exception:
            runner.cancel()
            try:
                await runner
            except Exception:
                pass


def _display_name(user) -> Optional[str]:
    """Отображаемое имя пользователя MAX из списка names."""
    try:
        for n in (user.names or []):
            full = n.name or " ".join(filter(None, [n.first_name, n.last_name]))
            if full:
                return full
    except Exception:
        pass
    return None


def _dialog_peer_id(chat, me_id: int) -> Optional[int]:
    """ID собеседника личного диалога (participants: {user_id: ...})."""
    try:
        for uid in (chat.participants or {}):
            if int(uid) != int(me_id):
                return int(uid)
    except Exception:
        pass
    return None


def _is_dialog(chat) -> bool:
    chat_type = getattr(chat, "type", None)
    return str(getattr(chat_type, "value", chat_type) or "").upper() == "DIALOG"


def _snapshot_dialogs(client, limit: int = POLL_DIALOGS_LIMIT) -> List[Any]:
    """Личные диалоги из данных логина (без ботов/групп/каналов/Saved)."""
    me_id = client.me.contact.id if client.me else 0
    out = []
    for chat in (client.chats or []):
        if not _is_dialog(chat):
            continue
        peer_id = _dialog_peer_id(chat, me_id)
        if not peer_id:
            continue  # Saved Messages / служебные
        out.append(chat)
        if len(out) >= limit:
            break
    return out


# ============================================================================
# АВТОРИЗАЦИЯ (телефон → SMS-код → пароль 2FA), фоновой задачей
# ============================================================================

class _DbSmsCodeProvider:
    """Ждёт, пока UI положит SMS-код в agent_max_accounts.sms_code."""

    def __init__(self, account_id: str):
        self.account_id = str(account_id)

    async def get_code(self, phone: str) -> str:
        from backend.db.session import SessionLocal
        from backend.models.agent_max_account import AgentMaxAccount

        deadline = asyncio.get_event_loop().time() + CODE_WAIT_TIMEOUT
        while asyncio.get_event_loop().time() < deadline:
            db = SessionLocal()
            try:
                row = db.query(AgentMaxAccount).filter(
                    AgentMaxAccount.id == self.account_id
                ).first()
                if row is None:
                    raise TimeoutError("sms_code_timeout")  # аккаунт удалили («начать заново»)
                code = (row.sms_code or "").strip()
                if code:
                    row.sms_code = None
                    db.commit()
                    return code
            finally:
                db.close()
            await asyncio.sleep(CODE_POLL_INTERVAL)
        raise TimeoutError("sms_code_timeout")


class _DbPasswordProvider:
    """
    Ждёт пароль 2FA из agent_max_accounts.password_2fa. При первом вызове
    переводит аккаунт в pending_password (UI покажет поле пароля); при повторном
    (SmsAuthFlow ретраит неверный пароль) — помечает last_error=password_invalid.
    """

    def __init__(self, account_id: str):
        self.account_id = str(account_id)
        self.attempts = 0

    async def get_password(self, hint: Optional[str] = None) -> str:
        from backend.db.session import SessionLocal
        from backend.models.agent_max_account import AgentMaxAccount

        self.attempts += 1
        db = SessionLocal()
        try:
            row = db.query(AgentMaxAccount).filter(
                AgentMaxAccount.id == self.account_id
            ).first()
            if row is not None:
                row.status = "pending_password"
                row.last_error = "password_invalid" if self.attempts > 1 else None
                db.commit()
        finally:
            db.close()

        deadline = asyncio.get_event_loop().time() + CODE_WAIT_TIMEOUT
        while asyncio.get_event_loop().time() < deadline:
            db = SessionLocal()
            try:
                row = db.query(AgentMaxAccount).filter(
                    AgentMaxAccount.id == self.account_id
                ).first()
                if row is None:
                    raise TimeoutError("password_timeout")
                password = row.password_2fa or ""
                if password:
                    row.password_2fa = None
                    db.commit()
                    return password
            finally:
                db.close()
            await asyncio.sleep(CODE_POLL_INTERVAL)
        raise TimeoutError("password_timeout")


def _set_account_status(account_id: str, status: str, last_error: Optional[str]) -> None:
    from backend.db.session import SessionLocal
    from backend.models.agent_max_account import AgentMaxAccount

    db = SessionLocal()
    try:
        row = db.query(AgentMaxAccount).filter(AgentMaxAccount.id == account_id).first()
        if row is not None:
            row.status = status
            row.last_error = last_error
            row.sms_code = None
            row.password_2fa = None
            db.commit()
    finally:
        db.close()


async def run_auth(account_id: str) -> None:
    """
    Фоновая задача полной авторизации аккаунта MAX.

    Запускается из POST /api/agent/max-account/start. Внутри client.start()
    PyMax сам запрашивает SMS-код у MAX; код и пароль 2FA приходят через
    DB-провайдеры (UI кладёт их в транзитные колонки). По успеху: сессия уже
    сохранена стором, снимаем baseline диалогов и помечаем connected.

    Если воркер, принявший /start, умрёт посреди флоу (рециклинг gunicorn) —
    авторизация оборвётся; штатный выход для пользователя — «Начать заново».
    """
    from backend.db.session import SessionLocal
    from backend.models.agent_max_account import AgentMaxAccount

    db = SessionLocal()
    try:
        row = db.query(AgentMaxAccount).filter(AgentMaxAccount.id == account_id).first()
        if row is None:
            return
        phone = row.phone or ""
    finally:
        db.close()

    client = None
    runner = None
    try:
        client, runner = await _start_client(
            account_id,
            phone,
            sms_code_provider=_DbSmsCodeProvider(account_id),
            password_provider=_DbPasswordProvider(account_id),
            start_timeout=AUTH_FLOW_TIMEOUT,
        )

        me = client.me
        me_id = me.contact.id if me else None
        me_name = _display_name(me.contact) if me else None
        dialogs_snapshot = []
        for chat in _snapshot_dialogs(client):
            peer_id = _dialog_peer_id(chat, me_id or 0)
            last_msg = getattr(chat, "last_message", None)
            dialogs_snapshot.append({
                "chat_id": int(chat.id),
                "peer_id": peer_id,
                "top_time": int(getattr(last_msg, "time", 0) or 0),
            })
        # Телефоны/имена собеседников для привязки к контактам (best-effort)
        peer_ids = [d["peer_id"] for d in dialogs_snapshot if d["peer_id"]]
        peers = {}
        if peer_ids:
            try:
                users = await client.get_users(peer_ids)
                peers = {int(u.id): u for u in users if u is not None}
            except Exception as e:
                logger.warning(f"[MAX-USER] baseline get_users failed: {e}")
        for d in dialogs_snapshot:
            u = peers.get(d["peer_id"])
            d["phone"] = str(u.phone) if (u is not None and u.phone) else None
            d["name"] = _display_name(u) if u is not None else None
    except Exception as e:
        code = _error_code(e)
        logger.warning(f"[MAX-USER] auth failed for account {account_id}: {code}")
        _set_account_status(account_id, "error", code)
        return
    finally:
        if client is not None:
            await _close_client(client, runner)

    # Финализация: connected + baseline диалогов (чтобы поллер не отвечал на
    # старую переписку) + привязка диалогов к контактам агента по номеру.
    from backend.models.agent_max_account import AgentMaxDialog
    from backend.models.agent_contact import AgentContact
    from backend.services.sms_history import phone_suffix

    db = SessionLocal()
    try:
        row = db.query(AgentMaxAccount).filter(AgentMaxAccount.id == account_id).first()
        if row is None:
            return
        row.status = "connected"
        row.last_error = None
        row.sms_code = None
        row.password_2fa = None
        row.max_user_id = me_id
        row.max_name = me_name

        existing = {
            int(r.max_chat_id) for r in db.query(AgentMaxDialog.max_chat_id).filter(
                AgentMaxDialog.account_id == row.id
            ).all()
        }
        for d in dialogs_snapshot:
            if d["chat_id"] in existing:
                continue
            contact_id = None
            suf = phone_suffix(d.get("phone") or "")
            if suf:
                contact = db.query(AgentContact).filter(
                    AgentContact.agent_config_id == row.agent_config_id,
                    AgentContact.phone.like(f"%{suf}"),
                ).order_by(AgentContact.created_at.desc()).first()
                if contact:
                    contact_id = contact.id
            db.add(AgentMaxDialog(
                account_id=row.id,
                agent_contact_id=contact_id,
                max_chat_id=d["chat_id"],
                max_peer_id=d["peer_id"],
                max_name=d.get("name"),
                last_processed_msg_time=d["top_time"],
                created_via="baseline",
            ))
        db.commit()
        logger.info(
            f"[MAX-ACCOUNT] connected {me_name or me_id} for account {account_id} "
            f"(baseline: {len(dialogs_snapshot)} dialogs)"
        )
    finally:
        db.close()


# ============================================================================
# ПОЛЛИНГ ВХОДЯЩИХ
# ============================================================================

async def poll_dialogs(account_id: str, phone: str, known_last_times: Dict[int, int]) -> Dict[str, Any]:
    """
    Снять срез личных диалогов и новые входящие сообщения.

    known_last_times — {max_chat_id: last_processed_msg_time (unix ms)} из БД.
    Для известных диалогов новые сообщения = входящие с time > last_time; для
    НЕизвестных (появились после подключения) — последние new_messages входящих
    (но не больше POLL_MAX_MESSAGES_PER_DIALOG).

    Возвращает {ok, dialogs: [{chat_id, peer_id, name, phone, top_time, is_known,
    new_messages: [{id, time, text}] (старые → новые)}]} или {ok: False, error}.
    Только личные диалоги (type=DIALOG): не группы, не каналы, не Saved Messages.
    """
    client = None
    runner = None
    try:
        client, runner = await _start_client(account_id, phone)
        me_id = client.me.contact.id if client.me else 0

        out: List[Dict[str, Any]] = []
        need_user_info: List[int] = []
        for chat in _snapshot_dialogs(client):
            chat_id = int(chat.id)
            peer_id = _dialog_peer_id(chat, me_id)
            last_msg = getattr(chat, "last_message", None)
            top_time = int(getattr(last_msg, "time", 0) or 0)
            is_known = chat_id in known_last_times

            new_messages: List[Dict[str, Any]] = []
            last_time = int(known_last_times.get(chat_id) or 0)
            # Триггер загрузки истории — любая новая активность с прошлого маркера
            # (не только последнее сообщение: владелец мог ответить в MAX сам, и
            # тогда top — исходящее, но между маркером и им могли быть входящие).
            has_activity = (
                (top_time > last_time) if is_known
                else int(getattr(chat, "new_messages", 0) or 0) > 0
            )
            if has_activity:
                try:
                    history = await client.fetch_history(
                        chat_id, backward=POLL_MAX_MESSAGES_PER_DIALOG
                    )
                except Exception as e:
                    logger.warning(f"[MAX-USER] fetch_history({chat_id}) failed: {e}")
                    history = []
                if not is_known:
                    unread = int(getattr(chat, "new_messages", 0) or 0)
                    candidates = sorted(history or [], key=lambda m: int(m.time or 0))
                    candidates = candidates[-min(unread, POLL_MAX_MESSAGES_PER_DIALOG):] if unread else []
                else:
                    candidates = sorted(history or [], key=lambda m: int(m.time or 0))
                for m in candidates:
                    if int(getattr(m, "sender", 0) or 0) == int(me_id):
                        continue
                    m_time = int(getattr(m, "time", 0) or 0)
                    if is_known and m_time <= last_time:
                        continue
                    body = (getattr(m, "text", None) or "").strip()
                    if body:
                        new_messages.append({"id": int(m.id), "time": m_time, "text": body})

            if new_messages or not is_known:
                if peer_id:
                    need_user_info.append(peer_id)

            out.append({
                "chat_id": chat_id,
                "peer_id": peer_id,
                "name": None,
                "phone": None,
                "top_time": top_time,
                "is_known": is_known,
                "new_messages": new_messages,
            })

        if need_user_info:
            try:
                users = await client.get_users(list(set(need_user_info)))
                peers = {int(u.id): u for u in users if u is not None}
                for d in out:
                    u = peers.get(d["peer_id"])
                    if u is not None:
                        d["name"] = _display_name(u)
                        d["phone"] = str(u.phone) if u.phone else None
            except Exception as e:
                logger.warning(f"[MAX-USER] poll get_users failed: {e}")

        return {"ok": True, "dialogs": out}
    except Exception as e:
        logger.warning(f"[MAX-USER] poll_dialogs failed: {type(e).__name__}: {e}")
        return {"ok": False, "error": _error_code(e)}
    finally:
        if client is not None:
            await _close_client(client, runner)


# ============================================================================
# ОТПРАВКА
# ============================================================================

async def send_message(
    account_id: str,
    account_phone: str,
    text: str,
    chat_id: Optional[int] = None,
    peer_id: Optional[int] = None,
    phone: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Отправить сообщение. Резолв получателя (по мере предпочтительности):
      1) chat_id — уже известный личный диалог (из AgentMaxDialog);
      2) peer_id — ID собеседника (chat_id личного диалога вычисляется локально);
      3) phone — поиск пользователя MAX по номеру (рискованно: антифрод;
         вызывающий обязан лимитировать).

    Возвращает {ok, max_message_id, msg_time, chat_id, peer_id, name, resolved_via}
    или {ok: False, error}.
    """
    text = (text or "").strip()
    if not text:
        return {"ok": False, "error": "empty_text"}

    client = None
    runner = None
    try:
        client, runner = await _start_client(account_id, account_phone)
        me_id = client.me.contact.id if client.me else 0

        resolved_via = None
        peer_name = None
        target_chat_id = None
        target_peer_id = peer_id

        if chat_id:
            target_chat_id = int(chat_id)
            resolved_via = "dialog"
        elif peer_id:
            target_chat_id = client.get_chat_id(int(peer_id), int(me_id))
            resolved_via = "peer_id"
        elif phone:
            digits = "".join(ch for ch in str(phone) if ch.isdigit())
            if digits.startswith("8") and len(digits) == 11:
                digits = "7" + digits[1:]
            try:
                found = await client.search_by_phone(f"+{digits}")
            except Exception as e:
                logger.info(f"[MAX-USER] search_by_phone failed: {type(e).__name__}: {e}")
                found = None
            if found is None or not getattr(found, "id", None):
                return {"ok": False, "error": "phone_not_on_max"}
            target_peer_id = int(found.id)
            peer_name = _display_name(found)
            target_chat_id = client.get_chat_id(target_peer_id, int(me_id))
            resolved_via = "phone"

        if not target_chat_id:
            return {"ok": False, "error": "recipient_not_resolved"}

        msg = await client.send_message(chat_id=target_chat_id, text=text, notify=True)

        return {
            "ok": True,
            "max_message_id": int(getattr(msg, "id", 0) or 0) or None,
            "msg_time": int(getattr(msg, "time", 0) or 0) or None,
            "chat_id": int(target_chat_id),
            "peer_id": target_peer_id,
            "name": peer_name,
            "resolved_via": resolved_via,
        }
    except Exception as e:
        logger.error(f"[MAX-USER] send_message failed: {type(e).__name__}: {e}")
        return {"ok": False, "error": _error_code(e)}
    finally:
        if client is not None:
            await _close_client(client, runner)


# ============================================================================
# ХЕЛПЕРЫ ДЛЯ БД-СЛОЯ (тулзы/поллер/оркестратор)
# ============================================================================

def get_account_for_agent(db, agent_config_id, require_connected: bool = True):
    """Строка AgentMaxAccount агента (или None). Ленивая — без PyMax."""
    from backend.models.agent_max_account import AgentMaxAccount
    row = db.query(AgentMaxAccount).filter(
        AgentMaxAccount.agent_config_id == agent_config_id
    ).first()
    if row is None:
        return None
    if require_connected and not row.is_connected():
        return None
    return row


def account_connected(db, agent_config_id) -> bool:
    """True, если сервис настроен и у агента подключён личный MAX."""
    if not is_configured():
        return False
    try:
        return get_account_for_agent(db, agent_config_id) is not None
    except Exception as e:
        logger.warning(f"[MAX-USER] account_connected check failed: {e}")
        return False


def store_message(
    db,
    account,
    direction: str,
    body: str,
    agent_contact_id=None,
    max_chat_id=None,
    max_message_id=None,
):
    """Сохранить сообщение переписки (best-effort, без commit)."""
    from backend.models.agent_max_account import AgentMaxMessage
    try:
        row = AgentMaxMessage(
            account_id=account.id,
            agent_contact_id=agent_contact_id,
            max_chat_id=max_chat_id,
            max_message_id=max_message_id,
            direction=direction,
            body=body or "",
        )
        db.add(row)
        return row
    except Exception as e:
        logger.error(f"[MAX-USER] store_message failed: {e}")
        return None


def get_thread(db, agent_contact_id, limit: int = 30) -> list:
    """Переписка MAX с контактом (старые → новые) для карточки/контекста."""
    from backend.models.agent_max_account import AgentMaxMessage
    rows = (
        db.query(AgentMaxMessage)
        .filter(AgentMaxMessage.agent_contact_id == agent_contact_id)
        .order_by(AgentMaxMessage.created_at.desc())
        .limit(limit)
        .all()
    )
    return list(reversed(rows))


def build_thread_text(db, agent_contact_id, limit: int = 20) -> str:
    """Текстовый блок MAX-переписки для промпта оркестратора ('' если пусто)."""
    from backend.core.timezone_utils import utc_to_msk
    rows = get_thread(db, agent_contact_id, limit)
    if not rows:
        return ""
    lines = []
    for m in rows:
        ts_str = utc_to_msk(m.created_at).strftime("%d.%m %H:%M") if m.created_at else "?"
        who = "Агент → клиенту" if (m.direction or "inbound") == "outbound" else "Клиент → агенту"
        text = (m.body or "").strip().replace("\n", " ")
        lines.append(f"[{ts_str}] {who}: {text}")
    return "\n".join(lines)

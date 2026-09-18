# backend/db — слой доступа к БД: engine, сессии, declarative base, репозитории, обёртка Alembic

## Назначение
Слой работы с PostgreSQL через SQLAlchemy 2.x. Создаёт engine и фабрику сессий (`session.py`), объявляет общий declarative `Base` и базовые CRUD-абстракции (`base.py`), предоставляет конкретные репозитории для основных моделей (`repositories.py`) и тонкую обёртку над командами Alembic (`migrations_manager.py`). Точка, через которую остальной код получает сессию БД.

## Состав
- `session.py` — `create_engine` (QueuePool 5+25, `pool_pre_ping`, `pool_timeout`/`connect_timeout`/TCP keepalive из env, `sslmode=require`), фабрика `SessionLocal`, FastAPI-зависимость `get_db()` (yield + close), хелперы `release_db_connection` / `safe_rollback` / `DB_CONNECTION_ERRORS` для долгоживущих WS-сессий и `check_database_connection()` для `/health` (отдельный engine без пула).
- `base.py` — `Base = declarative_base()`, абстрактный `BaseModel` (поля `id: UUID`, `created_at`, `updated_at`, метод `get_by_id`), дженерик `CRUDBase[Model, Create, Update]` с `get/get_multi/create/update/remove`.
- `repositories.py` — конкретные репозитории поверх `CRUDBase`: `UserRepository`, `AssistantRepository`, `ConversationRepository`, `FileRepository` + готовые синглтон-экземпляры.
- `migrations_manager.py` — функции-обёртки над Alembic: `upgrade_database`, `downgrade_database`, `create_migration`, `get_current_revision`, `get_history`, `check_migrations`, `create_initial_migration`.

## Ключевые сущности / точки входа
- `engine` — глобальный SQLAlchemy engine; `DATABASE_URL` берётся из env или `settings`, при отсутствии — `RuntimeError`.
- `SessionLocal` — фабрика сессий (`autocommit=False`, `autoflush=False`). Используется планировщиками и сервисами напрямую.
- `get_db()` — FastAPI-зависимость, выдающая сессию на запрос.
- `Base` — общий declarative base для всех моделей в `backend/models/*`.
- `CRUDBase` / `BaseModel` — базовые классы для моделей и CRUD.
- Синглтоны репозиториев: `user_repository`, `assistant_repository`, `conversation_repository`, `file_repository`.
- `upgrade_database(revision="head")` / `check_migrations()` — управление миграциями программно.

## Связи с другими частями проекта
- Используется: `backend/core/dependencies.py` и `backend/api/*` (через `get_db`), `backend/core/scheduler.py` и `backend/core/task_scheduler.py` (через `SessionLocal`), `backend/services/*` (репозитории и сессии), все `backend/models/*` наследуют `Base`/`BaseModel`.
- Использует: `backend/core/config.py` (`settings.DATABASE_URL`, `settings.DEBUG`), `backend/core/logging.py` (`get_logger`), `backend/models/*` и `backend/schemas/*` (в `repositories.py`), пакет `alembic` (в `migrations_manager.py`).

## На что обратить внимание
- Пул `QueuePool` (`DB_POOL_SIZE`=5, `DB_MAX_OVERFLOW`=25). Прод — один процесс uvicorn с одним event loop, а запросы синхронные, поэтому ожидания короткие: `DB_POOL_TIMEOUT`=10 с, `DB_CONNECT_TIMEOUT`=5 с, TCP keepalive 30/10/3. Без них обрыв базы (Render, «SSL SYSCALL error: EOF detected») замораживал весь процесс до ручного перезапуска.
- WebSocket-хендлеры голосовых сессий держат сессию БД весь звонок. Сразу после загрузки ассистента/пользователя они вызывают `release_db_connection(db)`: commit только-читающей транзакции + `expire_on_commit=False`, чтобы соединение вернулось в пул, а объекты не перечитывались. Следующий запрос через ту же сессию возьмёт соединение заново.
- Фоновые задачи с долгими `await` (резервный поллер `PostCallOrchestrator.poll_and_run` — до 5 минут на звонок, анализ после звонка с ожиданием LLM) отпускают соединение перед сном/запросом к LLM через `release_db_connection` / `release_db_connection_if_clean`. Именно поллер раньше исчерпывал пул («QueuePool limit of size 5 overflow 25 reached») при пачке исходящих звонков.
- Фоновые циклы (`task_scheduler`, `subscription_blocker`, `test_number_expirer`, `telegram_user_poller`, `max_connection_supervisor`) делают опрос БД через `asyncio.to_thread` со своей короткой сессией; сессия в event loop открывается только когда есть работа. `scheduler.py` (проверка подписок раз в час) пока синхронный.
- `ConversationService.save_conversation` при `DB_CONNECTION_ERRORS` повторяет запись на свежей `SessionLocal(expire_on_commit=False)`, чтобы диалог не пропал при обрыве базы посреди звонка.
- `/health` (`app.py`) делает `SELECT 1` через `check_database_connection()` в потоке с таймаутом `HEALTH_DB_TIMEOUT`=4 с (две попытки); при недоступной базе отдаёт 503, и Render перезапускает инстанс сам.
- `connect_args={"sslmode": "require"}` зашит — в локальной разработке без SSL может потребоваться правка.
- Основная система миграций — каталог `../../alembic/` (Alembic). `migrations_manager.py` указывает `script_location` на `backend/migrations` и `backend/alembic.ini` — это альтернативный/легаси путь; не путать с корневым `alembic/`. Многие изменения схемы также авто-применяются в startup-событии `app.py`.
- `CRUDBase.update` итерирует по `db_obj.__dict__` — поля, отсутствующие в загруженном объекте, не обновятся; это легаси-реализация.
- `UserRepository.create_with_hashed_password` проставляет `subscription_plan="free"` по умолчанию.

## Связанные файлы документации
- `../claude-backend.md` — родительская
- `../models/claude-models.md` — модели, наследующие `Base`/`BaseModel`
- `../../alembic/claude-alembic.md` — основная система миграций
- `../migrations/claude-migrations.md` — raw-SQL миграция (легаси)
- `../core/claude-core.md` — `settings`, `get_logger`, потребители `SessionLocal`
- `../services/claude-services.md` — потребители репозиториев

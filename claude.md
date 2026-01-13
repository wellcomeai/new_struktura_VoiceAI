# VoiceAI Platform

## Project Overview

VoiceAI - это платформа для создания голосовых AI-ассистентов с поддержкой телефонии, веб-виджетов и интеграций. Бэкенд построен на FastAPI с PostgreSQL базой данных.

## Tech Stack

- **Backend**: FastAPI, Python 3.11+
- **Database**: PostgreSQL + SQLAlchemy 2.0 + Alembic (миграции)
- **WebSocket**: websockets, FastAPI WebSocket
- **AI/ML**: OpenAI API, Google Gemini, Pinecone (векторный поиск)
- **Voice**: ElevenLabs (TTS), Voximplant (телефония)
- **Deployment**: Gunicorn, Uvicorn, Render.com

## Project Structure

```
├── app.py                 # Главное FastAPI приложение
├── main.py                # Точка входа, запуск сервера + миграции
├── alembic/               # Миграции базы данных
│   └── versions/          # Файлы миграций
├── backend/
│   ├── api/               # API эндпоинты (роуты)
│   ├── core/              # Конфигурация, безопасность, scheduler
│   ├── db/                # Сессии БД, репозитории
│   ├── models/            # SQLAlchemy модели
│   ├── schemas/           # Pydantic схемы
│   ├── services/          # Бизнес-логика
│   ├── functions/         # AI функции (tools для ассистентов)
│   ├── utils/             # Утилиты
│   ├── websockets/        # WebSocket обработчики
│   └── static/            # Статические файлы
├── chrome-extension/      # Chrome расширение
└── test_*.py              # Тесты
```

## Key Modules

### API Endpoints (`backend/api/`)
- `auth.py` - Аутентификация и авторизация
- `assistants.py` - CRUD для AI-ассистентов
- `gemini_assistants.py` - Ассистенты на базе Gemini
- `conversations.py` - История разговоров
- `telephony.py` - Телефония и звонки
- `payments.py` - Платежи и подписки
- `partners.py` - Партнёрская программа
- `knowledge_base.py` - База знаний (Pinecone)

### Models (`backend/models/`)
- `assistant.py` - Модель ассистента
- `conversation.py` - Разговоры и сообщения
- `subscription.py` - Подписки и планы
- `partner.py` - Партнёры и комиссии

### Functions (`backend/functions/`)
AI функции, которые ассистенты могут вызывать:
- `search_pinecone.py` - Поиск в базе знаний
- `send_telegram_notification.py` - Отправка в Telegram
- `add_google_sheet_row.py` - Запись в Google Sheets
- `api_request.py` - HTTP запросы
- `query_llm.py` - Запросы к LLM

## Development

### Running Locally
```bash
# Установка зависимостей
pip install -r requirements.txt

# Запуск сервера (применяет миграции автоматически)
python main.py
```

### Environment Variables
Основные переменные окружения:
- `DATABASE_URL` - PostgreSQL connection string
- `OPENAI_API_KEY` - OpenAI API ключ
- `ELEVENLABS_API_KEY` - ElevenLabs API ключ
- `PINECONE_API_KEY` - Pinecone API ключ
- `PORT` - Порт сервера (default: 5050)
- `DEBUG` - Режим отладки

### Database Migrations
```bash
# Создать новую миграцию
alembic revision --autogenerate -m "description"

# Применить миграции
alembic upgrade head

# Откатить миграцию
alembic downgrade -1
```

## Code Conventions

- Все модели наследуются от `backend.models.base.Base`
- API роуты регистрируются в `app.py`
- Используйте Pydantic схемы для валидации
- Логирование через `backend.core.logging`
- Все даты хранятся в UTC

## Testing

```bash
# Запуск конкретного теста
python -m pytest test_email_verification.py -v

# Запуск всех тестов
python -m pytest test_*.py -v
```

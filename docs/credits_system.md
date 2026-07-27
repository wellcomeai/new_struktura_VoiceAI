# Система кредитов оркестратора Voicyfy Agent

Реализация ТЗ v1.1. Тариф `agent` живёт параллельно с существующими тарифами
(`ai_voice`, `start`, `profi`) и не затрагивает их.

> **В платформе два независимых кошелька кредитов.** Этот документ — про
> кредиты **оркестратора** (`users.credits_balance`, транзакции с
> `product='orchestrator'`). Второй кошелёк — кредиты **каскад-ассистентов**
> (`users.cascade_credits_balance`, `product='cascade'`,
> `services/cascade_credit_service.py`): свой стартовый грант, свои пакеты
> докупки, доступен на всех тарифах, включая free, и не блокируется
> истечением подписки `agent`. Гейт по балансу каскада стоит на старте
> звонка (`api/telephony.py`), а не при создании ассистента. Общая у них
> только таблица `credit_transactions`, разделённая колонкой `product`.

## Обзор

- **Кредиты привязаны к юзеру** (`users.credits_balance`), а не к агенту.
  При удалении агента баланс, история транзакций, `agent_trial_used` и
  `subscription_end_date` сохраняются.
- **Trial** выдаётся один раз за всю жизнь юзера: 3 дня + 1 500 кредитов при
  первом создании агента.
- **Тариф agent**: 4 990 ₽/мес, +20 000 кредитов разово при покупке/продлении.
- **Пакеты докупки** (`credit_packages`) никогда не сгорают, доступны только при
  активной подписке agent (включая trial).
- При истечении подписки — жёсткая блокировка: оркестратор, звонки, Telegram-бот
  и веб-чат не работают. Кредиты не сгорают, но потратить их нельзя до оплаты.

## Тарификация моделей

Базовая константа: **1 кредит = $0.0001 себестоимости** (×2 маржа к OpenRouter).
Ставки `input_credits_per_1k` / `output_credits_per_1k` заданы в
`backend/services/agent_models.py`.

Формула списания (`CreditService.calculate_cost`):

```
credits_spent = ceil(
    (prompt_tokens / 1000) * input_credits_per_1k +
    (completion_tokens / 1000) * output_credits_per_1k
)
```

Минимум — 1 кредит за любой вызов.

## Архитектура

| Слой | Файл |
|------|------|
| Модели | `backend/models/credit_transaction.py`, `backend/models/credit_package.py`, поля в `backend/models/user.py` |
| Сервис | `backend/services/credit_service.py` (`CreditService`, `activate_agent_trial`) |
| API | `backend/api/credits.py` (`/api/credits/*`) |
| Платежи | `backend/services/payment_service.py` (ветви пакетов и тарифа agent в `process_payment_result`) |
| Оркестратор | `backend/services/agent_orchestrator.py` (precheck + charge в 4 v3-методах) |
| Блокировка | `backend/services/subscription_blocker.py` (каждые 5 мин) + guard в `backend/core/task_scheduler.py` |
| Frontend | `backend/static/agent.html` (бейдж, баннер, модалки, обработка 402) |

### Списание кредитов

Списывается только v3-флоу на ключах Voicyfy (OpenRouter): precall, postcall,
веб-чат, Telegram-чат. НЕ списываются: v2 legacy-флоу (ключи юзера) и сами
голосовые звонки (Realtime/Live — ключи юзера). Токены накапливаются по всем
итерациям tool calls и списываются одним `charge` в конце.

## API

| Метод | Назначение |
|-------|------------|
| `GET /api/credits/balance` | Баланс + статус подписки |
| `GET /api/credits/packages` | Активные пакеты докупки |
| `GET /api/credits/transactions` | История транзакций (limit/offset/type_filter) |
| `POST /api/credits/purchase` | Платёж за пакет (тело `{package_code}`) |
| `POST /api/credits/subscribe` | Trial без оплаты ИЛИ платёж за тариф agent |

Коды ошибки 402 (`detail`): `subscription_expired`, `subscription_required`,
`{error: insufficient_credits, required, available}`.

## Платёжный коллбэк (Robokassa)

`process_payment_result` различает три ветви по Shp-параметрам:

- `Shp_credits_package=<code>` → начисление пакета (`grant_purchase`).
- `Shp_plan_code=agent` → продление 30 дней + 20 000 кредитов (`grant_subscription`),
  снятие `agent_subscription_blocked`.
- иначе → существующая логика других тарифов.

Идемпотентность через `transaction.is_processed`. Сумма сверяется с
`credit_packages.price_rub` / `subscription_plans.price` (защита от подмены Shp).

---

## Admin Runbook — ручная корректировка баланса

> На случай спора/компенсации. Все ручные операции пишутся в `credit_transactions`
> с `type=manual_adjust` и обязательной заметкой.

### Начислить/списать кредиты вручную (через Python shell на сервере)

```python
from backend.db.session import SessionLocal
from backend.services.credit_service import CreditService

db = SessionLocal()
# Начислить 5000 кредитов (компенсация по тикету #123)
CreditService.manual_adjust(db, user_id="<UUID>", amount=5000,
                            notes="support: ticket #123, goodwill credit by admin@voicyfy")
# Списать 2000 кредитов
CreditService.manual_adjust(db, user_id="<UUID>", amount=-2000,
                            notes="support: refund clawback, ticket #124")
db.close()
```

`manual_adjust` использует `SELECT FOR UPDATE`, не уходит в минус (обрезает до 0),
требует непустую заметку.

### Проверить баланс и историю

```python
from backend.db.session import SessionLocal
from backend.services.credit_service import CreditService
db = SessionLocal()
print(CreditService.get_balance(db, "<UUID>"))
rows, total = CreditService.get_transactions(db, "<UUID>", limit=20)
for t in rows: print(t.created_at, t.type, t.amount, t.balance_after, t.notes)
db.close()
```

### Разблокировать подписку вручную

Блокировка снимается автоматически при успешной оплате. Для ручного снятия:

```sql
UPDATE users SET agent_subscription_blocked = FALSE WHERE id = '<UUID>';
```

### Где смотреть при споре «куда делись кредиты после удаления агента»

Удаление агента создаёт системную запись `type=manual_adjust, amount=0,
ref_type=agent_deleted` с текущим балансом и числом отменённых задач — она
остаётся в `credit_transactions` даже после удаления агента.

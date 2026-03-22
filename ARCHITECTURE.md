# AX Marketing Partners Bot — Архітектура

## Огляд

Telegram-бот для розсилки повідомлень у партнерські чати.
Управління — виключно через закритий адміністративний чат.

---

## Стек

| Шар | Технологія | Причина |
|-----|-----------|---------|
| Runtime | Node.js 22 + TypeScript | Типобезпека, просто дебажити |
| Bot framework | [grammy](https://grammy.dev) | Найкраща підтримка TS серед bot-фреймворків |
| Зберігання | JSON-файл `data/chats.json` | Достатньо для 50 чатів, немає зайньої залежності |
| Конфігурація | `.env` + `dotenv` | Стандарт для секретів |
| Контейнеризація | Docker (multi-stage) + Compose | Ізольований деплой, зберігання даних через volume |

---

## Структура проекту

```
src/
  config.ts       — читає BOT_TOKEN, ADMIN_CHAT_ID з .env; падає з помилкою якщо не задані
  types.ts        — TypeScript-типи (ChatRecord, BroadcastSession, ScheduledBroadcast, ...)
  storage.ts      — читання/запис data/chats.json (синхронний I/O — Node.js single-thread, безпечно)
  broadcaster.ts  — розсилка з rate-limiting + 429 retry
  utils.ts        — timeAgo(), formatTime(), nextOccurrenceOf(), isTomorrow(), token()
  bot.ts          — вся логіка бота: обробники, FSM-стан, helper-функції
  index.ts        — точка входу, запуск бота, SIGTERM/SIGINT shutdown

data/
  chats.json      — список підключених чатів (auto-created, в .gitignore)

Dockerfile        — multi-stage: builder (tsc) → runner (prod deps + dist)
docker-compose.yml
.env.example
README.md
```

---

## Конфігурація

Два обов'язкові параметри в `.env`:

```
BOT_TOKEN=123456:ABC...        # токен від @BotFather
ADMIN_CHAT_ID=-1001234567890   # ID управляючого чату (від'ємне число для груп)
```

`ADMIN_CHAT_ID` може бути:
- **ID групи** (від'ємне число) — управління через закритий чат
- **Особистий ID** (позитивне число) — управління через DM з ботом

Часовий пояс встановлений через `TZ=Europe/Kyiv` в `docker-compose.yml` — впливає на відображення часу в запланованих розсилках.

---

## Команди

| Команда | Дія |
|---------|-----|
| `/start` | Привітання + статистика (чатів, остання розсилка, кількість запланованих) |
| `/help` | Інструкція з нагадуванням про обмеження |
| `/broadcast` | Запустити розсилку |
| `/scheduled` | Переглянути та скасувати заплановані розсилки |
| `/addlink` | Deep link для додавання бота в групу/канал з правами адміна |
| `/addchat` | Додати чат за ID або через forwarded-пост групи/каналу |
| `/removedchats` | Переглянути та відновити видалені чати |
| `/list` | Список активних чатів + відносний час останньої розсилки |
| `/checkchats` | Перевірити статус бота в кожному чаті без відправки повідомлень |
| `/removechat` | Soft-видалити чат зі списку (пагінована inline-клавіатура, 8 на сторінку) |
| `/cancel` | Скасувати поточну активну операцію (не скасовує заплановані — для цього є /scheduled) |

---

## Потік роботи

### Автоматична реєстрація чатів

```
Бот доданий в групу
  └─► my_chat_member (new: member/admin)
        └─► addChat() → chats.json (відновлює якщо є removedAt)
              └─► сповіщення в адмін-чат: "✅ Доданий до: Назва"

Бот видалений з групи
  └─► my_chat_member (new: left/kicked)
        └─► removeChat() → встановлює removedAt (soft-delete)
              └─► сповіщення в адмін-чат: "❌ Видалений з: Назва"
```

Приватні чати (DM) та сам адмін-чат ігноруються в цьому обробнику.

### Розсилка — FSM (скінченний автомат)

```
/broadcast
  └─► стан: waitingForContent
        └─► Адмін надсилає контент (будь-який тип медіа)
              └─► BroadcastSession створюється (pending + selectedChatIds = всі)
                    └─► Клавіатура підтвердження:
                          ├─► [✅ Всім (N)] ──────────────────► executeBroadcast()
                          │                                          └─► deleteMessage("⏳...")
                          │                                          └─► sendMessage(звіт)
                          ├─► [🎯 Вибрати чати]
                          │     └─► checkbox keyboard (toggle/всі/жодного)
                          │           └─► [✅ Відіслати вибраним (N)] → executeBroadcast()
                          │
                          ├─► [⏰ 30 хв / 1 год / 2 год]
                          │     └─► setTimeout(delayMs) → при спрацюванні: executeBroadcast()
                          │
                          ├─► [🕐 Свій час]
                          │     └─► стан: waitingForCustomTime
                          │           └─► Адмін вводить HH:MM
                          │                 └─► nextOccurrenceOf() → setTimeout()
                          │                       └─► при спрацюванні: executeBroadcast()
                          │
                          └─► [❌ Скасувати] ─► очищення стану
```

**Чому `copyMessage`:** один виклик підтримує всі типи медіа (текст, фото, відео, документ, голосове, кружок, стікер, GIF, poll). Без мітки "Forwarded from".

---

## Rate Limiting та обробка помилок

Telegram обмежує: ~30 повідомлень/сек сумарно.

**Основна затримка:** 100ms між повідомленнями (~10/сек). Для 50 чатів → ~5 секунд.

**429 Too Many Requests:** якщо Telegram повертає 429, бот читає поле `retry_after` з відповіді, чекає вказану кількість секунд і робить **одну повторну спробу**. Якщо знову помилка — пише у звіт як failed.

**Dead chat detection:** помилки з текстом `bot was kicked`, `bot is not a member`, `chat not found`, `deactivated`, `Forbidden` класифікуються як "мертвий чат" і додаються до `deadChatIds` в `BroadcastResult`. Після розсилки в звіті з'являється кнопка `🗑 Видалити недоступні (N)`.

**Group→supergroup migration:** якщо Telegram повертає `migrate_to_chat_id` — бот автоматично оновлює ID в `chats.json` і повторює відправку з новим ID.

**Глобальний обробник помилок:** `bot.catch()` логує в консоль і надсилає сповіщення в адмін-чат щоб адмін знав про збої.

---

## Стан бота (in-memory)

Всі стани в пам'яті — очищаються при перезапуску (прийнятно для single-instance бота).

| Змінна | Тип | Призначення |
|--------|-----|-------------|
| `waitingForContent` | `Set<number>` | Адмін-чат очікує контент для розсилки |
| `waitingForCustomTime` | `Set<number>` | Адмін-чат очікує введення HH:MM для планування |
| `broadcastSessions` | `Map<number, BroadcastSession>` | Активна сесія: контент + вибір чатів |
| `scheduledBroadcasts` | `Map<string, ScheduledBroadcast>` | Заплановані розсилки, ключ — 8-символьний токен (підтримується кілька одночасно) |
| `checkchatsDeadIds` | `Map<number, number[]>` | Мертві чати з останнього `/checkchats` |
| `cleanupTokens` | `Map<string, number[]>` | Мертві чати зі звіту розсилки (token-based, обмежено 50 записами) |

---

## Persistent Storage (`data/chats.json`)

```json
[
  {
    "id": -1001234567890,
    "title": "Чат партнера А",
    "addedAt": "2025-03-01T10:00:00.000Z",
    "lastBroadcast": "2025-03-22T14:30:00.000Z"
  },
  {
    "id": -1009876543210,
    "title": "Чат партнера Б",
    "addedAt": "2025-03-01T10:00:00.000Z",
    "removedAt": "2025-03-22T18:00:00.000Z"
  }
]
```

Поле `removedAt` — soft-delete: чат не видаляється з файлу, лише виключається з розсилки. `/removedchats` показує такі записи і дозволяє відновити.

Поле `lastBroadcast` оновлюється після кожного успішного `copyMessage`.

Файл читається синхронно — Node.js single-thread гарантує відсутність race conditions.

### Функції storage.ts

| Функція | Опис |
|---------|------|
| `loadChats()` | Активні чати (без `removedAt`) |
| `loadRemovedChats()` | Видалені чати (з `removedAt`) |
| `addChat(chat)` | Додає або відновлює (якщо є `removedAt`) |
| `removeChat(id)` | Soft-delete: встановлює `removedAt` |
| `removeChats(ids[])` | Bulk soft-delete |
| `restoreChat(id)` | Прибирає `removedAt` |
| `migrateChat(old, new)` | Оновлює ID при group→supergroup |
| `updateLastBroadcast(id)` | Оновлює `lastBroadcast` |
| `getLastGlobalBroadcast()` | ISO timestamp останньої розсилки по всіх чатах |

---

## /checkchats

Для кожного чату викликає `getChatMember(chatId, botId)` з затримкою 80ms між запитами:

| Статус | Відображення |
|--------|-------------|
| `administrator` / `creator` | ✅ Назва чату |
| `member` | ⚠️ Назва чату *(учасник, не адмін)* |
| `left` / `kicked` / помилка | ❌ Назва чату |

Якщо є мертві чати — показується кнопка `🗑 Видалити недоступні (N)`.
IDs зберігаються в `checkchatsDeadIds` до натискання кнопки або наступного `/checkchats`.

---

## /removechat — пагінація

8 чатів на сторінку. Callback data кодує поточну сторінку щоб після видалення список оновлювався на місці:

```
Виберіть чат для видалення:
1–8 з 50 чат(ів)

[🗑 Чат партнера А]
[🗑 Чат партнера Б]
...
[◀️]  [1 / 7]  [▶️]
[↩️ Закрити]
```

Видалення — soft-delete (встановлює `removedAt`). Чат можна відновити через `/removedchats`.

---

## /scheduled — заплановані розсилки

- Кожна запланована розсилка зберігається в `scheduledBroadcasts` під унікальним токеном
- Підтримується **необмежена кількість** запланованих розсилок одночасно
- `/scheduled` показує список з кнопкою скасування для кожної окремо
- Після скасування список оновлюється в тому ж повідомленні
- **⚠️ Скасовуються при перезапуску бота/контейнера** — адмін попереджений в `/help`

---

## /addchat — додавання чату

**Варіант 1:** `/addchat -1001234567890` — бот перевіряє що він є учасником і додає.

**Варіант 2 (forwarding):** переслати пост написаний **від імені групи або каналу** (анонімний адмін / публікація каналу). Бот зчитує `forward_origin` (тип `channel` або `chat`) або legacy поле `forward_from_chat`.

> **Обмеження Telegram:** при пересиланні повідомлення звичайного учасника джерельний чат не передається — Telegram не розкриває цю інформацію з міркувань конфіденційності.

---

## Callback data — конвенції

| Prefix / значення | Опис |
|-------------------|------|
| `rm_p{page}_{chatId}` | Soft-видалити чат, залишитись на сторінці `page` |
| `rmpage_{page}` | Перейти на сторінку `page` в /removechat |
| `noop` | Кнопка-індикатор (поточна сторінка), без дії |
| `cancel_remove` | Закрити меню /removechat |
| `restore_{chatId}` | Відновити видалений чат |
| `addchat_{chatId}` | Підтвердити додавання чату після forwarding |
| `cancel_add` | Відхилити пропозицію додати чат |
| `cancel_broadcast` | Скасувати активну сесію розсилки |
| `broadcast_all` | Надіслати в усі чати |
| `broadcast_selected` | Надіслати у вибрані чати (зберігає selectedChatIds) |
| `broadcast_select` | Показати checkbox keyboard |
| `subset_toggle_{chatId}` | Перемкнути один чат |
| `subset_all` / `subset_none` | Вибрати / зняти всі |
| `subset_done` | Підтвердити вибір і показати confirm keyboard |
| `sched_30` / `sched_60` / `sched_120` | Запланувати через 30/60/120 хв |
| `sched_custom` | Перейти до введення свого часу HH:MM |
| `cancel_sched_{token}` | Скасувати конкретну заплановану розсилку |
| `checkchats_remove_dead` | Видалити мертві чати після /checkchats |
| `cleanup_{token}` | Видалити мертві чати після розсилки |

> Ліміт Telegram: 64 байти на callback data. Для cleanup і scheduled використовується 8-символьний токен замість списку ID.

---

## Graceful Shutdown

`index.ts` перехоплює `SIGINT` та `SIGTERM`. Grammy завершує обробку поточного update перед зупинкою — розсилка не обривається в середині при `docker compose restart`.

---

## Довгі повідомлення

`/list` і `/checkchats` з 50 чатами можуть перевищити ліміт Telegram (4096 символів).
Функція `sendLong()` автоматично розбиває повідомлення по блоках `\n\n` і надсилає частинами.

---

## Docker

**Multi-stage Dockerfile:**
- `builder`: `node:22-alpine`, встановлює всі залежності, компілює TypeScript
- `runner`: `node:22-alpine`, тільки prod-залежності + `dist/`. Dev-інструменти не потрапляють в образ
- Розмір фінального образу: ~57 MB

**docker-compose.yml:**
- `restart: unless-stopped` — автоматичний підйом після ребуту сервера
- `TZ=Europe/Kyiv` — коректний часовий пояс для запланованих розсилок
- `./data:/app/data` bind mount — `chats.json` зберігається на хості поза контейнером
- Ротація логів: 10 MB × 3 файли

---

## Деплой

```bash
# Сервер: скопіювати, налаштувати, запустити
scp -r . user@server:/opt/ax-bot
ssh user@server "cd /opt/ax-bot && cp .env.example .env && nano .env"
ssh user@server "cd /opt/ax-bot && docker compose up -d"

# Оновити після змін у коді
docker compose up -d --build

# Локальна розробка
npm run dev
```

---

## Функціонал

| Функція | Реалізація |
|---------|------------|
| Авто-реєстрація/видалення чатів | `my_chat_member` update |
| Розсилка всіх типів медіа | `copyMessage` API |
| Rate limiting | 100ms delay + 429 retry |
| Group→supergroup migration | `migrate_to_chat_id` в broadcaster |
| `/checkchats` — перевірка статусу | `getChatMember` без відправки |
| Авто-пропозиція очищення після розсилки | `deadChatIds` + cleanup token |
| `lastBroadcast` + відносний час в `/list` | запис при кожному успішному send |
| Видалення службових повідомлень | `deleteMessage` після розсилки |
| Статистика в `/start` | `getLastGlobalBroadcast()` |
| Відкладена розсилка (30хв / 1год / 2год / свій час) | `setTimeout` in-memory, ключ = токен |
| Кілька запланованих розсилок одночасно | `Map<string, ScheduledBroadcast>` |
| `/scheduled` — керування запланованими | inline-кнопки per-entry |
| Розсилка в частину чатів | checkbox keyboard + `BroadcastSession` |
| Soft-delete чатів | поле `removedAt` в `ChatRecord` |
| `/removedchats` — відновлення чатів | `restoreChat()` + inline-кнопки |
| `/addchat` — додавання за ID або forwarding | `getChat` + `getChatMember` verify |
| Пагінація в `/removechat` (8/стор.) | page encoded in callback data |
| Graceful shutdown | `SIGTERM`/`SIGINT` → `bot.stop()` |
| Сповіщення адміна про збої | `bot.catch()` → `sendMessage` |
| Розбивка довгих повідомлень | `sendLong()` helper |

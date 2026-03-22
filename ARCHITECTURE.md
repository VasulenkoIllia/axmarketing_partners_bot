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
  utils.ts        — timeAgo(), formatTime(), nextTomorrow0900(), token()
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

---

## Команди

| Команда | Дія |
|---------|-----|
| `/start` | Привітання + статистика (чатів, остання розсилка, запланована) |
| `/help` | Інструкція з нагадуванням про обмеження |
| `/addlink` | Deep link для додавання бота в групу/канал з правами адміна |
| `/list` | Список чатів + відносний час останньої розсилки по кожному |
| `/checkchats` | Перевірити статус бота в кожному чаті без відправки повідомлень |
| `/broadcast` | Запустити розсилку |
| `/removechat` | Видалити чат зі списку (пагінована inline-клавіатура, 8 на сторінку) |
| `/cancel` | Скасувати поточну операцію або заплановану розсилку |

---

## Потік роботи

### Автоматична реєстрація чатів

```
Бот доданий в групу
  └─► my_chat_member (new: member/admin)
        └─► addChat() → chats.json
              └─► сповіщення в адмін-чат: "✅ Доданий до: Назва"

Бот видалений з групи
  └─► my_chat_member (new: left/kicked)
        └─► removeChat() → chats.json
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
                          ├─► [⏰ 30 хв / 1 год / 2 год / Завтра 9:00]
                          │     └─► setTimeout(delayMs)
                          │           └─► при спрацюванні: executeBroadcast()
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

**Глобальний обробник помилок:** `bot.catch()` логує в консоль і надсилає сповіщення в адмін-чат щоб адмін знав про збої.

---

## Стан бота (in-memory)

Всі стани в пам'яті — очищаються при перезапуску (прийнятно для single-instance бота).

| Змінна | Тип | Призначення |
|--------|-----|-------------|
| `waitingForContent` | `Set<chatId>` | Адмін-чат очікує контент для розсилки |
| `broadcastSessions` | `Map<chatId, BroadcastSession>` | Активна сесія: контент + вибір чатів |
| `scheduledBroadcasts` | `Map<chatId, ScheduledBroadcast>` | Запланована розсилка + `setTimeout` handle |
| `checkchatsDeadIds` | `Map<chatId, number[]>` | Мертві чати з останнього `/checkchats` |
| `cleanupTokens` | `Map<token, number[]>` | Мертві чати зі звіту розсилки (token-based, обмежено 50 записами) |

---

## Persistent Storage (`data/chats.json`)

```json
[
  {
    "id": -1001234567890,
    "title": "Чат партнера А",
    "addedAt": "2025-03-01T10:00:00.000Z",
    "lastBroadcast": "2025-03-22T14:30:00.000Z"
  }
]
```

Поле `lastBroadcast` оновлюється після кожного успішного `copyMessage`.
Файл читається синхронно — Node.js single-thread гарантує відсутність race conditions.

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

Після видалення клавіатура оновлюється — меню не закривається, можна видалити кілька.

---

## Callback data — конвенції

| Prefix / значення | Опис |
|-------------------|------|
| `rm_p{page}_{chatId}` | Видалити чат, залишитись на сторінці `page` |
| `rmpage_{page}` | Перейти на сторінку `page` в /removechat |
| `noop` | Кнопка-індикатор (поточна сторінка), без дії |
| `cancel_remove` | Закрити меню /removechat |
| `cancel_broadcast` | Скасувати розсилку |
| `broadcast_all` | Надіслати в усі чати |
| `broadcast_select` | Показати checkbox keyboard |
| `subset_toggle_{chatId}` | Перемкнути один чат |
| `subset_all` / `subset_none` | Вибрати / зняти всі |
| `subset_done` | Підтвердити вибір і надіслати |
| `sched_30` / `sched_60` / `sched_120` | Запланувати через 30/60/120 хв |
| `sched_tom0900` | Запланувати на завтра о 9:00 |
| `checkchats_remove_dead` | Видалити мертві чати після /checkchats |
| `cleanup_{token}` | Видалити мертві чати після розсилки |

> Ліміт Telegram: 64 байти на callback data. Для cleanup використовується 8-символьний токен замість списку ID.

---

## Заплановані розсилки

- Реалізовані через `setTimeout` в пам'яті
- **⚠️ Скасовуються при перезапуску бота/контейнера** — адмін попереджений в `/help`
- При спрацюванні: список чатів завантажується заново (враховує зміни з моменту планування)
- `/cancel` скасовує таймер (`clearTimeout`) та редагує статусне повідомлення

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

| # | Функція | Реалізація |
|---|---------|------------|
| — | Авто-реєстрація/видалення чатів | `my_chat_member` update |
| — | Розсилка всіх типів медіа | `copyMessage` API |
| — | Rate limiting | 100ms delay + 429 retry |
| 1 | `/checkchats` — перевірка статусу | `getChatMember` без відправки |
| 2 | Авто-пропозиція очищення після розсилки | `deadChatIds` + cleanup token |
| 3 | `lastBroadcast` + відносний час в `/list` | запис при кожному успішному send |
| 4 | Видалення службових повідомлень | `deleteMessage` після розсилки |
| 5 | Статистика в `/start` | `getLastGlobalBroadcast()` |
| 6 | Відкладена розсилка (4 варіанти) | `setTimeout` in-memory |
| 7 | Розсилка в частину чатів | checkbox keyboard + `BroadcastSession` |
| — | Пагінація в `/removechat` (8/стор.) | page encoded in callback data |
| — | Graceful shutdown | `SIGTERM`/`SIGINT` → `bot.stop()` |
| — | Сповіщення адміна про збої | `bot.catch()` → `sendMessage` |
| — | Розбивка довгих повідомлень | `sendLong()` helper |

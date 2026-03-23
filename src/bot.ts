import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config';
import { addChat, removeChat, removeChats, restoreChat, loadChats, loadRemovedChats, getLastGlobalBroadcast } from './storage';
import { broadcast } from './broadcaster';
import { BroadcastSession, ChatRecord, ScheduledBroadcast } from './types';
import { timeAgo, formatTime, nextOccurrenceOf, isTomorrow, token } from './utils';

export const bot = new Bot(config.botToken);

// Cached bot ID — fetched once on first use
let _botId: number | undefined;
async function getBotId(): Promise<number> {
  if (!_botId) _botId = (await bot.api.getMe()).id;
  return _botId;
}

// ─── Message helpers ──────────────────────────────────────────────────────────

/** Splits text on blank lines and sends in multiple messages if > 4000 chars. */
async function sendLong(
  chatId: number,
  text: string,
  opts: Parameters<typeof bot.api.sendMessage>[2] = {},
): Promise<void> {
  const MAX = 4000;
  if (text.length <= MAX) {
    await bot.api.sendMessage(chatId, text, opts);
    return;
  }
  const blocks = text.split('\n\n');
  let chunk = '';
  const { reply_markup, ...optsWithoutMarkup } = opts as Record<string, unknown>;
  for (const block of blocks) {
    if (chunk.length + block.length + 2 > MAX) {
      await bot.api.sendMessage(chatId, chunk.trim(), optsWithoutMarkup as typeof opts);
      chunk = '';
    }
    chunk += (chunk ? '\n\n' : '') + block;
  }
  // Only the last chunk gets the reply_markup
  if (chunk.trim()) await bot.api.sendMessage(chatId, chunk.trim(), opts);
}

// ─── In-memory state ──────────────────────────────────────────────────────────

/** Admin is currently expected to send broadcast content. */
const waitingForContent = new Set<number>();

/** Admin typed "Свій час" and we expect a HH:MM reply next. */
const waitingForCustomTime = new Set<number>();

/** Active broadcast session (pending content + subset selection). */
const broadcastSessions = new Map<number, BroadcastSession>();

/** Pending scheduled broadcasts keyed by token. Multiple per admin are allowed. */
const scheduledBroadcasts = new Map<string, ScheduledBroadcast>();

/** Dead chat IDs found by /checkchats, keyed by admin chatId. */
const checkchatsDeadIds = new Map<number, number[]>();

/** Token-keyed dead chat IDs from broadcast reports (for "remove failed" button). */
const cleanupTokens = new Map<string, number[]>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAdmin(chatId: number): boolean {
  return config.adminChatIds.includes(chatId);
}

/** Send a message to all admin chats. Errors are swallowed. */
async function notifyAdmins(text: string, opts: Parameters<typeof bot.api.sendMessage>[2] = {}): Promise<void> {
  await Promise.all(
    config.adminChatIds.map((id) => bot.api.sendMessage(id, text, opts).catch(() => {})),
  );
}

// ─── /removechat pagination ───────────────────────────────────────────────────

const REMOVE_PAGE_SIZE = 8;

function buildRemoveKeyboard(
  chats: ChatRecord[],
  page: number,
): { text: string; keyboard: InlineKeyboard } {
  const totalPages = Math.ceil(chats.length / REMOVE_PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * REMOVE_PAGE_SIZE;
  const pageChats = chats.slice(start, start + REMOVE_PAGE_SIZE);

  const kb = new InlineKeyboard();
  for (const chat of pageChats) {
    // Truncate long names so the button stays readable
    const label = chat.title.length > 28 ? chat.title.slice(0, 27) + '…' : chat.title;
    kb.text(`🗑 ${label}`, `rm_p${safePage}_${chat.id}`).row();
  }

  // Navigation row — only when there are multiple pages
  if (totalPages > 1) {
    if (safePage > 0) kb.text('◀️', `rmpage_${safePage - 1}`);
    kb.text(`${safePage + 1} / ${totalPages}`, 'noop');
    if (safePage < totalPages - 1) kb.text('▶️', `rmpage_${safePage + 1}`);
    kb.row();
  }

  kb.text('↩️ Закрити', 'cancel_remove');

  const from = start + 1;
  const to = Math.min(start + REMOVE_PAGE_SIZE, chats.length);
  const text =
    `Виберіть чат для видалення:\n` +
    `<i>${from}–${to} з ${chats.length} чат(ів)</i>`;

  return { text, keyboard: kb };
}

/** Shown after content is sent — before audience is chosen. */
function buildConfirmKeyboard(count: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(`✅ Всім (${count})`, 'broadcast_all')
    .text('🎯 Вибрати чати', 'broadcast_select')
    .row()
    .text('⏰ 30 хв', 'sched_30')
    .text('⏰ 1 год', 'sched_60')
    .text('⏰ 2 год', 'sched_120')
    .text('🕐 Свій час', 'sched_custom')
    .row()
    .text('❌ Скасувати', 'cancel_broadcast');
}

/** Shown after subset is confirmed — uses broadcast_selected to preserve the selection. */
function buildSubsetConfirmKeyboard(count: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(`✅ Надіслати вибраним (${count})`, 'broadcast_selected')
    .row()
    .text('⏰ 30 хв', 'sched_30')
    .text('⏰ 1 год', 'sched_60')
    .text('⏰ 2 год', 'sched_120')
    .text('🕐 Свій час', 'sched_custom')
    .row()
    .text('❌ Скасувати', 'cancel_broadcast');
}

function buildSubsetKeyboard(session: BroadcastSession): InlineKeyboard {
  const chats = loadChats();
  const kb = new InlineKeyboard();
  for (const chat of chats) {
    const icon = session.selectedChatIds.has(chat.id) ? '☑️' : '☐';
    kb.text(`${icon} ${chat.title}`, `subset_toggle_${chat.id}`).row();
  }
  kb.text('☑️ Всі', 'subset_all').text('☐ Жодного', 'subset_none').row();
  if (session.selectedChatIds.size > 0) {
    kb.text(`✅ Відіслати вибраним (${session.selectedChatIds.size})`, 'subset_done').row();
  }
  kb.text('❌ Скасувати', 'cancel_broadcast');
  return kb;
}

function buildReport(
  results: Awaited<ReturnType<typeof broadcast>>,
  adminChatId: number,
): { text: string; keyboard: InlineKeyboard | undefined } {
  let text = `📊 <b>Звіт розсилки:</b>\n✅ Успішно: ${results.success}`;

  if (results.failed > 0) {
    text += `\n❌ Помилок: ${results.failed}\n\n<b>Деталі:</b>\n`;
    text += results.errors.map((e) => `• ${e.chat.title}: ${e.error}`).join('\n');
  }

  if (results.deadChatIds.length === 0) return { text, keyboard: undefined };

  const t = token();
  cleanupTokens.set(t, results.deadChatIds);
  // Limit map growth: remove oldest entries beyond 50
  if (cleanupTokens.size > 50) {
    cleanupTokens.delete(cleanupTokens.keys().next().value!);
  }

  const kb = new InlineKeyboard().text(
    `🗑 Видалити недоступні (${results.deadChatIds.length})`,
    `cleanup_${t}`,
  );
  return { text, keyboard: kb };
}

async function executeBroadcast(
  adminChatId: number,
  processingMsgId: number | undefined,
  session: BroadcastSession,
): Promise<void> {
  const allChats = loadChats();
  const targets = session.selectedChatIds.size < allChats.length
    ? allChats.filter((c) => session.selectedChatIds.has(c.id))
    : allChats;

  const results = await broadcast(
    bot,
    targets,
    session.pending.sourceChatId,
    session.pending.messageId,
  );

  // Feature 4: delete the "⏳ Sending..." service message
  if (processingMsgId) {
    await bot.api.deleteMessage(adminChatId, processingMsgId).catch(() => {});
  }

  const { text, keyboard } = buildReport(results, adminChatId);
  await bot.api.sendMessage(adminChatId, text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

// ─── Auto-register / unregister partner chats ─────────────────────────────────

bot.on('my_chat_member', async (ctx) => {
  const chat = ctx.chat;
  if (config.adminChatIds.includes(chat.id) || chat.type === 'private') return;

  const newStatus = ctx.myChatMember.new_chat_member.status;
  const chatTitle = (chat as { title?: string }).title ?? String(chat.id);

  if (newStatus === 'member' || newStatus === 'administrator') {
    addChat({ id: chat.id, title: chatTitle, addedAt: new Date().toISOString() });
    await notifyAdmins(
      `✅ Доданий до: <b>${chatTitle}</b>\nID: <code>${chat.id}</code>`,
      { parse_mode: 'HTML' },
    );
  } else if (newStatus === 'left' || newStatus === 'kicked') {
    const removed = removeChat(chat.id);
    if (removed) {
      await notifyAdmins(`❌ Видалений з: <b>${chatTitle}</b>`, { parse_mode: 'HTML' });
    }
  }
});

// ─── /start ───────────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;

  // Feature 5: show stats
  const chats = loadChats();
  const lastBroadcast = getLastGlobalBroadcast();

  const adminScheduled = [...scheduledBroadcasts.values()];

  let statsLine = `\n📊 Підключено чатів: <b>${chats.length}</b>`;
  statsLine += `\n📅 Остання розсилка: <b>${lastBroadcast ? timeAgo(lastBroadcast) : 'ніколи'}</b>`;
  if (adminScheduled.length > 0) {
    statsLine += `\n⏰ Запланованих розсилок: <b>${adminScheduled.length}</b> — /scheduled`;
  }

  await ctx.reply(
    '<b>AX Marketing Partners Bot</b>\n' +
      statsLine +
      '\n\n<b>Команди:</b>\n' +
      '/broadcast — розіслати повідомлення\n' +
      '/scheduled — заплановані розсилки\n' +
      '/addlink — посилання для додавання бота в чат\n' +
      '/addchat — додати чат за ID або постом групи/каналу\n' +
      '/removedchats — відновити видалені чати\n' +
      '/checkchats — перевірити статус чатів\n' +
      '/list — список підключених чатів\n' +
      '/removechat — видалити чат\n' +
      '/cancel — скасувати поточну дію\n' +
      '/help — інструкція',
    { parse_mode: 'HTML' },
  );
});

// ─── /help ────────────────────────────────────────────────────────────────────

bot.command('help', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;
  await ctx.reply(
    '<b>Інструкція:</b>\n\n' +
      '1. Додайте бота в партнерські групи — він збережеться автоматично\n' +
      '2. /broadcast → надішліть контент → виберіть: всім / вибраним / відкласти\n' +
      '3. /checkchats — перевірте чи бот ще активний у всіх чатах\n\n' +
      '<b>Підтримувані типи:</b>\n' +
      'Текст, фото, відео, документ, аудіо, голосове, кружок (video note)\n\n' +
      '<b>Команди:</b>\n' +
      '/broadcast — запустити розсилку\n' +
      '/scheduled — переглянути та скасувати заплановані розсилки\n' +
      '/addlink — посилання для швидкого додавання бота\n' +
      '/addchat [ID] — додати чат вручну або переслати пост від імені групи/каналу\n' +
      '/removedchats — переглянути та відновити видалені чати\n' +
      '/list — всі підключені чати\n' +
      '/checkchats — статус бота в кожному чаті\n' +
      '/removechat — видалити чат\n' +
      '/cancel — скасувати\n\n' +
      '⚠️ Заплановані розсилки скасовуються при перезапуску бота.',
    { parse_mode: 'HTML' },
  );
});

// ─── /list ────────────────────────────────────────────────────────────────────

bot.command('list', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;
  const chats = loadChats();
  if (chats.length === 0) {
    await ctx.reply('Немає підключених чатів. Додайте бота в групи.');
    return;
  }
  // Feature 3: show lastBroadcast relative time
  const lines = chats.map((c, i) => {
    const last = c.lastBroadcast ? timeAgo(c.lastBroadcast) : 'ніколи';
    return `${i + 1}. <b>${c.title}</b>\n   ID: <code>${c.id}</code>  |  Розсилка: ${last}`;
  });
  await sendLong(
    ctx.chat.id,
    `<b>Підключені чати (${chats.length}):</b>\n\n${lines.join('\n\n')}`,
    { parse_mode: 'HTML' },
  );
});

// ─── /checkchats ──────────────────────────────────────────────────────────────

bot.command('checkchats', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;
  const chats = loadChats();
  if (chats.length === 0) {
    await ctx.reply('Немає підключених чатів.');
    return;
  }

  const statusMsg = await ctx.reply(`🔍 Перевіряю ${chats.length} чат(ів)...`);
  const botId = ctx.me.id;

  const ok: string[] = [];
  const warn: string[] = [];
  const dead: string[] = [];
  const deadIds: number[] = [];

  for (const chat of chats) {
    try {
      const member = await bot.api.getChatMember(chat.id, botId);
      if (member.status === 'administrator' || member.status === 'creator') {
        ok.push(`✅ ${chat.title}`);
      } else if (member.status === 'member') {
        warn.push(`⚠️ ${chat.title} <i>(учасник, не адмін)</i>`);
      } else {
        dead.push(`❌ ${chat.title}`);
        deadIds.push(chat.id);
      }
    } catch {
      dead.push(`❌ ${chat.title}`);
      deadIds.push(chat.id);
    }
    // Small delay to avoid hitting getChatMember rate limits
    await new Promise((r) => setTimeout(r, 80));
  }

  await bot.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

  const sections: string[] = [];
  if (ok.length) sections.push(ok.join('\n'));
  if (warn.length) sections.push(warn.join('\n'));
  if (dead.length) sections.push(dead.join('\n'));

  let text = `<b>Статус чатів (${chats.length}):</b>\n\n${sections.join('\n\n')}`;

  let keyboard: InlineKeyboard | undefined;
  if (deadIds.length > 0) {
    checkchatsDeadIds.set(ctx.chat.id, deadIds);
    keyboard = new InlineKeyboard().text(
      `🗑 Видалити недоступні (${deadIds.length})`,
      'checkchats_remove_dead',
    );
  }

  await sendLong(ctx.chat.id, text, { parse_mode: 'HTML', reply_markup: keyboard });
});

// ─── /addchat ─────────────────────────────────────────────────────────────────

bot.command('addchat', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;

  const args = ctx.message?.text?.split(' ');
  const targetId = args?.[1] ? Number(args[1]) : null;

  if (!targetId || isNaN(targetId)) {
    await ctx.reply(
      'Використання: <code>/addchat -1001234567890</code>\n\n' +
        'Або перешліть сюди повідомлення, яке написано <b>від імені групи або каналу</b> ' +
        '(анонімний адмін / публікація каналу) — бот запропонує додати його до списку.\n\n' +
        '<i>⚠️ Пересилання особистих повідомлень учасників не містить інформацію про чат — ' +
        'це обмеження Telegram.</i>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  await addChatById(ctx.chat.id, targetId);
});

/** Verifies bot is in the chat and adds it to the broadcast list. */
async function addChatById(adminChatId: number, targetChatId: number): Promise<void> {
  const existing = loadChats().find((c) => c.id === targetChatId);
  if (existing) {
    await bot.api.sendMessage(
      adminChatId,
      `ℹ️ Чат <b>${existing.title}</b> вже є в списку.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  try {
    const botId = await getBotId();
    const [chatInfo, memberInfo] = await Promise.all([
      bot.api.getChat(targetChatId),
      bot.api.getChatMember(targetChatId, botId),
    ]);

    if (memberInfo.status === 'left' || memberInfo.status === 'kicked') {
      await bot.api.sendMessage(
        adminChatId,
        '❌ Бот не є учасником цього чату. Спочатку додайте його через /addlink',
      );
      return;
    }

    const title = ('title' in chatInfo ? chatInfo.title : undefined) ?? String(targetChatId);
    addChat({ id: targetChatId, title, addedAt: new Date().toISOString() });
    await bot.api.sendMessage(
      adminChatId,
      `✅ Чат <b>${title}</b> додано до списку розсилки.`,
      { parse_mode: 'HTML' },
    );
  } catch {
    await bot.api.sendMessage(adminChatId, '❌ Не вдалося знайти чат. Перевірте правильність ID.');
  }
}

// ─── /addlink ─────────────────────────────────────────────────────────────────

bot.command('addlink', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;

  const username = ctx.me.username;

  // Rights needed to broadcast in groups/supergroups:
  // manage_chat — marks bot as admin; post_messages — send in restricted groups;
  // delete_messages + invite_users — common admin utilities
  const groupRights = 'manage_chat+post_messages+delete_messages+invite_users';
  const groupLink = `https://t.me/${username}?startgroup=true&admin=${groupRights}`;

  // For channels the key right is post_messages (send messages as channel admin)
  const channelLink = `https://t.me/${username}?startchannel=true&admin=post_messages`;

  await ctx.reply(
    '<b>Додати бота в чат:</b>\n\n' +
      '👥 <b>Група або супергрупа</b>\n' +
      `<a href="${groupLink}">Натисни → вибери групу → підтверди права</a>\n\n` +
      '📢 <b>Канал</b>\n' +
      `<a href="${channelLink}">Натисни → вибери канал → підтверди права</a>\n\n` +
      '<i>Telegram автоматично запропонує зробити бота адміністратором ' +
      'з мінімально потрібними правами. Після підтвердження бот ' +
      'збережеться в списку і надішле сповіщення сюди.</i>',
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
  );
});

// ─── /removechat ──────────────────────────────────────────────────────────────

bot.command('removechat', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;
  const chats = loadChats();
  if (chats.length === 0) {
    await ctx.reply('Немає підключених чатів.');
    return;
  }

  const { text, keyboard } = buildRemoveKeyboard(chats, 0);
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
});

// ─── /broadcast ───────────────────────────────────────────────────────────────

bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;
  const chats = loadChats();
  if (chats.length === 0) {
    await ctx.reply('❌ Немає підключених чатів. Спочатку додайте бота в групи.');
    return;
  }

  waitingForContent.add(ctx.chat.id);
  waitingForCustomTime.delete(ctx.chat.id);
  broadcastSessions.delete(ctx.chat.id);

  await ctx.reply(
    `📨 Надішліть повідомлення для розсилки в <b>${chats.length}</b> чат(ів).\n\n` +
      'Підтримується: текст, фото, відео, документ, аудіо, голосове, кружок.\n' +
      '/cancel — скасувати',
    { parse_mode: 'HTML' },
  );
});

// ─── /cancel ──────────────────────────────────────────────────────────────────

bot.command('cancel', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;
  const chatId = ctx.chat.id;

  const hadContent = waitingForContent.has(chatId);
  const hadSession = broadcastSessions.has(chatId);

  waitingForContent.delete(chatId);
  waitingForCustomTime.delete(chatId);
  broadcastSessions.delete(chatId);

  if (hadContent || hadSession) {
    await ctx.reply('❌ Скасовано.');
    return;
  }

  const scheduledCount = scheduledBroadcasts.size;

  if (scheduledCount > 0) {
    await ctx.reply(
      `Немає активної операції.\n\nДля керування запланованими розсилками — /scheduled`,
    );
  } else {
    await ctx.reply('Немає активної операції.');
  }
});

// ─── /scheduled ───────────────────────────────────────────────────────────────

bot.command('scheduled', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;

  const entries = [...scheduledBroadcasts.entries()];

  if (entries.length === 0) {
    await ctx.reply('Немає запланованих розсилок.');
    return;
  }

  const kb = new InlineKeyboard();
  const lines: string[] = [];

  entries.forEach(([tok, s], i) => {
    lines.push(`${i + 1}. ⏰ <b>${s.label}</b>`);
    kb.text(`❌ Скасувати ${s.label}`, `cancel_sched_${tok}`).row();
  });

  await ctx.reply(
    `<b>Заплановані розсилки (${entries.length}):</b>\n\n${lines.join('\n')}`,
    { parse_mode: 'HTML', reply_markup: kb },
  );
});

// ─── /removedchats ────────────────────────────────────────────────────────────

bot.command('removedchats', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;

  const removed = loadRemovedChats();
  if (removed.length === 0) {
    await ctx.reply('Немає видалених чатів.');
    return;
  }

  const kb = new InlineKeyboard();
  const lines: string[] = [];

  removed.forEach((chat, i) => {
    const when = chat.removedAt ? timeAgo(chat.removedAt) : '—';
    lines.push(`${i + 1}. <b>${chat.title}</b> <i>(видалено ${when})</i>`);
    kb.text(`🔄 ${chat.title.length > 24 ? chat.title.slice(0, 23) + '…' : chat.title}`, `restore_${chat.id}`).row();
  });

  await ctx.reply(
    `<b>Видалені чати (${removed.length}):</b>\n\n${lines.join('\n')}\n\n` +
    `Натисніть кнопку щоб повернути чат до списку розсилки.`,
    { parse_mode: 'HTML', reply_markup: kb },
  );
});

// ─── Broadcast content capture ────────────────────────────────────────────────

bot.on('message', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;
  if ('text' in ctx.message && ctx.message.text?.startsWith('/')) return;

  // ── Custom time input ────────────────────────────────────────────────────────
  if (waitingForCustomTime.has(ctx.chat.id)) {
    const text = ('text' in ctx.message ? ctx.message.text?.trim() : '') ?? '';
    const match = text.match(/^(\d{1,2}):(\d{2})$/);

    if (!match) {
      await ctx.reply('Невірний формат. Введіть час як <b>ГГ:ХХ</b>, наприклад: <code>18:30</code>', {
        parse_mode: 'HTML',
      });
      return; // stay in waitingForCustomTime
    }

    const hour = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);

    if (hour > 23 || minute > 59) {
      await ctx.reply('Невірний час. Година: 0–23, хвилини: 0–59');
      return;
    }

    const session = broadcastSessions.get(ctx.chat.id);
    if (!session) {
      waitingForCustomTime.delete(ctx.chat.id);
      await ctx.reply('Сесія закінчилась. Почніть /broadcast заново.');
      return;
    }

    waitingForCustomTime.delete(ctx.chat.id);
    broadcastSessions.delete(ctx.chat.id);

    const fireAt = nextOccurrenceOf(hour, minute);
    const delayMs = fireAt.getTime() - Date.now();
    const fireLabel = formatTime(fireAt) + (isTomorrow(fireAt) ? ' (завтра)' : ' (сьогодні)');
    const capturedSession = { ...session, selectedChatIds: new Set(session.selectedChatIds) };
    const adminChatId = ctx.chat.id;
    const schedToken = token();

    const timerHandle = setTimeout(async () => {
      scheduledBroadcasts.delete(schedToken);
      await executeBroadcast(adminChatId, undefined, capturedSession);
    }, delayMs);

    const statusMsg = await ctx.reply(
      `⏰ Заплановано на <b>${fireLabel}</b>.\n/scheduled — керувати розсилками`,
      { parse_mode: 'HTML' },
    );

    scheduledBroadcasts.set(schedToken, {
      adminChatId,
      pending: session.pending,
      scheduledFor: fireAt,
      label: fireLabel,
      statusMessageId: statusMsg.message_id,
      timerHandle,
    });
    return;
  }

  // ── Forward from group/channel → offer to add to broadcast list ──────────────
  if (!waitingForContent.has(ctx.chat.id)) {
    const origin = ctx.message.forward_origin;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const forwardFromChat = (ctx.message as any).forward_from_chat as { id?: number; title?: string } | undefined;

    let sourceId: number | undefined;
    let sourceTitle: string | undefined;

    if (origin?.type === 'channel') {
      sourceId = origin.chat.id;
      sourceTitle = origin.chat.title;
    } else if (origin?.type === 'chat') {
      sourceId = origin.sender_chat.id;
      sourceTitle =
        ('title' in origin.sender_chat ? origin.sender_chat.title : undefined) ??
        String(origin.sender_chat.id);
    } else if (forwardFromChat?.id) {
      sourceId = forwardFromChat.id;
      sourceTitle = forwardFromChat.title ?? String(forwardFromChat.id);
    }

    if (sourceId !== undefined) {
      if (config.adminChatIds.includes(sourceId)) return;

      const alreadyAdded = loadChats().some((c) => c.id === sourceId);
      if (alreadyAdded) {
        await ctx.reply(`ℹ️ Чат <b>${sourceTitle}</b> вже є в списку розсилки.`, {
          parse_mode: 'HTML',
        });
        return;
      }

      const keyboard = new InlineKeyboard()
        .text('✅ Додати до розсилки', `addchat_${sourceId}`)
        .text('❌ Ні', 'cancel_add');

      await ctx.reply(
        `Додати <b>${sourceTitle}</b> до списку розсилки?`,
        { parse_mode: 'HTML', reply_markup: keyboard },
      );
    }
    return;
  }

  waitingForContent.delete(ctx.chat.id);
  const chats = loadChats();

  const session: BroadcastSession = {
    pending: { sourceChatId: ctx.message.chat.id, messageId: ctx.message.message_id },
    selectedChatIds: new Set(chats.map((c) => c.id)),
    isSelecting: false,
  };
  broadcastSessions.set(ctx.chat.id, session);

  await ctx.reply(
    `Надіслати це повідомлення?`,
    { reply_markup: buildConfirmKeyboard(chats.length) },
  );
});

// ─── Inline callbacks ─────────────────────────────────────────────────────────

bot.on('callback_query:data', async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId || !isAdmin(chatId)) {
    await ctx.answerCallbackQuery();
    return;
  }

  const data = ctx.callbackQuery.data;
  const msgId = ctx.callbackQuery.message?.message_id;

  // ── Remove chat pagination ────────────────────────────────────────────────────
  if (data === 'cancel_remove') {
    await ctx.editMessageText('Закрито.');
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === 'noop') {
    await ctx.answerCallbackQuery();
    return;
  }

  if (data.startsWith('rmpage_')) {
    const page = parseInt(data.slice('rmpage_'.length), 10);
    const chats = loadChats();
    const { text, keyboard } = buildRemoveKeyboard(chats, page);
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    await ctx.answerCallbackQuery();
    return;
  }

  if (data.startsWith('rm_p')) {
    // Format: rm_p{page}_{chatId}  (chatId can be negative)
    const body = data.slice('rm_p'.length);
    const sep = body.indexOf('_');
    const page = parseInt(body.slice(0, sep), 10);
    const targetId = Number(body.slice(sep + 1));

    removeChat(targetId);
    const chats = loadChats();

    if (chats.length === 0) {
      await ctx.editMessageText('Список підключених чатів порожній.');
      await ctx.answerCallbackQuery('✅ Видалено');
      return;
    }

    const { text, keyboard } = buildRemoveKeyboard(chats, page);
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    await ctx.answerCallbackQuery('✅ Видалено');
    return;
  }

  // ── Add chat via forward or /addchat ─────────────────────────────────────────
  if (data === 'cancel_add') {
    await ctx.editMessageText('Скасовано.');
    await ctx.answerCallbackQuery();
    return;
  }

  if (data.startsWith('addchat_')) {
    const targetId = Number(data.slice('addchat_'.length));
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    await ctx.answerCallbackQuery();
    await addChatById(chatId, targetId);
    return;
  }

  // ── Restore removed chat ─────────────────────────────────────────────────────
  if (data.startsWith('restore_')) {
    const targetId = Number(data.slice('restore_'.length));
    const ok = restoreChat(targetId);
    if (!ok) {
      await ctx.answerCallbackQuery('Чат не знайдено або вже активний.');
      return;
    }

    // Refresh the list in-place
    const remaining = loadRemovedChats();
    if (remaining.length === 0) {
      await ctx.editMessageText('✅ Чат повернено до розсилки. Видалених чатів більше немає.');
    } else {
      const kb = new InlineKeyboard();
      const lines: string[] = [];
      remaining.forEach((chat, i) => {
        const when = chat.removedAt ? timeAgo(chat.removedAt) : '—';
        lines.push(`${i + 1}. <b>${chat.title}</b> <i>(видалено ${when})</i>`);
        kb.text(`🔄 ${chat.title.length > 24 ? chat.title.slice(0, 23) + '…' : chat.title}`, `restore_${chat.id}`).row();
      });
      await ctx.editMessageText(
        `<b>Видалені чати (${remaining.length}):</b>\n\n${lines.join('\n')}\n\n` +
        `Натисніть кнопку щоб повернути чат до списку розсилки.`,
        { parse_mode: 'HTML', reply_markup: kb },
      );
    }
    await ctx.answerCallbackQuery('✅ Повернено до розсилки');
    return;
  }

  // ── /checkchats cleanup ───────────────────────────────────────────────────────
  if (data === 'checkchats_remove_dead') {
    const deadIds = checkchatsDeadIds.get(chatId) ?? [];
    const count = removeChats(deadIds);
    checkchatsDeadIds.delete(chatId);
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    await ctx.reply(`✅ Видалено ${count} недоступних чат(ів).`);
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Post-broadcast cleanup ────────────────────────────────────────────────────
  if (data.startsWith('cleanup_')) {
    const t = data.slice('cleanup_'.length);
    const deadIds = cleanupTokens.get(t) ?? [];
    const count = removeChats(deadIds);
    cleanupTokens.delete(t);
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    await ctx.reply(`✅ Видалено ${count} недоступних чат(ів).`);
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Cancel a specific scheduled broadcast ────────────────────────────────────
  if (data.startsWith('cancel_sched_')) {
    const schedToken = data.slice('cancel_sched_'.length);
    const sched = scheduledBroadcasts.get(schedToken);
    if (sched) {
      clearTimeout(sched.timerHandle);
      scheduledBroadcasts.delete(schedToken);
      await bot.api
        .editMessageText(chatId, sched.statusMessageId, `❌ Розсилку ${sched.label} скасовано.`)
        .catch(() => {});
    }

    // Refresh the /scheduled list in-place
    const remaining = [...scheduledBroadcasts.entries()];
    if (remaining.length === 0) {
      await ctx.editMessageText('✅ Скасовано. Немає більше запланованих розсилок.');
    } else {
      const kb = new InlineKeyboard();
      const lines: string[] = [];
      remaining.forEach(([tok, s], i) => {
        lines.push(`${i + 1}. ⏰ <b>${s.label}</b>`);
        kb.text(`❌ Скасувати ${s.label}`, `cancel_sched_${tok}`).row();
      });
      await ctx.editMessageText(
        `<b>Заплановані розсилки (${remaining.length}):</b>\n\n${lines.join('\n')}`,
        { parse_mode: 'HTML', reply_markup: kb },
      );
    }
    await ctx.answerCallbackQuery('✅ Скасовано');
    return;
  }

  // ── Cancel broadcast ──────────────────────────────────────────────────────────
  if (data === 'cancel_broadcast') {
    broadcastSessions.delete(chatId);
    await ctx.editMessageText('❌ Розсилку скасовано.');
    await ctx.answerCallbackQuery();
    return;
  }

  // From here on we need an active session
  const session = broadcastSessions.get(chatId);

  // ── Subset selection ──────────────────────────────────────────────────────────
  if (data === 'broadcast_select') {
    if (!session) { await ctx.answerCallbackQuery('Сесія закінчилась. Почніть /broadcast заново.'); return; }
    session.isSelecting = true;
    await ctx.editMessageText(
      `Виберіть чати для розсилки:\n<i>Вибрано: ${session.selectedChatIds.size}</i>`,
      { parse_mode: 'HTML', reply_markup: buildSubsetKeyboard(session) },
    );
    await ctx.answerCallbackQuery();
    return;
  }

  if (data.startsWith('subset_toggle_')) {
    if (!session) { await ctx.answerCallbackQuery('Сесія закінчилась.'); return; }
    const targetId = Number(data.slice('subset_toggle_'.length));
    if (session.selectedChatIds.has(targetId)) {
      session.selectedChatIds.delete(targetId);
    } else {
      session.selectedChatIds.add(targetId);
    }
    await ctx.editMessageReplyMarkup({ reply_markup: buildSubsetKeyboard(session) });
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === 'subset_all') {
    if (!session) { await ctx.answerCallbackQuery(); return; }
    loadChats().forEach((c) => session.selectedChatIds.add(c.id));
    await ctx.editMessageReplyMarkup({ reply_markup: buildSubsetKeyboard(session) });
    await ctx.answerCallbackQuery('Вибрано всі');
    return;
  }

  if (data === 'subset_none') {
    if (!session) { await ctx.answerCallbackQuery(); return; }
    session.selectedChatIds.clear();
    await ctx.editMessageReplyMarkup({ reply_markup: buildSubsetKeyboard(session) });
    await ctx.answerCallbackQuery('Скинуто');
    return;
  }

  if (data === 'subset_done') {
    if (!session) { await ctx.answerCallbackQuery('Сесія закінчилась.'); return; }
    if (session.selectedChatIds.size === 0) {
      await bot.api.answerCallbackQuery(ctx.callbackQuery.id, {
        text: '⚠️ Виберіть хоча б один чат',
        show_alert: true,
      });
      return;
    }
    session.isSelecting = false;
    const count = session.selectedChatIds.size;
    await ctx.editMessageText(
      `Надіслати в <b>${count}</b> вибраних чат(ів)?`,
      { parse_mode: 'HTML', reply_markup: buildSubsetConfirmKeyboard(count) },
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Immediate broadcast — all chats ──────────────────────────────────────────
  if (data === 'broadcast_all') {
    if (!session) { await ctx.answerCallbackQuery('Сесія закінчилась. Почніть /broadcast заново.'); return; }
    broadcastSessions.delete(chatId);
    const allChats = loadChats();
    session.selectedChatIds = new Set(allChats.map((c) => c.id));
    await ctx.editMessageText(`⏳ Надсилаю в ${allChats.length} чат(ів)...`);
    await ctx.answerCallbackQuery('Починаю розсилку...');
    await executeBroadcast(chatId, msgId, session);
    return;
  }

  // ── Immediate broadcast — selected chats only ─────────────────────────────────
  if (data === 'broadcast_selected') {
    if (!session) { await ctx.answerCallbackQuery('Сесія закінчилась. Почніть /broadcast заново.'); return; }
    const count = session.selectedChatIds.size;
    broadcastSessions.delete(chatId);
    await ctx.editMessageText(`⏳ Надсилаю в ${count} вибраних чат(ів)...`);
    await ctx.answerCallbackQuery('Починаю розсилку...');
    await executeBroadcast(chatId, msgId, session); // selectedChatIds stays as-is
    return;
  }

  // ── Custom time: prompt for HH:MM input ──────────────────────────────────────
  if (data === 'sched_custom') {
    if (!session) { await ctx.answerCallbackQuery('Сесія закінчилась. Почніть /broadcast заново.'); return; }
    waitingForCustomTime.add(chatId);
    await ctx.editMessageText(
      'Введіть час у форматі <b>ГГ:ХХ</b>\nНаприклад: <code>18:30</code>\n\n/cancel — скасувати',
      { parse_mode: 'HTML' },
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Scheduled broadcast (preset delays) ──────────────────────────────────────
  if (data.startsWith('sched_')) {
    if (!session) { await ctx.answerCallbackQuery('Сесія закінчилась. Почніть /broadcast заново.'); return; }

    const minutes = parseInt(data.slice('sched_'.length), 10);
    const delayMs = minutes * 60_000;
    const fireAt = new Date(Date.now() + delayMs);

    const capturedSession = { ...session, selectedChatIds: new Set(session.selectedChatIds) };
    broadcastSessions.delete(chatId);

    const fireLabel = formatTime(fireAt) + (isTomorrow(fireAt) ? ' (завтра)' : ' (сьогодні)');
    const schedToken = token();

    const timerHandle = setTimeout(async () => {
      scheduledBroadcasts.delete(schedToken);
      if (msgId) {
        await bot.api.deleteMessage(chatId, msgId).catch(() => {});
      }
      await executeBroadcast(chatId, undefined, capturedSession);
    }, delayMs);

    scheduledBroadcasts.set(schedToken, {
      adminChatId: chatId,
      pending: session.pending,
      scheduledFor: fireAt,
      label: fireLabel,
      statusMessageId: msgId ?? 0,
      timerHandle,
    });

    await ctx.editMessageText(
      `⏰ Заплановано на <b>${fireLabel}</b>.\n\n/scheduled — керувати розсилками`,
      { parse_mode: 'HTML' },
    );
    await ctx.answerCallbackQuery(`Заплановано на ${fireLabel}`);
    return;
  }

  await ctx.answerCallbackQuery();
});

// ─── Global error handler ─────────────────────────────────────────────────────

bot.catch((err) => {
  console.error('[Bot error]', err);
  const escaped = String(err.message ?? err)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  notifyAdmins(`⚠️ <b>Системна помилка:</b>\n<code>${escaped}</code>`, { parse_mode: 'HTML' });
});

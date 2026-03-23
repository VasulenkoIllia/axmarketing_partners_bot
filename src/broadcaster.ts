import { Bot, GrammyError } from 'grammy';
import { ChatRecord, BroadcastResult } from './types';
import { updateLastBroadcastBatch, migrateChat } from './storage';

const DELAY_MS = 100; // ~10 msg/sec — well within Telegram limits

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDeadChatError(message: string): boolean {
  return (
    message.includes('bot was kicked') ||
    message.includes('bot is not a member') ||
    message.includes('chat not found') ||
    message.includes('group chat was deactivated') ||
    message.includes('chat was deactivated') ||
    message.includes('Forbidden')
  );
}

/**
 * Attempts copyMessage with automatic handling of:
 * - 429 Too Many Requests: waits retry_after then retries once
 * - Group→supergroup migration: updates storage, retries with new ID
 *
 * Returns the actual chat ID used (may differ from input on migration).
 */
async function tryCopyMessage(
  bot: Bot,
  chat: ChatRecord,
  sourceChatId: number,
  messageId: number,
): Promise<number> {
  try {
    await bot.api.copyMessage(chat.id, sourceChatId, messageId);
    return chat.id;
  } catch (err: unknown) {
    if (!(err instanceof GrammyError)) throw err;

    // 429: wait retry_after and retry once
    if (err.error_code === 429) {
      const retryAfter = ((err.parameters as { retry_after?: number })?.retry_after ?? 5) * 1000;
      await sleep(retryAfter);
      await bot.api.copyMessage(chat.id, sourceChatId, messageId);
      return chat.id;
    }

    // Group was upgraded to a supergroup — Telegram provides the new chat ID
    const newChatId = (err.parameters as { migrate_to_chat_id?: number })?.migrate_to_chat_id;
    if (newChatId) {
      migrateChat(chat.id, newChatId); // update storage: old ID → new ID
      await bot.api.copyMessage(newChatId, sourceChatId, messageId);
      return newChatId;
    }

    throw err;
  }
}

/**
 * Sends a copy of a message to each chat with rate-limiting.
 * @param chats Already-filtered list of target chats.
 */
export async function broadcast(
  bot: Bot,
  chats: ChatRecord[],
  sourceChatId: number,
  messageId: number,
): Promise<BroadcastResult> {
  const result: BroadcastResult = { success: 0, failed: 0, errors: [], deadChatIds: [] };
  const succeededIds: number[] = [];

  for (const chat of chats) {
    try {
      const usedChatId = await tryCopyMessage(bot, chat, sourceChatId, messageId);
      succeededIds.push(usedChatId);
      result.success++;
    } catch (err: unknown) {
      result.failed++;
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ chat, error: message });
      if (isDeadChatError(message)) {
        result.deadChatIds.push(chat.id);
      }
    }
    await sleep(DELAY_MS);
  }

  // Single file write for all lastBroadcast updates
  updateLastBroadcastBatch(succeededIds);

  return result;
}

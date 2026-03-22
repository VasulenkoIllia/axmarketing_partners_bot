import { Bot, GrammyError } from 'grammy';
import { ChatRecord, BroadcastResult } from './types';
import { updateLastBroadcast } from './storage';

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

async function tryCopyMessage(
  bot: Bot,
  chatId: number,
  sourceChatId: number,
  messageId: number,
): Promise<void> {
  try {
    await bot.api.copyMessage(chatId, sourceChatId, messageId);
  } catch (err: unknown) {
    // On 429: wait retry_after seconds and try once more
    if (err instanceof GrammyError && err.error_code === 429) {
      const retryAfter = ((err.parameters as { retry_after?: number })?.retry_after ?? 5) * 1000;
      await sleep(retryAfter);
      await bot.api.copyMessage(chatId, sourceChatId, messageId); // let this throw if it fails again
      return;
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

  for (const chat of chats) {
    try {
      await tryCopyMessage(bot, chat.id, sourceChatId, messageId);
      updateLastBroadcast(chat.id);
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

  return result;
}

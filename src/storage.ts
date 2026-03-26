import fs from 'fs';
import path from 'path';
import { ChatRecord, PersistedSchedule } from './types';

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'chats.json');
const SCHEDULED_FILE = path.join(DATA_DIR, 'scheduled.json');

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** All records including removed ones. Deduplicates by ID on read. */
function loadAllChats(): ChatRecord[] {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) as ChatRecord[];
    const seen = new Set<number>();
    const deduped = raw.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
    // Clean up file if duplicates were found
    if (deduped.length !== raw.length) {
      console.log(`[Storage] Removed ${raw.length - deduped.length} duplicate chat(s) from chats.json`);
      saveChats(deduped);
    }
    return deduped;
  } catch {
    return [];
  }
}

function saveChats(chats: ChatRecord[]): void {
  ensureDataDir();
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(chats, null, 2), 'utf-8');
  fs.renameSync(tmp, DATA_FILE); // atomic on POSIX — prevents corruption on crash
}

/** Active chats only (no removedAt). Used for broadcasts, /list, etc. */
export function loadChats(): ChatRecord[] {
  return loadAllChats().filter((c) => !c.removedAt);
}

/** Chats that were removed but are still recoverable. */
export function loadRemovedChats(): ChatRecord[] {
  return loadAllChats().filter((c) => !!c.removedAt);
}

/** Add or restore a chat. If it exists with removedAt — restores it. */
export function addChat(chat: ChatRecord): void {
  const chats = loadAllChats();
  const existing = chats.find((c) => c.id === chat.id);
  if (existing) {
    if (existing.removedAt) {
      delete existing.removedAt;
      saveChats(chats);
    }
    // already active — no-op
  } else {
    chats.push(chat);
    saveChats(chats);
  }
}

/** Mark a chat as removed (soft delete). Returns false if not found or already removed. */
export function removeChat(chatId: number): boolean {
  const chats = loadAllChats();
  const chat = chats.find((c) => c.id === chatId);
  if (!chat || chat.removedAt) return false;
  chat.removedAt = new Date().toISOString();
  saveChats(chats);
  return true;
}

/** Bulk soft-remove. Returns count of actually removed chats. */
export function removeChats(chatIds: number[]): number {
  const chats = loadAllChats();
  const idSet = new Set(chatIds);
  const now = new Date().toISOString();
  let count = 0;
  for (const chat of chats) {
    if (idSet.has(chat.id) && !chat.removedAt) {
      chat.removedAt = now;
      count++;
    }
  }
  if (count > 0) saveChats(chats);
  return count;
}

/** Restore a previously removed chat. Returns false if not found. */
export function restoreChat(chatId: number): boolean {
  const chats = loadAllChats();
  const chat = chats.find((c) => c.id === chatId && c.removedAt);
  if (!chat) return false;
  delete chat.removedAt;
  saveChats(chats);
  return true;
}

/**
 * Handles group→supergroup migration: replaces old chat ID with new one.
 * Called automatically during broadcast when Telegram returns migrate_to_chat_id.
 */
export function migrateChat(oldChatId: number, newChatId: number): void {
  const chats = loadAllChats();
  const chat = chats.find((c) => c.id === oldChatId);
  if (!chat) return;
  chat.id = newChatId;
  // Remove any duplicate for the new ID
  const deduped = chats.filter((c) => c.id !== oldChatId || c === chat);
  const withoutDup = deduped.filter(
    (c, i, arr) => c.id !== newChatId || arr.indexOf(c) === i,
  );
  saveChats(withoutDup);
}

export function updateLastBroadcast(chatId: number): void {
  const chats = loadAllChats();
  const chat = chats.find((c) => c.id === chatId && !c.removedAt);
  if (chat) {
    chat.lastBroadcast = new Date().toISOString();
    saveChats(chats);
  }
}

/** Batch-update lastBroadcast for multiple chats in a single file write. */
export function updateLastBroadcastBatch(chatIds: number[]): void {
  if (chatIds.length === 0) return;
  const chats = loadAllChats();
  const idSet = new Set(chatIds);
  const now = new Date().toISOString();
  let changed = false;
  for (const chat of chats) {
    if (idSet.has(chat.id) && !chat.removedAt) {
      chat.lastBroadcast = now;
      changed = true;
    }
  }
  if (changed) saveChats(chats);
}

// ─── Scheduled broadcasts persistence ─────────────────────────────────────────

export function loadScheduled(): PersistedSchedule[] {
  if (!fs.existsSync(SCHEDULED_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SCHEDULED_FILE, 'utf-8')) as PersistedSchedule[];
  } catch {
    return [];
  }
}

export function saveScheduled(schedules: PersistedSchedule[]): void {
  ensureDataDir();
  const tmp = SCHEDULED_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(schedules, null, 2), 'utf-8');
  fs.renameSync(tmp, SCHEDULED_FILE);
}

export function addScheduledEntry(entry: PersistedSchedule): void {
  const all = loadScheduled();
  all.push(entry);
  saveScheduled(all);
}

export function removeScheduledEntry(token: string): void {
  const all = loadScheduled().filter((s) => s.token !== token);
  saveScheduled(all);
}

/** Returns ISO string of the most recent broadcast across all active chats, or null. */
export function getLastGlobalBroadcast(): string | null {
  const timestamps = loadChats()
    .filter((c) => c.lastBroadcast)
    .map((c) => c.lastBroadcast as string);
  if (timestamps.length === 0) return null;
  return timestamps.sort().at(-1)!;
}

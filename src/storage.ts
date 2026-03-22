import fs from 'fs';
import path from 'path';
import { ChatRecord } from './types';

const DATA_FILE = path.join(process.cwd(), 'data', 'chats.json');

function ensureDataDir(): void {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadChats(): ChatRecord[] {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) as ChatRecord[];
  } catch {
    return [];
  }
}

function saveChats(chats: ChatRecord[]): void {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(chats, null, 2), 'utf-8');
}

export function addChat(chat: ChatRecord): void {
  const chats = loadChats();
  if (!chats.some((c) => c.id === chat.id)) {
    chats.push(chat);
    saveChats(chats);
  }
}

export function removeChat(chatId: number): boolean {
  const chats = loadChats();
  const filtered = chats.filter((c) => c.id !== chatId);
  if (filtered.length === chats.length) return false;
  saveChats(filtered);
  return true;
}

/** Bulk removal. Returns count of actually removed chats. */
export function removeChats(chatIds: number[]): number {
  const chats = loadChats();
  const idSet = new Set(chatIds);
  const filtered = chats.filter((c) => !idSet.has(c.id));
  const removed = chats.length - filtered.length;
  if (removed > 0) saveChats(filtered);
  return removed;
}

export function updateLastBroadcast(chatId: number): void {
  const chats = loadChats();
  const chat = chats.find((c) => c.id === chatId);
  if (chat) {
    chat.lastBroadcast = new Date().toISOString();
    saveChats(chats);
  }
}

/** Returns ISO string of the most recent broadcast across all chats, or null. */
export function getLastGlobalBroadcast(): string | null {
  const chats = loadChats();
  const timestamps = chats.filter((c) => c.lastBroadcast).map((c) => c.lastBroadcast as string);
  if (timestamps.length === 0) return null;
  return timestamps.sort().at(-1)!;
}

export interface ChatRecord {
  id: number;
  title: string;
  addedAt: string;
  lastBroadcast?: string; // ISO timestamp of last successful copyMessage
  removedAt?: string;     // set when removed — kept for restore; absent = active
}

export interface PendingBroadcast {
  sourceChatId: number;
  messageId: number;
}

export interface BroadcastResult {
  success: number;
  failed: number;
  errors: Array<{ chat: ChatRecord; error: string }>;
  deadChatIds: number[]; // chats that returned 403/400 "bot was kicked / not found"
}

export interface ScheduledBroadcast {
  adminChatId: number;
  pending: PendingBroadcast;
  scheduledFor: Date;
  label: string; // human-readable time label, e.g. "18:30 (сьогодні)"
  statusMessageId: number; // so we can edit/delete it when it fires
  timerHandle: ReturnType<typeof setTimeout>;
}

/** In-memory session for a broadcast in progress */
export interface BroadcastSession {
  pending: PendingBroadcast;
  selectedChatIds: Set<number>; // managed during subset selection
  isSelecting: boolean;
}

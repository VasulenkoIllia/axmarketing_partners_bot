export interface ChatRecord {
  id: number;
  title: string;
  addedAt: string;
  lastBroadcast?: string; // ISO timestamp of last successful copyMessage
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
  pending: PendingBroadcast;
  scheduledFor: Date;
  statusMessageId: number; // so we can edit/delete it when it fires
  timerHandle: ReturnType<typeof setTimeout>;
}

/** In-memory session for a broadcast in progress */
export interface BroadcastSession {
  pending: PendingBroadcast;
  selectedChatIds: Set<number>; // managed during subset selection
  isSelecting: boolean;
}

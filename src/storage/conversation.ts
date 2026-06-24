import type { AppDatabase } from "./db.js";

export type ConversationRole = "user" | "assistant";

export type ConversationMessage = {
  role: ConversationRole;
  userId?: string;
  messageId?: string;
  content: string;
  createdAt: string;
};

type ConversationMessageRow = {
  role: ConversationRole;
  user_id: string | null;
  message_id: string | null;
  content: string;
  created_at: string;
};

export class ConversationStore {
  constructor(private readonly db: AppDatabase) {}

  addMessage(params: {
    conversationKey: string;
    role: ConversationRole;
    userId?: string;
    messageId?: string;
    content: string;
    createdAt?: Date;
  }): void {
    const content = params.content.trim();
    if (!content) return;

    this.db
      .prepare(
        `INSERT INTO conversation_messages (conversation_key, role, user_id, message_id, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.conversationKey,
        params.role,
        params.userId ?? null,
        params.messageId ?? null,
        content.slice(0, 4000),
        (params.createdAt ?? new Date()).toISOString(),
      );
  }

  getRecent(conversationKey: string, maxMessages: number, ttlHours: number): ConversationMessage[] {
    if (maxMessages <= 0) return [];

    const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT role, user_id, message_id, content, created_at
         FROM conversation_messages
         WHERE conversation_key = ? AND created_at >= ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(conversationKey, cutoff, maxMessages) as ConversationMessageRow[];

    return rows.reverse().map((row) => ({
      role: row.role,
      userId: row.user_id ?? undefined,
      messageId: row.message_id ?? undefined,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  prune(ttlHours: number): void {
    const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000).toISOString();
    this.db.prepare("DELETE FROM conversation_messages WHERE created_at < ?").run(cutoff);
  }
}

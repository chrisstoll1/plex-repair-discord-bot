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

export type ConversationSession = {
  conversationKey: string;
  messageCount: number;
  firstMessageAt: string;
  lastMessageAt: string;
  latestRole: ConversationRole;
  latestContent: string;
};

type ConversationSessionRow = {
  conversation_key: string;
  message_count: number;
  first_message_at: string;
  last_message_at: string;
  latest_role: ConversationRole;
  latest_content: string;
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

  listSessions(ttlHours: number): ConversationSession[] {
    const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT
           session.conversation_key,
           session.message_count,
           session.first_message_at,
           session.last_message_at,
           latest.role AS latest_role,
           latest.content AS latest_content
         FROM (
           SELECT
             conversation_key,
             COUNT(*) AS message_count,
             MIN(created_at) AS first_message_at,
             MAX(created_at) AS last_message_at,
             MAX(id) AS latest_id
           FROM conversation_messages
           WHERE created_at >= ?
           GROUP BY conversation_key
         ) session
         JOIN conversation_messages latest ON latest.id = session.latest_id
         ORDER BY session.last_message_at DESC`,
      )
      .all(cutoff) as ConversationSessionRow[];

    return rows.map((row) => ({
      conversationKey: row.conversation_key,
      messageCount: row.message_count,
      firstMessageAt: row.first_message_at,
      lastMessageAt: row.last_message_at,
      latestRole: row.latest_role,
      latestContent: row.latest_content,
    }));
  }

  deleteSession(conversationKey: string): boolean {
    return this.db.prepare("DELETE FROM conversation_messages WHERE conversation_key = ?").run(conversationKey).changes > 0;
  }
}

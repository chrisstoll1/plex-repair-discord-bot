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

  addExchange(params: {
    conversationKey: string;
    userId: string;
    userMessageId: string;
    userContent: string;
    userCreatedAt: Date;
    assistantUserId?: string;
    assistantContent?: string;
  }): void {
    const insert = this.db.prepare(
      `INSERT INTO conversation_messages (conversation_key, role, user_id, message_id, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const userContent = params.userContent.trim();
    const assistantContent = params.assistantContent?.trim();

    this.db.transaction(() => {
      this.recordProcessedMessage(params.userMessageId);
      if (userContent) {
        insert.run(
          params.conversationKey,
          "user",
          params.userId,
          params.userMessageId,
          userContent.slice(0, 4000),
          params.userCreatedAt.toISOString(),
        );
      }
      if (assistantContent) {
        insert.run(
          params.conversationKey,
          "assistant",
          params.assistantUserId ?? null,
          null,
          assistantContent.slice(0, 4000),
          new Date().toISOString(),
        );
      }
    })();
  }

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

  getRecent(conversationKey: string, maxMessages: number, ttlHours: number, includeBotReplies = true): ConversationMessage[] {
    if (maxMessages <= 0) return [];

    const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT role, user_id, message_id, content, created_at
         FROM conversation_messages
         WHERE conversation_key = ? AND created_at >= ? AND (? = 1 OR role <> 'assistant')
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(conversationKey, cutoff, includeBotReplies ? 1 : 0, maxMessages) as ConversationMessageRow[];

    return rows.reverse().map((row) => ({
      role: row.role,
      userId: row.user_id ?? undefined,
      messageId: row.message_id ?? undefined,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  hasMessageId(messageId: string): boolean {
    return this.db.prepare("SELECT 1 FROM processed_discord_messages WHERE message_id = ?").get(messageId) !== undefined;
  }

  recordProcessedMessage(messageId: string): void {
    this.db
      .prepare("INSERT INTO processed_discord_messages (message_id, created_at) VALUES (?, ?)")
      .run(messageId, new Date().toISOString());
  }

  prune(ttlHours: number): void {
    const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000).toISOString();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM conversation_messages WHERE created_at < ?").run(cutoff);
      this.db.prepare("DELETE FROM processed_discord_messages WHERE created_at < ?").run(cutoff);
    })();
  }

  listSessions(ttlHours: number): ConversationSession[] {
    const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `WITH ranked AS (
           SELECT
             conversation_key,
             role,
             content,
             COUNT(*) OVER (PARTITION BY conversation_key) AS message_count,
             MIN(created_at) OVER (PARTITION BY conversation_key) AS first_message_at,
             MAX(created_at) OVER (PARTITION BY conversation_key) AS last_message_at,
             ROW_NUMBER() OVER (PARTITION BY conversation_key ORDER BY created_at DESC, id DESC) AS row_number
           FROM conversation_messages
           WHERE created_at >= ?
         )
         SELECT
           conversation_key,
           message_count,
           first_message_at,
           last_message_at,
           role AS latest_role,
           content AS latest_content
         FROM ranked
         WHERE row_number = 1
         ORDER BY last_message_at DESC`,
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

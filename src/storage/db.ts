import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AppConfig } from "../config.js";

export type AppDatabase = Database.Database;

export function openDatabase(config: AppConfig): AppDatabase {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const db = new Database(config.databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      secret INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      actor TEXT,
      guild_id TEXT,
      channel_id TEXT,
      prompt TEXT,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_key TEXT NOT NULL,
      role TEXT NOT NULL,
      user_id TEXT,
      message_id TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_messages_key_created
      ON conversation_messages (conversation_key, created_at);

    CREATE INDEX IF NOT EXISTS idx_conversation_messages_created
      ON conversation_messages (created_at);

    CREATE INDEX IF NOT EXISTS idx_conversation_messages_message_id
      ON conversation_messages (message_id);

    CREATE TABLE IF NOT EXISTS processed_discord_messages (
      message_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    INSERT OR IGNORE INTO processed_discord_messages (message_id, created_at)
      SELECT message_id, created_at
      FROM conversation_messages
      WHERE message_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS tool_agent_tasks (
      id TEXT PRIMARY KEY,
      parent_task_id TEXT,
      conversation_key TEXT,
      guild_id TEXT,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      source_message_id TEXT,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      tool_profile TEXT NOT NULL,
      prompt TEXT NOT NULL,
      input_json TEXT,
      result_text TEXT,
      result_json TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tool_agent_tasks_conversation_updated
      ON tool_agent_tasks (conversation_key, updated_at);

    CREATE INDEX IF NOT EXISTS idx_tool_agent_tasks_status_updated
      ON tool_agent_tasks (status, updated_at);
  `);
}

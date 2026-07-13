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

    CREATE TABLE IF NOT EXISTS repair_cases (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('working', 'waiting', 'ready', 'verifying', 'resolved', 'needs_input', 'blocked', 'exhausted', 'cancelled')),
      guild_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      source TEXT NOT NULL,
      user_id TEXT NOT NULL,
      authorization_actor TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      checkpoint_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 20 CHECK (max_attempts > 0),
      expires_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      cancelled_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_repair_cases_status_updated
      ON repair_cases (status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_repair_cases_thread_updated
      ON repair_cases (guild_id, thread_id, updated_at);
    CREATE TRIGGER IF NOT EXISTS prevent_duplicate_repair_thread
      BEFORE INSERT ON repair_cases
      WHEN EXISTS (SELECT 1 FROM repair_cases WHERE guild_id = NEW.guild_id AND thread_id = NEW.thread_id)
      BEGIN
        SELECT RAISE(ABORT, 'duplicate repair thread');
      END;
    CREATE INDEX IF NOT EXISTS idx_repair_cases_lease
      ON repair_cases (lease_expires_at);

    CREATE TABLE IF NOT EXISTS repair_case_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT NOT NULL REFERENCES repair_cases(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      source_message_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_case_messages_source
      ON repair_case_messages (case_id, source_message_id) WHERE source_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_repair_case_messages_case
      ON repair_case_messages (case_id, id);

    CREATE TABLE IF NOT EXISTS repair_case_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT NOT NULL REFERENCES repair_cases(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      actor TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_repair_case_activity_case
      ON repair_case_activity (case_id, id);

    CREATE TABLE IF NOT EXISTS repair_case_wakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT NOT NULL REFERENCES repair_cases(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('timer', 'arr_event')),
      due_at TEXT,
      provider TEXT,
      event_type TEXT,
      media_id TEXT,
      created_at TEXT NOT NULL,
      CHECK ((type = 'timer' AND due_at IS NOT NULL) OR (type = 'arr_event' AND provider IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_case_wakes_one
      ON repair_case_wakes (case_id);
    CREATE INDEX IF NOT EXISTS idx_repair_case_wakes_due
      ON repair_case_wakes (type, due_at);
    CREATE INDEX IF NOT EXISTS idx_repair_case_wakes_event
      ON repair_case_wakes (type, provider, event_type, media_id);

    CREATE TABLE IF NOT EXISTS repair_inbound_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      media_id TEXT,
      media_ids_json TEXT,
      payload_json TEXT,
      received_at TEXT NOT NULL,
      UNIQUE (provider, event_id)
    );

    CREATE TABLE IF NOT EXISTS repair_case_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT NOT NULL REFERENCES repair_cases(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      dedupe_key TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'delivered', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      claimed_at TEXT,
      delivered_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_case_outbox_dedupe
      ON repair_case_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_repair_case_outbox_pending
      ON repair_case_outbox (status, available_at, id);
  `);
  ensureColumn(db, "repair_inbound_events", "media_ids_json", "TEXT");
  const now = new Date().toISOString();
  db.prepare(`UPDATE repair_cases SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
      cancelled_at = COALESCE(cancelled_at, ?)
    WHERE status NOT IN ('resolved','exhausted','cancelled') AND EXISTS (
      SELECT 1 FROM repair_cases newer
      WHERE newer.guild_id = repair_cases.guild_id AND newer.thread_id = repair_cases.thread_id
        AND (newer.updated_at > repair_cases.updated_at OR (newer.updated_at = repair_cases.updated_at AND newer.id > repair_cases.id))
    )`).run(now);
  db.exec("DELETE FROM repair_case_wakes WHERE case_id IN (SELECT id FROM repair_cases WHERE status = 'cancelled')");
  db.prepare("UPDATE repair_case_wakes SET due_at = ? WHERE type = 'arr_event' AND due_at IS NULL")
    .run(new Date(Date.now() + 6 * 60 * 60_000).toISOString());
}

function ensureColumn(db: AppDatabase, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

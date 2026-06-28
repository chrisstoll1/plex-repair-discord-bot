import type { AppDatabase } from "./db.js";

export type ToolAgentTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type ToolAgentTask = {
  id: string;
  parentTaskId?: string;
  conversationKey?: string;
  guildId?: string;
  channelId: string;
  userId: string;
  sourceMessageId?: string;
  status: ToolAgentTaskStatus;
  title: string;
  toolProfile: string;
  prompt: string;
  input?: unknown;
  resultText?: string;
  result?: unknown;
  error?: string;
  attempts: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
};

type ToolAgentTaskRow = {
  id: string;
  parent_task_id: string | null;
  conversation_key: string | null;
  guild_id: string | null;
  channel_id: string;
  user_id: string;
  source_message_id: string | null;
  status: ToolAgentTaskStatus;
  title: string;
  tool_profile: string;
  prompt: string;
  input_json: string | null;
  result_text: string | null;
  result_json: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

export type CreateToolAgentTaskParams = {
  id: string;
  parentTaskId?: string;
  conversationKey?: string;
  guildId?: string;
  channelId: string;
  userId: string;
  sourceMessageId?: string;
  title: string;
  toolProfile: string;
  prompt: string;
  input?: unknown;
};

const MAX_STORED_RESULT_TEXT = 16000;
const MAX_STORED_ERROR = 4000;

export class ToolAgentTaskStore {
  constructor(private readonly db: AppDatabase) {}

  create(params: CreateToolAgentTaskParams): ToolAgentTask {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tool_agent_tasks (
          id, parent_task_id, conversation_key, guild_id, channel_id, user_id, source_message_id,
          status, title, tool_profile, prompt, input_json, attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        params.id,
        params.parentTaskId ?? null,
        params.conversationKey ?? null,
        params.guildId ?? null,
        params.channelId,
        params.userId,
        params.sourceMessageId ?? null,
        params.title.slice(0, 240),
        params.toolProfile,
        params.prompt.slice(0, 12000),
        params.input === undefined ? null : JSON.stringify(params.input).slice(0, 12000),
        now,
        now,
      );

    const task = this.get(params.id);
    if (!task) throw new Error(`Failed to create tool-agent task ${params.id}`);
    return task;
  }

  get(id: string): ToolAgentTask | undefined {
    const row = this.db.prepare("SELECT * FROM tool_agent_tasks WHERE id = ?").get(id) as ToolAgentTaskRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(params: { conversationKey?: string; parentTaskId?: string; limit?: number } = {}): ToolAgentTask[] {
    const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
    if (params.parentTaskId) {
      const rows = this.db
        .prepare("SELECT * FROM tool_agent_tasks WHERE parent_task_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(params.parentTaskId, limit) as ToolAgentTaskRow[];
      return rows.map(fromRow);
    }
    if (params.conversationKey) {
      const rows = this.db
        .prepare("SELECT * FROM tool_agent_tasks WHERE conversation_key = ? ORDER BY created_at DESC LIMIT ?")
        .all(params.conversationKey, limit) as ToolAgentTaskRow[];
      return rows.map(fromRow);
    }

    const rows = this.db.prepare("SELECT * FROM tool_agent_tasks ORDER BY created_at DESC LIMIT ?").all(limit) as ToolAgentTaskRow[];
    return rows.map(fromRow);
  }

  countByStatus(statuses: ToolAgentTaskStatus[], userId?: string): number {
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => "?").join(", ");
    const whereUser = userId ? " AND user_id = ?" : "";
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM tool_agent_tasks WHERE status IN (${placeholders})${whereUser}`)
      .get(...statuses, ...(userId ? [userId] : [])) as { count: number };
    return row.count;
  }

  markRunning(id: string): ToolAgentTask | undefined {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE tool_agent_tasks SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(now, now, id);
    return this.get(id);
  }

  markSucceeded(id: string, resultText: string, result?: unknown): ToolAgentTask | undefined {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE tool_agent_tasks SET status = 'succeeded', result_text = ?, result_json = ?, error = NULL, finished_at = ?, updated_at = ? WHERE id = ?")
      .run(truncate(resultText, MAX_STORED_RESULT_TEXT), result === undefined ? null : truncate(JSON.stringify(result), MAX_STORED_RESULT_TEXT), now, now, id);
    return this.get(id);
  }

  markFailed(id: string, error: string): ToolAgentTask | undefined {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE tool_agent_tasks SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ?")
      .run(truncate(error, MAX_STORED_ERROR), now, now, id);
    return this.get(id);
  }

  cancel(id: string): ToolAgentTask | undefined {
    const now = new Date().toISOString();
    const task = this.get(id);
    if (!task || ["succeeded", "failed", "cancelled"].includes(task.status)) return task;
    this.db
      .prepare("UPDATE tool_agent_tasks SET status = 'cancelled', error = ?, finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE id = ?")
      .run(task.status === "running" ? "Cancellation requested while task was running" : null, now, now, id);
    return this.get(id);
  }

  failInterruptedRunningTasks(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE tool_agent_tasks SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE status = 'running'")
      .run("Process restarted while this tool-agent task was running", now, now);
    return result.changes;
  }
}

function fromRow(row: ToolAgentTaskRow): ToolAgentTask {
  return {
    id: row.id,
    parentTaskId: row.parent_task_id ?? undefined,
    conversationKey: row.conversation_key ?? undefined,
    guildId: row.guild_id ?? undefined,
    channelId: row.channel_id,
    userId: row.user_id,
    sourceMessageId: row.source_message_id ?? undefined,
    status: row.status,
    title: row.title,
    toolProfile: row.tool_profile,
    prompt: row.prompt,
    input: parseJson(row.input_json),
    resultText: row.result_text ?? undefined,
    result: parseJson(row.result_json),
    error: row.error ?? undefined,
    attempts: row.attempts,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 3)}...`;
}

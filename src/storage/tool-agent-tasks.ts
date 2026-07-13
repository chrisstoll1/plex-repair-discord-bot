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

export type ToolAgentTaskScope = {
  conversationKey?: string;
  userId: string;
};

const MAX_STORED_RESULT_TEXT = 16000;
const MAX_STORED_ERROR = 4000;

export class ToolAgentTaskStore {
  constructor(private readonly db: AppDatabase) {}

  create(params: CreateToolAgentTaskParams): ToolAgentTask {
    return this.createMany([params], Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)[0]!;
  }

  createMany(params: CreateToolAgentTaskParams[], maxActiveGlobal: number, maxActivePerUser: number): ToolAgentTask[] {
    if (params.length === 0) return [];
    const userId = params[0]?.userId;
    if (!userId || params.some((task) => task.userId !== userId)) throw new Error("A task batch must belong to one user");

    const insert = this.db.transaction(() => {
      const activeGlobal = this.countByStatus(["queued", "running"]);
      if (activeGlobal + params.length > maxActiveGlobal) throw new Error("Too many tool-agent tasks are already queued or running");
      const activeUser = this.countByStatus(["queued", "running"], userId);
      if (activeUser + params.length > maxActivePerUser) throw new Error("This user already has too many active tool-agent tasks");

      for (const task of params) {
        if (task.parentTaskId) {
          const parent = this.get(task.parentTaskId);
          if (!parent || parent.userId !== task.userId || parent.conversationKey !== task.conversationKey) {
            throw new Error(`Parent tool-agent task ${task.parentTaskId} was not found in this conversation`);
          }
        }
        this.insert(task);
      }
    });
    insert();
    return params.map((task) => this.get(task.id)!);
  }

  private insert(params: CreateToolAgentTaskParams): void {
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
        params.input === undefined ? null : serializeJsonInput(params.input, 12000),
        now,
        now,
      );

  }

  get(id: string): ToolAgentTask | undefined {
    const row = this.db.prepare("SELECT * FROM tool_agent_tasks WHERE id = ?").get(id) as ToolAgentTaskRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  getScoped(id: string, scope: ToolAgentTaskScope): ToolAgentTask | undefined {
    const row = this.db
      .prepare("SELECT * FROM tool_agent_tasks WHERE id = ? AND conversation_key IS ? AND user_id = ?")
      .get(id, scope.conversationKey ?? null, scope.userId) as ToolAgentTaskRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(params: { conversationKey?: string; userId?: string; parentTaskId?: string; limit?: number } = {}): ToolAgentTask[] {
    const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
    const where: string[] = [];
    const values: unknown[] = [];
    if (params.conversationKey !== undefined || params.userId !== undefined) {
      where.push("conversation_key IS ?");
      values.push(params.conversationKey ?? null);
    }
    if (params.userId !== undefined) {
      where.push("user_id = ?");
      values.push(params.userId);
    }
    if (params.parentTaskId !== undefined) {
      where.push("parent_task_id = ?");
      values.push(params.parentTaskId);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM tool_agent_tasks${clause} ORDER BY created_at DESC LIMIT ?`).all(...values, limit) as ToolAgentTaskRow[];
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
    const result = this.db
      .prepare("UPDATE tool_agent_tasks SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(now, now, id);
    return result.changes === 1 ? this.get(id) : undefined;
  }

  markSucceeded(id: string, resultText: string, result?: unknown): ToolAgentTask | undefined {
    const now = new Date().toISOString();
    const update = this.db
      .prepare("UPDATE tool_agent_tasks SET status = 'succeeded', result_text = ?, result_json = ?, error = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(truncate(resultText, MAX_STORED_RESULT_TEXT), result === undefined ? null : serializeJson(result, MAX_STORED_RESULT_TEXT), now, now, id);
    return update.changes === 1 ? this.get(id) : undefined;
  }

  markFailed(id: string, error: string): ToolAgentTask | undefined {
    const now = new Date().toISOString();
    const update = this.db
      .prepare("UPDATE tool_agent_tasks SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(truncate(error, MAX_STORED_ERROR), now, now, id);
    return update.changes === 1 ? this.get(id) : undefined;
  }

  markCancelled(id: string, error = "Task was cancelled"): ToolAgentTask | undefined {
    const now = new Date().toISOString();
    const update = this.db
      .prepare("UPDATE tool_agent_tasks SET status = 'cancelled', error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')")
      .run(truncate(error, MAX_STORED_ERROR), now, now, id);
    return update.changes === 1 ? this.get(id) : undefined;
  }

  failInterruptedRunningTasks(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE tool_agent_tasks SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE status = 'running'")
      .run("Process restarted while this tool-agent task was running", now, now);
    return result.changes;
  }

  cancelQueuedTasks(error = "Process restarted before this task started"): number {
    const now = new Date().toISOString();
    return this.db.prepare("UPDATE tool_agent_tasks SET status = 'cancelled', error = ?, finished_at = ?, updated_at = ? WHERE status = 'queued'")
      .run(truncate(error, MAX_STORED_ERROR), now, now).changes;
  }

  clearHistory(): number {
    return this.db
      .prepare(
        `DELETE FROM tool_agent_tasks
         WHERE status IN ('succeeded', 'failed', 'cancelled')
           AND id NOT IN (
             SELECT parent_task_id
             FROM tool_agent_tasks
             WHERE parent_task_id IS NOT NULL AND status IN ('queued', 'running')
           )`,
      )
      .run().changes;
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

function serializeJson(value: unknown, length: number): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return "null";
  if (serialized.length <= length) return serialized;

  let previewLength = Math.max(0, length - 40);
  let bounded = JSON.stringify({ truncated: true, preview: serialized.slice(0, previewLength) });
  while (bounded.length > length && previewLength > 0) {
    previewLength = Math.max(0, previewLength - (bounded.length - length));
    bounded = JSON.stringify({ truncated: true, preview: serialized.slice(0, previewLength) });
  }
  return bounded;
}

function serializeJsonInput(value: unknown, length: number): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return "null";
  if (serialized.length > length) throw new Error(`Tool-agent task input exceeds ${length} characters`);
  return serialized;
}

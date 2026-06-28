import crypto from "node:crypto";
import type { Logger } from "pino";
import { isToolProfile, type ToolProfile } from "./tool-profiles.js";
import { ToolAgentTaskStore, type ToolAgentTask } from "../storage/tool-agent-tasks.js";

export type ToolAgentTaskRequest = {
  title: string;
  toolProfile: ToolProfile;
  prompt: string;
  input?: unknown;
  parentTaskId?: string;
  conversationKey?: string;
  guildId?: string;
  channelId: string;
  userId: string;
  sourceMessageId?: string;
  roles: string[];
};

export type ToolAgentRunner = (task: ToolAgentTask, roles: string[]) => Promise<string>;

const MAX_QUEUED_GLOBAL = 100;
const MAX_ACTIVE_PER_USER = 12;
const MAX_CONCURRENT = 3;
const MAX_RUNTIME_MS = 10 * 60 * 1000;

export class ToolAgentQueueService {
  private readonly queuedIds: string[] = [];
  private readonly waiters = new Map<string, Array<(task: ToolAgentTask) => void>>();
  private readonly rolesByTask = new Map<string, string[]>();
  private running = 0;

  constructor(
    private readonly store: ToolAgentTaskStore,
    private readonly runner: ToolAgentRunner,
    private readonly logger?: Logger,
  ) {}

  recover(): void {
    const failed = this.store.failInterruptedRunningTasks();
    if (failed > 0) this.logger?.warn({ failed }, "Marked interrupted tool-agent tasks as failed");

    for (const task of this.store.list({ limit: MAX_QUEUED_GLOBAL }).reverse()) {
      if (task.status === "queued") this.queuedIds.push(task.id);
    }
    this.drain();
  }

  enqueue(params: ToolAgentTaskRequest): ToolAgentTask {
    if (!isToolProfile(params.toolProfile)) throw new Error(`Unknown tool profile: ${params.toolProfile}`);
    if (this.store.countByStatus(["queued", "running"]) >= MAX_QUEUED_GLOBAL) throw new Error("Too many tool-agent tasks are already queued or running");
    if (this.store.countByStatus(["queued", "running"], params.userId) >= MAX_ACTIVE_PER_USER) throw new Error("This user already has too many active tool-agent tasks");

    const task = this.store.create({ ...params, id: crypto.randomUUID() });
    this.rolesByTask.set(task.id, params.roles);
    this.queuedIds.push(task.id);
    this.drain();
    return task;
  }

  get(id: string): ToolAgentTask | undefined {
    return this.store.get(id);
  }

  list(params: { conversationKey?: string; parentTaskId?: string; limit?: number } = {}): ToolAgentTask[] {
    return this.store.list(params);
  }

  cancel(id: string): ToolAgentTask | undefined {
    const task = this.store.cancel(id);
    const index = this.queuedIds.indexOf(id);
    if (index >= 0) this.queuedIds.splice(index, 1);
    if (task) this.resolveWaiters(task);
    return task;
  }

  async waitForTask(id: string, timeoutMs = MAX_RUNTIME_MS + 30000): Promise<ToolAgentTask> {
    const existing = this.store.get(id);
    if (!existing) throw new Error(`Tool-agent task ${id} was not found`);
    if (isTerminal(existing)) return existing;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for tool-agent task ${id}`));
      }, timeoutMs);
      const waiter = (task: ToolAgentTask) => {
        clearTimeout(timer);
        resolve(task);
      };
      const waiters = this.waiters.get(id) ?? [];
      waiters.push(waiter);
      this.waiters.set(id, waiters);
    });
  }

  private drain(): void {
    while (this.running < MAX_CONCURRENT && this.queuedIds.length > 0) {
      const id = this.queuedIds.shift();
      if (!id) return;
      const task = this.store.get(id);
      if (!task || task.status !== "queued") continue;

      this.running += 1;
      void this.runTask(id).finally(() => {
        this.running -= 1;
        this.drain();
      });
    }
  }

  private async runTask(id: string): Promise<void> {
    const task = this.store.markRunning(id);
    if (!task) return;

    try {
      const resultText = await withTimeout(this.runner(task, this.rolesByTask.get(id) ?? []), MAX_RUNTIME_MS, `Tool-agent task ${id} exceeded max runtime`);
      const latest = this.store.get(id);
      if (latest?.status === "cancelled") {
        this.resolveWaiters(latest);
        return;
      }

      this.resolveWaiters(this.store.markSucceeded(id, resultText, { text: resultText }) ?? task);
    } catch (error) {
      const latest = this.store.get(id);
      if (latest?.status === "cancelled") {
        this.resolveWaiters(latest);
        return;
      }
      this.resolveWaiters(this.store.markFailed(id, error instanceof Error ? error.message : String(error)) ?? task);
    } finally {
      this.rolesByTask.delete(id);
    }
  }

  private resolveWaiters(task: ToolAgentTask): void {
    const waiters = this.waiters.get(task.id);
    if (!waiters) return;
    this.waiters.delete(task.id);
    for (const waiter of waiters) waiter(task);
  }
}

function isTerminal(task: ToolAgentTask): boolean {
  return ["succeeded", "failed", "cancelled"].includes(task.status);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

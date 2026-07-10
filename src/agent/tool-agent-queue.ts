import crypto from "node:crypto";
import type { Logger } from "pino";
import { isToolProfile, type ToolProfile } from "./tool-profiles.js";
import { ToolAgentTaskStore, type ToolAgentTask, type ToolAgentTaskScope } from "../storage/tool-agent-tasks.js";

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

export type ToolAgentRunner = (task: ToolAgentTask, roles: string[], signal: AbortSignal) => Promise<string>;

const MAX_QUEUED_GLOBAL = 100;
const MAX_ACTIVE_PER_USER = 12;
const MAX_CONCURRENT = 3;
const MAX_RUNTIME_MS = 10 * 60 * 1000;
const MAX_QUEUE_WAIT_MS = Math.ceil(MAX_QUEUED_GLOBAL / MAX_CONCURRENT) * MAX_RUNTIME_MS + 60_000;

export class ToolAgentQueueService {
  private readonly queuedIds: string[] = [];
  private readonly waiters = new Map<string, Array<(task: ToolAgentTask) => void>>();
  private readonly rolesByTask = new Map<string, string[]>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly idleWaiters: Array<() => void> = [];
  private running = 0;
  private stopping = false;

  constructor(
    private readonly store: ToolAgentTaskStore,
    private readonly runner: ToolAgentRunner,
    private readonly logger?: Logger,
    private readonly options: { maxConcurrent?: number; maxRuntimeMs?: number } = {},
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
    return this.enqueueMany([params])[0]!;
  }

  enqueueMany(params: ToolAgentTaskRequest[]): ToolAgentTask[] {
    if (this.stopping) throw new Error("Tool-agent queue is shutting down");
    if (params.length === 0) return [];
    if (params.some((task) => !isToolProfile(task.toolProfile))) throw new Error("A task has an unknown tool profile");
    const tasks = this.store.createMany(params.map((task) => ({ ...task, id: crypto.randomUUID() })), MAX_QUEUED_GLOBAL, MAX_ACTIVE_PER_USER);
    for (const [index, task] of tasks.entries()) {
      this.rolesByTask.set(task.id, params[index]?.roles ?? []);
      this.queuedIds.push(task.id);
    }
    this.drain();
    return tasks;
  }

  get(id: string, scope?: ToolAgentTaskScope): ToolAgentTask | undefined {
    return scope ? this.store.getScoped(id, scope) : this.store.get(id);
  }

  list(params: { conversationKey?: string; userId?: string; parentTaskId?: string; limit?: number } = {}): ToolAgentTask[] {
    if (params.parentTaskId && params.userId && !this.store.getScoped(params.parentTaskId, { conversationKey: params.conversationKey, userId: params.userId })) {
      throw new Error(`Parent tool-agent task ${params.parentTaskId} was not found in this conversation`);
    }
    return this.store.list(params);
  }

  async cancel(id: string, scope?: ToolAgentTaskScope): Promise<ToolAgentTask | undefined> {
    const current = this.get(id, scope);
    if (!current || isTerminal(current)) return current;
    const index = this.queuedIds.indexOf(id);
    if (index >= 0) {
      this.queuedIds.splice(index, 1);
      const cancelled = this.store.markCancelled(id);
      if (cancelled) this.resolveWaiters(cancelled);
      return cancelled;
    }
    this.controllers.get(id)?.abort(new Error(`Tool-agent task ${id} was cancelled`));
    return this.waitForTask(id);
  }

  async waitForTask(id: string, timeoutMs = MAX_QUEUE_WAIT_MS): Promise<ToolAgentTask> {
    const existing = this.store.get(id);
    if (!existing) throw new Error(`Tool-agent task ${id} was not found`);
    if (isTerminal(existing)) return existing;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const currentWaiters = this.waiters.get(id);
        if (currentWaiters) {
          const index = currentWaiters.indexOf(waiter);
          if (index >= 0) currentWaiters.splice(index, 1);
          if (currentWaiters.length === 0) this.waiters.delete(id);
        }
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

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const id of this.queuedIds.splice(0)) {
      const cancelled = this.store.markCancelled(id, "Process shut down before this task started");
      if (cancelled) this.resolveWaiters(cancelled);
    }
    for (const [id, controller] of this.controllers) controller.abort(new Error(`Tool-agent task ${id} was stopped during shutdown`));
    if (this.running === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private drain(): void {
    if (this.stopping) return;
    while (this.running < (this.options.maxConcurrent ?? MAX_CONCURRENT) && this.queuedIds.length > 0) {
      const id = this.queuedIds.shift();
      if (!id) return;
      const task = this.store.get(id);
      if (!task || task.status !== "queued") continue;

      this.running += 1;
      void this.runTask(id).finally(() => {
        this.running -= 1;
        if (this.running === 0) {
          for (const resolve of this.idleWaiters.splice(0)) resolve();
        }
        this.drain();
      });
    }
  }

  private async runTask(id: string): Promise<void> {
    const task = this.store.markRunning(id);
    if (!task) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Tool-agent task ${id} exceeded max runtime`));
    }, this.options.maxRuntimeMs ?? MAX_RUNTIME_MS);

    try {
      const resultText = await this.runner(task, this.rolesByTask.get(id) ?? [], controller.signal);
      const settled = timedOut
        ? this.store.markFailed(id, `Tool-agent task ${id} exceeded max runtime`)
        : controller.signal.aborted
          ? this.store.markCancelled(id)
          : this.store.markSucceeded(id, resultText, { text: resultText });
      if (settled) this.resolveWaiters(settled);
    } catch (error) {
      const settled = timedOut
        ? this.store.markFailed(id, `Tool-agent task ${id} exceeded max runtime`)
        : controller.signal.aborted
          ? this.store.markCancelled(id)
          : this.store.markFailed(id, error instanceof Error ? error.message : String(error));
      if (settled) this.resolveWaiters(settled);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(id);
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

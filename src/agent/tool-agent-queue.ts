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
  approvedAction?: string;
};

export type ToolAgentRunner = (task: ToolAgentTask, roles: string[], signal: AbortSignal, approvedAction?: string) => Promise<string>;

const MAX_QUEUED_GLOBAL = 100;
const MAX_ACTIVE_PER_USER = 12;
const MAX_CONCURRENT = 3;
const MAX_RUNTIME_MS = 10 * 60 * 1000;
const MAX_QUEUE_WAIT_MS = Math.ceil(MAX_QUEUED_GLOBAL / MAX_CONCURRENT) * MAX_RUNTIME_MS + 60_000;

export class ToolAgentQueueService {
  private readonly queuedIds: string[] = [];
  private readonly waiters = new Map<string, Array<(task: ToolAgentTask) => void>>();
  private readonly rolesByTask = new Map<string, string[]>();
  private readonly approvedActionByTask = new Map<string, string>();
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
    const cancelled = this.store.cancelQueuedTasks();
    if (cancelled > 0) this.logger?.warn({ cancelled }, "Cancelled orphaned queued tool-agent tasks after restart");
  }

  enqueue(params: ToolAgentTaskRequest): ToolAgentTask {
    return this.enqueueMany([params])[0]!;
  }

  enqueueMany(params: ToolAgentTaskRequest[]): ToolAgentTask[] {
    if (this.stopping) throw new Error("Tool-agent queue is shutting down");
    if (params.length === 0) return [];
    if (params.some((task) => !isToolProfile(task.toolProfile))) throw new Error("A task has an unknown tool profile");
    const tasks: Array<ToolAgentTask | undefined> = new Array(params.length);
    const pending: Array<{ index: number; request: ToolAgentTaskRequest }> = [];
    const pendingAliases = new Map<number, number>();
    const pendingByFingerprint = new Map<string, number>();
    for (const [index, request] of params.entries()) {
      const reusable = this.findReusable(request);
      if (reusable) tasks[index] = reusable;
      else {
        const fingerprint = taskFingerprint(request);
        const existingIndex = pendingByFingerprint.get(fingerprint);
        if (existingIndex !== undefined) pendingAliases.set(index, existingIndex);
        else {
          pendingByFingerprint.set(fingerprint, index);
          pending.push({ index, request });
        }
      }
    }
    const created = this.store.createMany(pending.map(({ request }) => ({ ...request, id: crypto.randomUUID() })), MAX_QUEUED_GLOBAL, MAX_ACTIVE_PER_USER);
    for (const [createdIndex, task] of created.entries()) {
      const pendingTask = pending[createdIndex]!;
      tasks[pendingTask.index] = task;
      this.rolesByTask.set(task.id, pendingTask.request.roles);
      if (pendingTask.request.approvedAction) this.approvedActionByTask.set(task.id, pendingTask.request.approvedAction);
      this.queuedIds.push(task.id);
    }
    for (const [alias, source] of pendingAliases) tasks[alias] = tasks[source];
    this.drain();
    return tasks as ToolAgentTask[];
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

  clearHistory(): number {
    return this.store.clearHistory();
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
      const resultText = await this.runner(task, this.rolesByTask.get(id) ?? [], controller.signal, this.approvedActionByTask.get(id));
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
      this.approvedActionByTask.delete(id);
    }
  }

  private resolveWaiters(task: ToolAgentTask): void {
    const waiters = this.waiters.get(task.id);
    if (!waiters) return;
    this.waiters.delete(task.id);
    for (const waiter of waiters) waiter(task);
  }

  async cancelConversation(conversationKey: string): Promise<void> {
    const active = this.store.list({ conversationKey, limit: 200 }).filter((task) => !isTerminal(task));
    await Promise.all(active.map((task) => this.cancel(task.id, { conversationKey, userId: task.userId })));
  }

  private findReusable(request: ToolAgentTaskRequest): ToolAgentTask | undefined {
    return this.store.list({ conversationKey: request.conversationKey, userId: request.userId, limit: 200 }).find((task) => {
      if (task.toolProfile !== request.toolProfile || normalize(task.prompt) !== normalize(request.prompt)) return false;
      if (stableJson(task.input) !== stableJson(request.input)) return false;
      if (this.approvedActionByTask.get(task.id) !== request.approvedAction) return false;
      return ["queued", "running"].includes(task.status);
    });
  }
}

function isTerminal(task: ToolAgentTask): boolean {
  return ["succeeded", "failed", "cancelled"].includes(task.status);
}

function normalize(value: string): string { return value.replace(/\s+/g, " ").trim().toLowerCase(); }
function stableJson(value: unknown): string { return value === undefined ? "" : JSON.stringify(value); }
function taskFingerprint(task: ToolAgentTaskRequest): string { return `${task.toolProfile}\n${normalize(task.prompt)}\n${stableJson(task.input)}\n${task.approvedAction ?? ""}`; }

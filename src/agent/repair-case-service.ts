import crypto from "node:crypto";
import type { Logger } from "pino";
import {
  RepairCaseStore,
  type InboundArrEvent,
  type RepairCase,
  type RepairCaseMessage,
  type RepairCaseOutboxItem,
  type RepairCaseStatus,
  type RepairCaseWake,
  type ReceiveEventResult,
} from "../storage/repair-cases.js";

export type RepairCaseRunContext = {
  messages: RepairCaseMessage[];
  signal: AbortSignal;
  progress: (progress: unknown) => Promise<void>;
};

export type RepairCaseRunResult = {
  status?: Exclude<RepairCaseStatus, "working">;
  checkpoint?: unknown;
  wake?: RepairCaseWake;
  activity?: { kind: string; details?: unknown };
  deliveries?: Array<{ kind: string; payload: unknown; dedupeKey?: string }>;
};

export type RepairCaseRunner = (repairCase: RepairCase, context: RepairCaseRunContext) => Promise<RepairCaseRunResult | void>;
export type RepairCaseProgressCallback = (repairCase: RepairCase, progress: unknown) => Promise<void> | void;
export type RepairCaseDeliveryCallback = (delivery: RepairCaseOutboxItem, repairCase: RepairCase) => Promise<void> | void;

export type RepairCaseServiceOptions = {
  runner: RepairCaseRunner;
  onProgress?: RepairCaseProgressCallback;
  onDelivery?: RepairCaseDeliveryCallback;
  maxConcurrent?: number;
  leaseMs?: number;
  maxRuntimeMs?: number;
  ownerId?: string;
  logger?: Logger;
};

const DEFAULT_LEASE_MS = 10 * 60_000;
const DEFAULT_RUNTIME_MS = 9 * 60_000;

/** Single-process scheduler. Durable ownership and all queue state remain in SQLite. */
export class RepairCaseService {
  private readonly ownerId: string;
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly pendingMessages = new Set<string>();
  private readonly idleWaiters: Array<() => void> = [];
  private running = 0;
  private started = false;
  private stopping = false;
  private wakeTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly store: RepairCaseStore, private readonly options: RepairCaseServiceOptions) {
    this.ownerId = options.ownerId ?? crypto.randomUUID();
    if ((options.maxConcurrent ?? 3) < 1) throw new Error("maxConcurrent must be at least one");
  }

  recover(): number {
    this.store.expireCases();
    const recovered = this.store.recoverAllLeases();
    this.store.recoverClaimedDeliveries();
    const runnable = this.store.listRunnable();
    for (const repairCase of runnable) {
      if (!repairCase.leaseOwner) this.enqueue(repairCase.id);
    }
    if (this.started) {
      this.drain();
      this.scheduleWake();
      void this.flushDeliveries();
    }
    return recovered;
  }

  start(): void {
    if (this.started) return;
    if (this.stopping) throw new Error("Repair case service has shut down");
    this.started = true;
    this.recover();
  }

  get(id: string): RepairCase | undefined { return this.store.get(id); }
  list(filters: Parameters<RepairCaseStore["list"]>[0] = {}): RepairCase[] { return this.store.list(filters); }

  refreshScheduling(): void {
    this.scheduleWake();
    void this.flushDeliveries();
  }

  notifyNewMessage(caseId: string, message: Omit<Parameters<RepairCaseStore["addMessage"]>[1], "role"> & { role?: RepairCaseMessage["role"] }): RepairCase {
    this.assertAccepting();
    const current = this.store.get(caseId);
    if (!current) throw new Error(`Repair case ${caseId} was not found`);
    this.store.addMessage(caseId, { ...message, role: message.role ?? "user" });
    const repairCase = ["waiting", "needs_input", "blocked"].includes(current.status)
      ? this.store.resume(caseId, message.sourceMessageId ? `message:${message.sourceMessageId}` : "message") ?? this.store.get(caseId)!
      : this.store.get(caseId)!;
    if (repairCase.leaseOwner) this.pendingMessages.add(caseId);
    if (["ready", "working", "verifying"].includes(repairCase.status) && !repairCase.leaseOwner) this.enqueue(caseId);
    this.drain();
    this.scheduleWake();
    return repairCase;
  }

  receiveEvent(event: InboundArrEvent): ReceiveEventResult {
    this.assertAccepting();
    const result = this.store.receiveEvent(event);
    for (const id of result.matchedCaseIds) this.enqueue(id);
    this.drain();
    this.scheduleWake();
    return result;
  }

  cancel(id: string, actor?: string): RepairCase | undefined {
    this.removeQueued(id);
    this.pendingMessages.delete(id);
    this.controllers.get(id)?.abort(new Error(`Repair case ${id} was cancelled`));
    const result = this.store.cancel(id, actor);
    this.scheduleWake();
    return result ?? this.store.get(id);
  }

  resume(id: string, actor?: string): RepairCase | undefined {
    this.assertAccepting();
    const repairCase = this.store.resume(id, actor);
    if (repairCase) { this.enqueue(id); this.drain(); this.scheduleWake(); }
    return repairCase;
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return this.waitForIdle();
    this.stopping = true;
    this.started = false;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.queue.length = 0;
    this.queued.clear();
    for (const controller of this.controllers.values()) controller.abort(new Error("Repair case service is shutting down"));
    await this.waitForIdle();
  }

  private enqueue(id: string): void {
    if (this.stopping || this.queued.has(id) || this.controllers.has(id)) return;
    this.queued.add(id);
    this.queue.push(id);
  }

  private drain(): void {
    if (!this.started || this.stopping) return;
    const maximum = this.options.maxConcurrent ?? 3;
    while (this.running < maximum && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.queued.delete(id);
      this.running += 1;
      void this.run(id).finally(() => {
        this.running -= 1;
        if (this.running === 0) for (const resolve of this.idleWaiters.splice(0)) resolve();
        this.drain();
      });
    }
  }

  private async run(id: string): Promise<void> {
    const leaseMs = this.options.leaseMs ?? DEFAULT_LEASE_MS;
    const repairCase = this.store.claimRunnable(id, this.ownerId, leaseMs);
    if (!repairCase) {
      const current = this.store.get(id);
      if (current?.status === "exhausted") {
        this.store.enqueueDelivery(id, "discord_message", { content: "I couldn’t finish this automatically after several attempts. The repair history is saved, but I need someone to review what to try next." }, { dedupeKey: `${id}:exhausted` });
        await this.flushDeliveries();
      }
      return;
    }
    const controller = new AbortController();
    this.controllers.set(id, controller);
    let timedOut = false;
    let runAgain = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Repair case ${id} exceeded max runtime`));
    }, Math.min(this.options.maxRuntimeMs ?? DEFAULT_RUNTIME_MS, leaseMs));
    timeout.unref?.();

    try {
      const result = await this.options.runner(repairCase, {
        messages: this.store.listMessages(id),
        signal: controller.signal,
        progress: async (progress) => {
          const current = this.store.get(id);
          if (current && current.leaseOwner === this.ownerId) {
            this.store.addActivity(id, "progress", progress, this.ownerId);
            this.store.enqueueDelivery(id, "discord_message", progress);
            await this.options.onProgress?.(current, progress);
            await this.flushDeliveries();
          }
        },
      });
      const current = this.store.get(id);
      if (!current || current.leaseOwner !== this.ownerId || controller.signal.aborted) return;
      if (this.pendingMessages.delete(id)) {
        this.store.addActivity(id, "rerun_requested", { reason: "new_thread_message" }, this.ownerId);
        this.store.releaseLease(id, this.ownerId, "ready");
        runAgain = true;
        return;
      }
      if (result?.activity) this.store.addActivity(id, result.activity.kind, result.activity.details, this.ownerId);
      for (const delivery of result?.deliveries ?? []) this.store.enqueueDelivery(id, delivery.kind, delivery.payload, { dedupeKey: delivery.dedupeKey });
      if (result?.wake) {
        if (result.checkpoint !== undefined) this.store.transition(id, "verifying", { from: ["working", "verifying"], checkpoint: result.checkpoint, actor: this.ownerId });
        this.store.setWake(id, result.wake);
      } else {
        const status = result?.status ?? "needs_input";
        const transitioned = this.store.transition(id, status, { from: ["working", "verifying"], checkpoint: result?.checkpoint, actor: this.ownerId });
        runAgain = transitioned?.status === "ready" || transitioned?.status === "verifying";
      }
      await this.flushDeliveries();
    } catch (error) {
      const current = this.store.get(id);
      if (current?.leaseOwner !== this.ownerId) return;
      if (this.stopping) this.store.releaseLease(id, this.ownerId, "ready");
      else if (timedOut) {
        this.store.transition(id, "blocked", { from: ["working", "verifying"], actor: this.ownerId, details: { error: "runner_timeout" } });
        this.store.enqueueDelivery(id, "discord_message", { content: "I ran into a timeout while working on this. I saved the progress so it can be resumed instead of starting over." }, { dedupeKey: `${id}:attempt:${current.attempts}:timeout` });
      } else if (!controller.signal.aborted) {
        this.store.transition(id, "blocked", { from: ["working", "verifying"], actor: this.ownerId, details: { error: error instanceof Error ? error.message : String(error) } });
        this.store.enqueueDelivery(id, "discord_message", { content: "I hit a problem and can’t safely continue automatically right now. The work so far is saved for review or another attempt." }, { dedupeKey: `${id}:attempt:${current.attempts}:error` });
      }
    } finally {
      clearTimeout(timeout);
      const current = this.store.get(id);
      if (current?.leaseOwner === this.ownerId) this.store.releaseLease(id, this.ownerId, this.stopping ? "ready" : "blocked");
      this.controllers.delete(id);
      if (runAgain && !this.stopping) this.enqueue(id);
      void this.flushDeliveries();
      this.scheduleWake();
    }
  }

  private async flushDeliveries(): Promise<void> {
    if (!this.options.onDelivery || this.stopping) return;
    for (const delivery of this.store.claimDeliveries()) {
      try {
        const repairCase = this.store.get(delivery.caseId);
        if (!repairCase) throw new Error(`Repair case ${delivery.caseId} was not found`);
        await this.options.onDelivery(delivery, repairCase);
        this.store.settleDelivery(delivery.id, true);
      } catch (error) {
        this.store.settleDelivery(delivery.id, false, error instanceof Error ? error.message : String(error));
        this.options.logger?.error({ error, deliveryId: delivery.id }, "Repair case delivery failed");
      }
    }
  }

  private scheduleWake(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    if (!this.started || this.stopping) return;
    const dueAt = [this.store.nextTimerDueAt(), this.store.nextDeliveryDueAt()].filter((value): value is string => Boolean(value)).sort()[0];
    if (!dueAt) return;
    const delay = Math.max(0, Math.min(Date.parse(dueAt) - Date.now(), 2_147_483_647));
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      for (const repairCase of this.store.claimDueTimers()) this.enqueue(repairCase.id);
      this.drain();
      void this.flushDeliveries();
      this.scheduleWake();
    }, delay);
    this.wakeTimer.unref?.();
  }

  private removeQueued(id: string): void {
    this.queued.delete(id);
    let index = this.queue.indexOf(id);
    while (index >= 0) { this.queue.splice(index, 1); index = this.queue.indexOf(id); }
  }

  private waitForIdle(): Promise<void> {
    if (this.running === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private assertAccepting(): void {
    if (this.stopping) throw new Error("Repair case service is shutting down");
  }
}

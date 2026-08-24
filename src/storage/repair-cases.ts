import crypto from "node:crypto";
import type { AppDatabase } from "./db.js";

export const REPAIR_CASE_STATUSES = [
  "working", "waiting", "ready", "verifying", "resolved", "needs_input", "blocked", "exhausted", "cancelled",
] as const;
export type RepairCaseStatus = (typeof REPAIR_CASE_STATUSES)[number];
export type RepairCaseMessageRole = "user" | "assistant" | "system" | "tool";

export type RepairCase = {
  id: string;
  status: RepairCaseStatus;
  guildId: string;
  threadId: string;
  source: string;
  userId: string;
  authorizationActor: string;
  title: string;
  objective: string;
  checkpoint?: unknown;
  attempts: number;
  maxAttempts: number;
  expiresAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  cancelledAt?: string;
};

export type CreateRepairCase = {
  id?: string;
  status?: RepairCaseStatus;
  guildId: string;
  threadId: string;
  source: string;
  userId: string;
  authorizationActor: string;
  title: string;
  objective: string;
  checkpoint?: unknown;
  maxAttempts?: number;
  expiresAt?: Date | string;
};

export type RepairCaseMessage = {
  id: number;
  caseId: string;
  role: RepairCaseMessageRole;
  content: string;
  sourceMessageId?: string;
  metadata?: unknown;
  createdAt: string;
};

export type RepairCaseActivity = {
  id: number;
  caseId: string;
  kind: string;
  actor?: string;
  details?: unknown;
  createdAt: string;
};

export type RepairCaseWake =
  | { id?: number; caseId?: string; type: "timer"; dueAt: Date | string; createdAt?: string }
  | { id?: number; caseId?: string; type: "arr_event"; provider: string; eventType?: string; mediaId?: string; mediaIds?: string[]; completionPolicy?: "any" | "all"; fallbackAt?: Date | string; createdAt?: string };

export type InboundArrEvent = {
  provider: string;
  eventId: string;
  eventType: string;
  mediaId?: string;
  mediaIds?: string[];
  payload?: unknown;
  receivedAt?: Date | string;
};

export type ReceiveEventResult = { duplicate: boolean; matchedCaseIds: string[] };

export type RepairCaseOutboxItem = {
  id: number;
  caseId: string;
  kind: string;
  payload: unknown;
  dedupeKey?: string;
  status: "pending" | "claimed" | "delivered" | "failed";
  attempts: number;
  availableAt: string;
  claimedAt?: string;
  deliveredAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

type CaseRow = {
  id: string; status: RepairCaseStatus; guild_id: string; thread_id: string; source: string; user_id: string;
  authorization_actor: string; title: string; objective: string; checkpoint_json: string | null; attempts: number;
  max_attempts: number; expires_at: string; lease_owner: string | null; lease_expires_at: string | null;
  created_at: string; updated_at: string; resolved_at: string | null; cancelled_at: string | null;
};

type WakeRow = {
  id: number; case_id: string; type: "timer" | "arr_event"; due_at: string | null; provider: string | null;
  event_type: string | null; media_id: string | null; media_ids_json: string | null; completion_policy: "any" | "all" | null; created_at: string;
};

const TERMINAL: RepairCaseStatus[] = ["resolved", "exhausted", "cancelled"];
const RUNNABLE: RepairCaseStatus[] = ["ready", "working", "verifying"];
const ARR_EVENT_WATCHDOG_MS = 2 * 60 * 60_000;
const CASE_LIFETIME_MS = 7 * 86_400_000;

export class RepairCaseStore {
  constructor(private readonly db: AppDatabase, private readonly now: () => Date = () => new Date()) {}

  create(params: CreateRepairCase): RepairCase {
    const id = params.id ?? crypto.randomUUID();
    const now = this.timestamp();
    const maxAttempts = params.maxAttempts ?? 20;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive integer");
    const expiresAt = params.expiresAt ? timestamp(params.expiresAt) : new Date(Date.parse(now) + CASE_LIFETIME_MS).toISOString();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO repair_cases (
        id, status, guild_id, thread_id, source, user_id, authorization_actor, title, objective,
        checkpoint_json, max_attempts, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, params.status ?? "ready", params.guildId, params.threadId, params.source, params.userId,
        params.authorizationActor, params.title, params.objective, json(params.checkpoint), maxAttempts, expiresAt, now, now,
      );
      this.insertActivity(id, "created", params.authorizationActor, { status: params.status ?? "ready" }, now);
    })();
    return this.get(id)!;
  }

  createOrGetByThread(params: CreateRepairCase): { repairCase: RepairCase; created: boolean } {
    const existing = this.list({ guildId: params.guildId, threadId: params.threadId, limit: 1 })[0];
    if (existing) return { repairCase: existing, created: false };
    try {
      return { repairCase: this.create(params), created: true };
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("duplicate repair thread")) throw error;
      const concurrent = this.list({ guildId: params.guildId, threadId: params.threadId, limit: 1 })[0];
      if (!concurrent) throw error;
      return { repairCase: concurrent, created: false };
    }
  }

  get(id: string): RepairCase | undefined {
    const row = this.db.prepare("SELECT * FROM repair_cases WHERE id = ?").get(id) as CaseRow | undefined;
    return row ? caseFromRow(row) : undefined;
  }

  list(filters: { statuses?: RepairCaseStatus[]; guildId?: string; threadId?: string; userId?: string; limit?: number } = {}): RepairCase[] {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filters.statuses) {
      if (filters.statuses.length === 0) return [];
      where.push(`status IN (${filters.statuses.map(() => "?").join(", ")})`);
      values.push(...filters.statuses);
    }
    for (const [column, value] of [["guild_id", filters.guildId], ["thread_id", filters.threadId], ["user_id", filters.userId]] as const) {
      if (value !== undefined) { where.push(`${column} = ?`); values.push(value); }
    }
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(filters.limit ?? 100, 1000));
    return (this.db.prepare(`SELECT * FROM repair_cases${clause} ORDER BY updated_at DESC, id LIMIT ?`).all(...values, limit) as CaseRow[]).map(caseFromRow);
  }

  listRunnable(limit = 1000): RepairCase[] {
    return (this.db.prepare(`SELECT * FROM repair_cases
      WHERE status IN ('ready','working','verifying') AND lease_owner IS NULL
      ORDER BY created_at, rowid LIMIT ?`).all(Math.max(1, Math.min(limit, 1000))) as CaseRow[]).map(caseFromRow);
  }

  listAll(): RepairCase[] {
    return (this.db.prepare("SELECT * FROM repair_cases ORDER BY updated_at DESC, id").all() as CaseRow[]).map(caseFromRow);
  }

  delete(ids: string[]): number {
    if (ids.length === 0) return 0;
    return this.db.prepare(`DELETE FROM repair_cases WHERE id IN (${ids.map(() => "?").join(", ")})`).run(...ids).changes;
  }

  deleteAll(): number {
    return this.db.prepare("DELETE FROM repair_cases").run().changes;
  }

  addMessage(caseId: string, message: { role: RepairCaseMessageRole; content: string; sourceMessageId?: string; metadata?: unknown; createdAt?: Date | string }): RepairCaseMessage {
    const createdAt = message.createdAt ? timestamp(message.createdAt) : this.timestamp();
    const result = this.db.prepare(`INSERT INTO repair_case_messages
      (case_id, role, content, source_message_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(case_id, source_message_id) WHERE source_message_id IS NOT NULL DO NOTHING`).run(
      caseId, message.role, message.content, message.sourceMessageId ?? null, json(message.metadata), createdAt,
    );
    const row = result.changes === 1
      ? this.db.prepare("SELECT * FROM repair_case_messages WHERE id = ?").get(result.lastInsertRowid)
      : this.db.prepare("SELECT * FROM repair_case_messages WHERE case_id = ? AND source_message_id = ?").get(caseId, message.sourceMessageId);
    return messageFromRow(row as MessageRow);
  }

  listMessages(caseId: string): RepairCaseMessage[] {
    return (this.db.prepare("SELECT * FROM repair_case_messages WHERE case_id = ? ORDER BY id").all(caseId) as MessageRow[]).map(messageFromRow);
  }

  addActivity(caseId: string, kind: string, details?: unknown, actor?: string): RepairCaseActivity {
    const now = this.timestamp();
    const id = Number(this.insertActivity(caseId, kind, actor, details, now).lastInsertRowid);
    return this.listActivity(caseId).find((entry) => entry.id === id)!;
  }

  listActivity(caseId: string): RepairCaseActivity[] {
    return (this.db.prepare("SELECT * FROM repair_case_activity WHERE case_id = ? ORDER BY id").all(caseId) as ActivityRow[]).map((row) => ({
      id: row.id, caseId: row.case_id, kind: row.kind, actor: row.actor ?? undefined,
      details: parseJson(row.details_json), createdAt: row.created_at,
    }));
  }

  latestActivity(caseId: string): RepairCaseActivity | undefined {
    return this.listActivity(caseId).at(-1);
  }

  setAuthorizationActor(id: string, userId: string): RepairCase | undefined {
    const now = this.timestamp();
    const result = this.db.prepare("UPDATE repair_cases SET authorization_actor = ?, updated_at = ? WHERE id = ?")
      .run(userId, now, id);
    return result.changes === 1 ? this.get(id) : undefined;
  }

  setTitle(id: string, title: string): RepairCase | undefined {
    const now = this.timestamp();
    const result = this.db.prepare("UPDATE repair_cases SET title = ?, updated_at = ? WHERE id = ?")
      .run(title.slice(0, 70), now, id);
    return result.changes === 1 ? this.get(id) : undefined;
  }

  reopen(id: string, actor?: string): RepairCase | undefined {
    return this.db.transaction(() => {
      const current = this.get(id);
      if (!current || !TERMINAL.includes(current.status)) return undefined;
      const now = this.timestamp();
      const result = this.db.prepare(`UPDATE repair_cases SET status = 'ready', lease_owner = NULL, lease_expires_at = NULL,
        resolved_at = NULL, cancelled_at = NULL, attempts = 0, expires_at = ?, updated_at = ? WHERE id = ? AND status = ?`)
        .run(new Date(Date.parse(now) + CASE_LIFETIME_MS).toISOString(), now, id, current.status);
      if (result.changes !== 1) return undefined;
      this.db.prepare("DELETE FROM repair_case_wakes WHERE case_id = ?").run(id);
      this.insertActivity(id, "status_changed", actor, { from: current.status, to: "ready", reason: "new_thread_message" }, now);
      return this.get(id);
    })();
  }

  transition(id: string, status: RepairCaseStatus, options: { from?: RepairCaseStatus[]; checkpoint?: unknown; actor?: string; details?: unknown } = {}): RepairCase | undefined {
    return this.db.transaction(() => {
      const current = this.get(id);
      if (!current || TERMINAL.includes(current.status) || (options.from && !options.from.includes(current.status))) return undefined;
      const now = this.timestamp();
      const checkpoint = options.checkpoint === undefined ? json(current.checkpoint) : json(options.checkpoint);
      const result = this.db.prepare(`UPDATE repair_cases SET status = ?, checkpoint_json = ?, updated_at = ?,
        lease_owner = CASE WHEN ? IN ('waiting','ready','resolved','needs_input','blocked','exhausted','cancelled') THEN NULL ELSE lease_owner END,
        lease_expires_at = CASE WHEN ? IN ('waiting','ready','resolved','needs_input','blocked','exhausted','cancelled') THEN NULL ELSE lease_expires_at END,
        resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END,
        cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END
        WHERE id = ? AND status = ?`).run(status, checkpoint, now, status, status, status, now, status, now, id, current.status);
      if (result.changes !== 1) return undefined;
      if (status !== "waiting") this.db.prepare("DELETE FROM repair_case_wakes WHERE case_id = ?").run(id);
      this.insertActivity(id, "status_changed", options.actor, { from: current.status, to: status, ...objectDetails(options.details) }, now);
      return this.get(id);
    })();
  }

  cancel(id: string, actor?: string): RepairCase | undefined {
    return this.db.transaction(() => {
      const result = this.transition(id, "cancelled", { actor });
      if (result) this.db.prepare("DELETE FROM repair_case_wakes WHERE case_id = ?").run(id);
      return result;
    })();
  }

  resume(id: string, actor?: string): RepairCase | undefined {
    return this.db.transaction(() => {
      const result = this.transition(id, "ready", { from: ["waiting", "needs_input", "blocked"], actor });
      if (result) this.db.prepare("DELETE FROM repair_case_wakes WHERE case_id = ?").run(id);
      return result;
    })();
  }

  setWake(caseId: string, wake: RepairCaseWake): RepairCaseWake {
    return this.db.transaction(() => {
      const repairCase = this.get(caseId);
      if (!repairCase || TERMINAL.includes(repairCase.status)) throw new Error(`Active repair case ${caseId} was not found`);
      const existing = this.getWake(caseId);
      // An event subscription is more precise and is never silently replaced by a fallback timer.
      if (existing?.type === "arr_event" && wake.type === "timer") return existing;
      const now = this.timestamp();
      this.db.prepare("DELETE FROM repair_case_wakes WHERE case_id = ?").run(caseId);
      if (wake.type === "timer") {
        this.db.prepare("INSERT INTO repair_case_wakes (case_id, type, due_at, created_at) VALUES (?, 'timer', ?, ?)")
          .run(caseId, timestamp(wake.dueAt), now);
      } else {
        const fallbackAt = timestamp(wake.fallbackAt ?? new Date(Date.parse(now) + ARR_EVENT_WATCHDOG_MS));
        const mediaIds = expectedWakeMediaIds(wake);
        const completionPolicy = wake.completionPolicy ?? "any";
        this.db.prepare(`INSERT INTO repair_case_wakes (case_id, type, due_at, provider, event_type, media_id, media_ids_json, completion_policy, created_at)
          VALUES (?, 'arr_event', ?, ?, ?, ?, ?, ?, ?)`).run(caseId, fallbackAt, wake.provider, wake.eventType ?? null, mediaIds[0] ?? null, json(mediaIds), completionPolicy, now);
      }
      this.transition(caseId, "waiting", { actor: "system", details: { wake: wake.type } });
      if (wake.type === "arr_event") {
        const wakeId = (this.db.prepare("SELECT id FROM repair_case_wakes WHERE case_id = ?").get(caseId) as { id: number }).id;
        const expected = expectedWakeMediaIds(wake);
        const recentEvents = this.db.prepare(`SELECT id, event_id, event_type, media_id, media_ids_json FROM repair_inbound_events event
          WHERE provider = ? AND received_at >= ?
            AND (? IS NULL OR event_type = ? OR (? = 'download' AND event_type = 'manualinteractionrequired'))
            AND NOT EXISTS (SELECT 1 FROM repair_case_event_consumptions consumed WHERE consumed.case_id = ? AND consumed.inbound_event_id = event.id)
          ORDER BY received_at DESC LIMIT 50`).all(
          wake.provider,
          new Date(Date.parse(now) - 5 * 60_000).toISOString(),
          wake.eventType ?? null,
          wake.eventType ?? null,
          wake.eventType ?? null,
          caseId,
        ) as Array<{ id: number; event_id: string; event_type: string; media_id: string | null; media_ids_json: string | null }>;
        let replayMatched = false;
        let immediateAttentionMatched = false;
        for (const event of recentEvents) {
          if (!eventTypesMatch(wake.eventType, event.event_type)) continue;
          const eventMediaIds = inboundMediaIds(event);
          if (!matchesExpectedMedia(expected, eventMediaIds)) continue;
          replayMatched = true;
          immediateAttentionMatched ||= requiresImmediateAttention(event.event_type);
          this.db.prepare("INSERT OR IGNORE INTO repair_case_event_consumptions (case_id, inbound_event_id, wake_id, consumed_at) VALUES (?, ?, ?, ?)")
            .run(caseId, event.id, wakeId, now);
        }
        const observed = this.consumedMediaIds(caseId, wakeId);
        if (replayMatched && (immediateAttentionMatched || wakeSatisfied(expected, observed, wake.completionPolicy ?? "any"))) {
          this.db.prepare("DELETE FROM repair_case_wakes WHERE case_id = ?").run(caseId);
          this.transition(caseId, "ready", { from: ["waiting"], actor: "event-replay", details: { reason: "recent_event", provider: wake.provider, eventType: wake.eventType, mediaIds: observed } });
        }
      }
      return this.getWake(caseId) ?? { ...wake, caseId, createdAt: now };
    })();
  }

  getWake(caseId: string): RepairCaseWake | undefined {
    const row = this.db.prepare("SELECT * FROM repair_case_wakes WHERE case_id = ?").get(caseId) as WakeRow | undefined;
    return row ? wakeFromRow(row) : undefined;
  }

  nextTimerDueAt(): string | undefined {
    return (this.db.prepare("SELECT MIN(due_at) AS due_at FROM repair_case_wakes WHERE due_at IS NOT NULL").get() as { due_at: string | null }).due_at ?? undefined;
  }

  nextDeliveryDueAt(): string | undefined {
    return (this.db.prepare(`SELECT MIN(current.available_at) AS due_at FROM repair_case_outbox current
      WHERE current.status = 'pending' AND NOT EXISTS (SELECT 1 FROM repair_case_outbox earlier
        WHERE earlier.case_id = current.case_id AND earlier.id < current.id AND earlier.status IN ('pending','claimed'))`).get() as { due_at: string | null }).due_at ?? undefined;
  }

  claimDueTimers(limit = 100, now: Date | string = this.now()): RepairCase[] {
    return this.db.transaction(() => {
      const at = timestamp(now);
      const rows = this.db.prepare(`SELECT w.* FROM repair_case_wakes w JOIN repair_cases c ON c.id = w.case_id
        WHERE w.due_at <= ? AND c.status = 'waiting' ORDER BY w.due_at, w.id LIMIT ?`)
        .all(at, Math.max(1, limit)) as WakeRow[];
      const cases: RepairCase[] = [];
      for (const row of rows) {
        this.db.prepare("DELETE FROM repair_case_wakes WHERE case_id = ?").run(row.case_id);
        const details = row.type === "arr_event"
          ? { reason: "webhook_fallback", provider: row.provider, eventType: row.event_type, mediaIds: wakeRowMediaIds(row) }
          : { reason: "timer" };
        const resumed = this.transition(row.case_id, "ready", { from: ["waiting"], actor: "timer", details });
        if (resumed) cases.push(resumed);
      }
      return cases;
    })();
  }

  backfillEventFallbacks(now: Date | string = this.now()): number {
    return this.db.transaction(() => {
      const at = timestamp(now);
      const rows = this.db.prepare(`SELECT w.id, w.case_id, w.created_at, c.expires_at FROM repair_case_wakes w
        JOIN repair_cases c ON c.id = w.case_id
        WHERE w.type = 'arr_event' AND w.due_at IS NULL AND c.status = 'waiting'`).all() as Array<{
          id: number; case_id: string; created_at: string; expires_at: string;
        }>;
      for (const row of rows) {
        const dueAt = new Date(Math.max(Date.parse(row.created_at) + ARR_EVENT_WATCHDOG_MS, Date.parse(at))).toISOString();
        this.db.prepare("UPDATE repair_case_wakes SET due_at = ? WHERE id = ? AND due_at IS NULL").run(dueAt, row.id);
        if (row.expires_at <= at) {
          this.db.prepare("UPDATE repair_cases SET expires_at = ?, updated_at = ? WHERE id = ? AND status = 'waiting'")
            .run(new Date(Date.parse(at) + CASE_LIFETIME_MS).toISOString(), at, row.case_id);
        }
      }
      return rows.length;
    })();
  }

  replaceProviderWakesWithTimers(provider: string, dueAt: Date | string): number {
    return this.db.transaction(() => {
      const now = this.timestamp();
      const due = timestamp(dueAt);
      const result = this.db.prepare(`UPDATE repair_case_wakes SET type = 'timer', due_at = ?, provider = NULL,
        event_type = NULL, media_id = NULL, created_at = ? WHERE type = 'arr_event' AND provider = ?`)
        .run(due, now, provider);
      if (result.changes > 0) {
        this.db.prepare(`INSERT INTO repair_case_activity (case_id, kind, actor, details_json, created_at)
          SELECT case_id, 'provider_disabled', 'system', ?, ? FROM repair_case_wakes WHERE type = 'timer' AND due_at = ?`)
          .run(json({ provider, reason: "integration_disabled", dueAt: due }), now, due);
      }
      return result.changes;
    })();
  }

  receiveEvent(event: InboundArrEvent): ReceiveEventResult {
    return this.db.transaction(() => {
      const receivedAt = event.receivedAt ? timestamp(event.receivedAt) : this.timestamp();
      this.db.prepare("DELETE FROM repair_inbound_events WHERE received_at < ?")
        .run(new Date(Date.parse(receivedAt) - 24 * 60 * 60_000).toISOString());
      const mediaIds = [...new Set([...(event.mediaIds ?? []), ...(event.mediaId ? [event.mediaId] : [])])];
      const inserted = this.db.prepare(`INSERT INTO repair_inbound_events
        (provider, event_id, event_type, media_id, media_ids_json, payload_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, event_id) DO NOTHING`).run(
        event.provider, event.eventId, event.eventType, mediaIds[0] ?? null, json(mediaIds), json(event.payload), receivedAt,
      );
      if (inserted.changes === 0) return { duplicate: true, matchedCaseIds: [] };
      const inboundEventId = Number(inserted.lastInsertRowid);
      const rows = this.db.prepare(`SELECT w.* FROM repair_case_wakes w JOIN repair_cases c ON c.id = w.case_id
        WHERE w.type = 'arr_event' AND c.status = 'waiting' AND w.provider = ?
          AND (w.event_type IS NULL OR w.event_type = ? OR (w.event_type = 'download' AND ? = 'manualinteractionrequired'))
        ORDER BY w.id`).all(event.provider, event.eventType, event.eventType) as WakeRow[];
      const matchedCaseIds: string[] = [];
      for (const row of rows) {
        if (!eventTypesMatch(row.event_type ?? undefined, event.eventType)) continue;
        const expected = wakeRowMediaIds(row);
        if (!matchesExpectedMedia(expected, mediaIds)) continue;
        this.db.prepare("INSERT OR IGNORE INTO repair_case_event_consumptions (case_id, inbound_event_id, wake_id, consumed_at) VALUES (?, ?, ?, ?)")
          .run(row.case_id, inboundEventId, row.id, receivedAt);
        const observed = this.consumedMediaIds(row.case_id, row.id);
        if (!requiresImmediateAttention(event.eventType) && !wakeSatisfied(expected, observed, row.completion_policy ?? "any")) continue;
        this.db.prepare("DELETE FROM repair_case_wakes WHERE case_id = ? AND type = 'arr_event'").run(row.case_id);
        const resumed = this.transition(row.case_id, "ready", { from: ["waiting"], actor: `${event.provider}:${event.eventId}`, details: { provider: event.provider, eventType: event.eventType, mediaIds: observed } });
        if (resumed) matchedCaseIds.push(row.case_id);
      }
      return { duplicate: false, matchedCaseIds };
    })();
  }

  recoverExpiredLeases(now: Date | string = this.now()): number {
    const at = timestamp(now);
    const result = this.db.prepare(`UPDATE repair_cases SET status = 'ready', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE lease_owner IS NOT NULL AND lease_expires_at <= ? AND status IN ('working','verifying')`).run(at, at);
    return result.changes;
  }

  recoverAllLeases(): number {
    const now = this.timestamp();
    return this.db.prepare(`UPDATE repair_cases SET status = 'ready', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE lease_owner IS NOT NULL AND status IN ('working','verifying')`).run(now).changes;
  }

  expireCases(now: Date | string = this.now()): number {
    return this.db.transaction(() => {
      const at = timestamp(now);
      const ids = this.db.prepare(`SELECT id FROM repair_cases
        WHERE status NOT IN ('resolved','exhausted','cancelled') AND expires_at <= ?`).all(at) as Array<{ id: string }>;
      if (ids.length === 0) return 0;
      const placeholders = ids.map(() => "?").join(",");
      const values = ids.map((row) => row.id);
      const changed = this.db.prepare(`UPDATE repair_cases SET status = 'exhausted', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id IN (${placeholders})`).run(at, ...values).changes;
      this.db.prepare(`DELETE FROM repair_case_wakes WHERE case_id IN (${placeholders})`).run(...values);
      return changed;
    })();
  }

  claimRunnable(id: string, owner: string, leaseMs: number): RepairCase | undefined {
    return this.db.transaction(() => {
      const now = this.timestamp();
      const current = this.get(id);
      if (!current || !RUNNABLE.includes(current.status) || current.leaseOwner) return undefined;
      if (current.expiresAt <= now) {
        this.transition(id, "exhausted", { actor: owner, details: { reason: "expired" } });
        return undefined;
      }
      if (current.attempts >= current.maxAttempts) {
        this.transition(id, "exhausted", { actor: owner, details: { reason: "attempt_limit" } });
        return undefined;
      }
      const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
      const result = this.db.prepare(`UPDATE repair_cases SET status = 'working', attempts = attempts + 1,
        lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner IS NULL AND status IN ('ready','working','verifying')`)
        .run(owner, leaseExpiresAt, now, id);
      if (result.changes !== 1) return undefined;
      this.insertActivity(id, "attempt_started", owner, { leaseExpiresAt }, now);
      return this.get(id);
    })();
  }

  releaseLease(id: string, owner: string, status: RepairCaseStatus = "ready"): RepairCase | undefined {
    const now = this.timestamp();
    const result = this.db.prepare(`UPDATE repair_cases SET status = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND status IN ('working','verifying')`).run(status, now, id, owner);
    return result.changes === 1 ? this.get(id) : undefined;
  }

  enqueueDelivery(caseId: string, kind: string, payload: unknown, options: { dedupeKey?: string; availableAt?: Date | string } = {}): RepairCaseOutboxItem {
    const now = this.timestamp();
    const availableAt = options.availableAt ? timestamp(options.availableAt) : now;
    this.db.prepare(`INSERT INTO repair_case_outbox
      (case_id, kind, payload_json, dedupe_key, available_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`).run(caseId, kind, json(payload) ?? "null", options.dedupeKey ?? null, availableAt, now, now);
    const row = options.dedupeKey
      ? this.db.prepare("SELECT * FROM repair_case_outbox WHERE dedupe_key = ?").get(options.dedupeKey)
      : this.db.prepare("SELECT * FROM repair_case_outbox WHERE id = last_insert_rowid()").get();
    return outboxFromRow(row as OutboxRow);
  }

  claimDeliveries(limit = 20): RepairCaseOutboxItem[] {
    return this.db.transaction(() => {
      const now = this.timestamp();
      const rows = this.db.prepare(`SELECT current.id FROM repair_case_outbox current
        WHERE current.status = 'pending' AND current.available_at <= ?
          AND NOT EXISTS (SELECT 1 FROM repair_case_outbox earlier
            WHERE earlier.case_id = current.case_id AND earlier.id < current.id AND earlier.status IN ('pending','claimed'))
        ORDER BY current.id LIMIT ?`)
        .all(now, Math.max(1, limit)) as Array<{ id: number }>;
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.id);
      this.db.prepare(`UPDATE repair_case_outbox SET status = 'claimed', attempts = attempts + 1, claimed_at = ?, updated_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`)
        .run(now, now, ...ids);
      return (this.db.prepare(`SELECT * FROM repair_case_outbox WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).all(...ids) as OutboxRow[]).map(outboxFromRow);
    })();
  }

  recoverClaimedDeliveries(): number {
    const now = this.timestamp();
    return this.db.prepare(`UPDATE repair_case_outbox SET status = 'pending', claimed_at = NULL, updated_at = ? WHERE status = 'claimed'`)
      .run(now).changes;
  }

  settleDelivery(id: number, delivered: boolean, error?: string): RepairCaseOutboxItem | undefined {
    const now = this.timestamp();
    const current = this.db.prepare("SELECT attempts FROM repair_case_outbox WHERE id = ? AND status = 'claimed'").get(id) as { attempts: number } | undefined;
    if (!current) return undefined;
    const status = delivered ? "delivered" : current.attempts >= 5 ? "failed" : "pending";
    const availableAt = delivered ? now : new Date(Date.parse(now) + Math.min(60_000, 2 ** current.attempts * 1_000)).toISOString();
    const result = this.db.prepare(`UPDATE repair_case_outbox SET status = ?, available_at = ?, claimed_at = NULL, delivered_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'claimed'`)
      .run(status, availableAt, delivered ? now : null, error ?? null, now, id);
    const row = result.changes === 1 ? this.db.prepare("SELECT * FROM repair_case_outbox WHERE id = ?").get(id) as OutboxRow : undefined;
    return row ? outboxFromRow(row) : undefined;
  }

  private timestamp(): string { return this.now().toISOString(); }
  private consumedMediaIds(caseId: string, wakeId: number): string[] {
    const rows = this.db.prepare(`SELECT event.media_id, event.media_ids_json FROM repair_case_event_consumptions consumed
      JOIN repair_inbound_events event ON event.id = consumed.inbound_event_id
      WHERE consumed.case_id = ? AND consumed.wake_id = ?`).all(caseId, wakeId) as Array<{ media_id: string | null; media_ids_json: string | null }>;
    return [...new Set(rows.flatMap(inboundMediaIds))];
  }
  private insertActivity(caseId: string, kind: string, actor: string | undefined, details: unknown, createdAt: string) {
    return this.db.prepare("INSERT INTO repair_case_activity (case_id, kind, actor, details_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(caseId, kind, actor ?? null, json(details), createdAt);
  }
}

type MessageRow = { id: number; case_id: string; role: RepairCaseMessageRole; content: string; source_message_id: string | null; metadata_json: string | null; created_at: string };
type ActivityRow = { id: number; case_id: string; kind: string; actor: string | null; details_json: string | null; created_at: string };
type OutboxRow = { id: number; case_id: string; kind: string; payload_json: string; dedupe_key: string | null; status: RepairCaseOutboxItem["status"]; attempts: number; available_at: string; claimed_at: string | null; delivered_at: string | null; last_error: string | null; created_at: string; updated_at: string };

function caseFromRow(row: CaseRow): RepairCase {
  return { id: row.id, status: row.status, guildId: row.guild_id, threadId: row.thread_id, source: row.source,
    userId: row.user_id, authorizationActor: row.authorization_actor, title: row.title, objective: row.objective,
    checkpoint: parseJson(row.checkpoint_json), attempts: row.attempts, maxAttempts: row.max_attempts, expiresAt: row.expires_at,
    leaseOwner: row.lease_owner ?? undefined, leaseExpiresAt: row.lease_expires_at ?? undefined, createdAt: row.created_at,
    updatedAt: row.updated_at, resolvedAt: row.resolved_at ?? undefined, cancelledAt: row.cancelled_at ?? undefined };
}
function messageFromRow(row: MessageRow): RepairCaseMessage {
  return { id: row.id, caseId: row.case_id, role: row.role, content: row.content, sourceMessageId: row.source_message_id ?? undefined,
    metadata: parseJson(row.metadata_json), createdAt: row.created_at };
}
function wakeFromRow(row: WakeRow): RepairCaseWake {
  return row.type === "timer"
    ? { id: row.id, caseId: row.case_id, type: "timer", dueAt: row.due_at!, createdAt: row.created_at }
    : { id: row.id, caseId: row.case_id, type: "arr_event", provider: row.provider!, eventType: row.event_type ?? undefined,
      mediaId: row.media_id ?? undefined, mediaIds: wakeRowMediaIds(row), completionPolicy: row.completion_policy ?? "any",
      fallbackAt: row.due_at ?? undefined, createdAt: row.created_at };
}
function outboxFromRow(row: OutboxRow): RepairCaseOutboxItem {
  return { id: row.id, caseId: row.case_id, kind: row.kind, payload: parseJson(row.payload_json), dedupeKey: row.dedupe_key ?? undefined,
    status: row.status, attempts: row.attempts, availableAt: row.available_at, claimedAt: row.claimed_at ?? undefined,
    deliveredAt: row.delivered_at ?? undefined, lastError: row.last_error ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at };
}
function timestamp(value: Date | string): string { return typeof value === "string" ? new Date(value).toISOString() : value.toISOString(); }
function json(value: unknown): string | null { return value === undefined ? null : JSON.stringify(value) ?? "null"; }
function parseJson(value: string | null): unknown { return value === null ? undefined : JSON.parse(value); }
function objectDetails(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : value === undefined ? {} : { details: value }; }
function expectedWakeMediaIds(wake: Extract<RepairCaseWake, { type: "arr_event" }>): string[] {
  return [...new Set([...(wake.mediaIds ?? []), ...(wake.mediaId ? [wake.mediaId] : [])])];
}

function wakeRowMediaIds(row: WakeRow): string[] {
  const parsed = parseJson(row.media_ids_json);
  return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : row.media_id ? [row.media_id] : [];
}

function inboundMediaIds(row: { media_id: string | null; media_ids_json: string | null }): string[] {
  const parsed = parseJson(row.media_ids_json);
  return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : row.media_id ? [row.media_id] : [];
}

function matchesExpectedMedia(expected: string[], observed: string[]): boolean {
  return expected.length === 0 || expected.some((mediaId) => observed.includes(mediaId));
}

function eventTypesMatch(expected: string | undefined, observed: string): boolean {
  return !expected || expected === observed || (expected === "download" && observed === "manualinteractionrequired");
}

function requiresImmediateAttention(eventType: string): boolean {
  return eventType === "manualinteractionrequired";
}

function wakeSatisfied(expected: string[], observed: string[], policy: "any" | "all"): boolean {
  return policy === "all" ? expected.every((mediaId) => observed.includes(mediaId)) : matchesExpectedMedia(expected, observed);
}

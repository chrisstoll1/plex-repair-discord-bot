import type { RepairCaseWake } from "../storage/repair-cases.js";

export type ExternalWait = {
  reason: "release" | "download" | "import" | "availability" | "external_progress";
  availableAt?: string;
  provider?: "sonarr" | "radarr";
  eventType?: string;
  mediaIds?: string[];
  completionPolicy?: "any" | "all";
};

export type ExternalWaitState = ExternalWait & {
  signature: string;
  unchangedChecks: number;
  nextCheckAt: string;
};

const HOUR_MS = 60 * 60_000;
const RELEASE_GRACE_MS = HOUR_MS;
const MAX_BACKOFF_MS = 24 * HOUR_MS;

export function normalizeExternalWait(wait: ExternalWait, now = new Date()): ExternalWait {
  if (wait.reason !== "release") {
    if (wait.availableAt) throw new Error("availableAt is only valid for a release wait");
    return { ...wait };
  }
  const at = wait.availableAt;
  if (!at || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(at) || !Number.isFinite(Date.parse(at))) {
    throw new Error("A release wait requires availableAt copied from service metadata as an ISO timestamp with a timezone");
  }
  if (Date.parse(at) > now.getTime() + 366 * 24 * HOUR_MS) throw new Error("Release waits cannot be scheduled more than a year ahead");
  return { ...wait, availableAt: new Date(at).toISOString() };
}

export function readExternalWait(checkpoint: unknown): ExternalWaitState | undefined {
  if (!checkpoint || typeof checkpoint !== "object" || !("externalWait" in checkpoint)) return undefined;
  const state = checkpoint.externalWait as Partial<ExternalWaitState> | undefined;
  if (!state || typeof state.signature !== "string" || !Number.isInteger(state.unchangedChecks) || Number(state.unchangedChecks) < 0) return undefined;
  return state as ExternalWaitState;
}

/** Compare durable media state, rather than generated wording or attempt numbers. */
export function planExternalWait(
  wait: ExternalWait,
  wake: RepairCaseWake,
  checkpoint: unknown,
  resume?: { source: "webhook" | "timer" },
  now = new Date(),
): { state: ExternalWaitState; wake: RepairCaseWake; unchanged: boolean; quiet: boolean } {
  const normalized = normalizeExternalWait(wait, now);
  const mediaIds = [...new Set(normalized.mediaIds ?? [])].sort();
  const signature = JSON.stringify([
    normalized.reason, normalized.availableAt ?? null, normalized.provider ?? null,
    normalized.eventType ?? null, mediaIds, mediaIds.length > 1 ? normalized.completionPolicy ?? "any" : "any",
  ]);
  const previous = readExternalWait(checkpoint);
  const unchanged = previous?.signature === signature;
  const unchangedChecks = unchanged && resume?.source === "timer" ? previous.unchangedChecks + 1 : 0;
  const requested = wake.type === "timer" ? wake.dueAt : wake.fallbackAt;
  let dueAt = requested ? new Date(requested).getTime() : now.getTime() + 2 * HOUR_MS;
  if (!Number.isFinite(dueAt)) throw new Error("External wait has an invalid check time");
  if (unchangedChecks > 0) {
    dueAt = Math.max(dueAt, now.getTime() + Math.min(MAX_BACKOFF_MS, 2 * HOUR_MS * 2 ** Math.min(unchangedChecks, 4)));
  }
  if (normalized.availableAt) dueAt = Math.max(dueAt, Date.parse(normalized.availableAt) + RELEASE_GRACE_MS);
  const nextCheckAt = new Date(Math.max(dueAt, now.getTime() + 60_000)).toISOString();
  return {
    state: { ...normalized, mediaIds, signature, unchangedChecks, nextCheckAt },
    wake: wake.type === "timer" ? { ...wake, dueAt: nextCheckAt } : { ...wake, fallbackAt: nextCheckAt },
    unchanged,
    // A direct user follow-up still deserves a reply, even if the state is unchanged.
    quiet: unchanged && Boolean(resume),
  };
}

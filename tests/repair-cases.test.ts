import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { RepairCaseService } from "../src/agent/repair-case-service.js";
import { openDatabase, type AppDatabase } from "../src/storage/db.js";
import { RepairCaseStore, type CreateRepairCase } from "../src/storage/repair-cases.js";

test("cases, complete messages, activity, defaults, and outbox persist across reopen", (t) => {
  const fixture = createFixture(t);
  let db = fixture.open();
  let store = new RepairCaseStore(db);
  const content = "full-message:" + "x".repeat(40_000);
  const repairCase = store.create(caseParams("persistent"));
  store.addMessage(repairCase.id, { role: "user", content, sourceMessageId: "discord-1", metadata: { attachments: ["one"] } });
  store.addMessage(repairCase.id, { role: "user", content: "ignored duplicate", sourceMessageId: "discord-1" });
  store.addActivity(repairCase.id, "inspection", { healthy: false }, "agent");
  const delivery = store.enqueueDelivery(repairCase.id, "discord_message", { content: "update" }, { dedupeKey: "case:update:1" });
  assert.equal(store.enqueueDelivery(repairCase.id, "discord_message", { content: "duplicate" }, { dedupeKey: "case:update:1" }).id, delivery.id);
  db.close();

  db = fixture.open();
  store = new RepairCaseStore(db);
  const loaded = store.get(repairCase.id)!;
  assert.equal(loaded.maxAttempts, 20);
  assert.equal(Date.parse(loaded.expiresAt) - Date.parse(loaded.createdAt), 7 * 86_400_000);
  assert.equal(store.listMessages(loaded.id).length, 1);
  assert.equal(store.listMessages(loaded.id)[0]?.content, content);
  assert.deepEqual(store.listMessages(loaded.id)[0]?.metadata, { attachments: ["one"] });
  assert.equal(store.listActivity(loaded.id).at(-1)?.kind, "inspection");
  const claimed = store.claimDeliveries();
  assert.equal(claimed[0]?.status, "claimed");
  assert.equal(store.settleDelivery(claimed[0]!.id, true)?.status, "delivered");
  db.close();
});

test("delivery retries preserve per-case order without scheduling later messages early", (t) => {
  let now = new Date("2026-07-10T12:00:00.000Z");
  const { db } = openFixture(t);
  const store = new RepairCaseStore(db, () => now);
  const repairCase = store.create(caseParams("ordered-delivery"));
  const first = store.enqueueDelivery(repairCase.id, "discord_message", { content: "first" });
  store.enqueueDelivery(repairCase.id, "discord_message", { content: "second" });
  const claimed = store.claimDeliveries();
  assert.deepEqual(claimed.map((item) => item.id), [first.id]);
  const retry = store.settleDelivery(first.id, false, "temporary")!;
  assert.equal(store.nextDeliveryDueAt(), retry.availableAt);
  assert.deepEqual(store.claimDeliveries(), []);
  now = new Date(Date.parse(retry.availableAt) + 1);
  assert.deepEqual(store.claimDeliveries().map((item) => item.id), [first.id]);
});

test("a Discord thread can own only one repair case", (t) => {
  const { db } = openFixture(t);
  const store = new RepairCaseStore(db);
  const first = store.createOrGetByThread(caseParams("thread-owner"));
  const second = store.createOrGetByThread({ ...caseParams("other-request"), threadId: first.repairCase.threadId });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.repairCase.id, first.repairCase.id);
  assert.throws(() => store.create({ ...caseParams("forced-duplicate"), threadId: first.repairCase.threadId }), /duplicate repair thread/);
});

test("timer wakes are explicit, due timers are claimed once, and event wakes take precedence", (t) => {
  let now = new Date("2026-07-10T12:00:00.000Z");
  const { db } = openFixture(t);
  const store = new RepairCaseStore(db, () => now);
  const timed = store.create(caseParams("timed"));

  assert.equal(store.getWake(timed.id), undefined);
  store.setWake(timed.id, { type: "timer", dueAt: new Date(now.getTime() + 1_000) });
  assert.equal(store.get(timed.id)?.status, "waiting");
  assert.deepEqual(store.claimDueTimers(10, now), []);
  now = new Date(now.getTime() + 1_001);
  assert.deepEqual(store.claimDueTimers(10, now).map((item) => item.id), [timed.id]);
  assert.equal(store.claimDueTimers(10, now).length, 0);
  assert.equal(store.getWake(timed.id), undefined);

  const eventCase = store.create(caseParams("event-preferred"));
  store.setWake(eventCase.id, { type: "arr_event", provider: "sonarr", eventType: "Download", mediaId: "episode-2" });
  const retained = store.setWake(eventCase.id, { type: "timer", dueAt: new Date(now.getTime() + 10_000) });
  assert.equal(retained.type, "arr_event");
});

test("inbound events match provider, event type, and media and are deduplicated", (t) => {
  const { db } = openFixture(t);
  const store = new RepairCaseStore(db);
  const exact = store.create(caseParams("exact"));
  const wildcard = store.create(caseParams("wildcard"));
  const other = store.create(caseParams("other"));
  store.setWake(exact.id, { type: "arr_event", provider: "sonarr", eventType: "Download", mediaId: "42" });
  store.setWake(wildcard.id, { type: "arr_event", provider: "sonarr" });
  store.setWake(other.id, { type: "arr_event", provider: "radarr", eventType: "Download", mediaId: "42" });

  const received = store.receiveEvent({ provider: "sonarr", eventId: "evt-1", eventType: "Download", mediaId: "42", payload: { ok: true } });
  assert.equal(received.duplicate, false);
  assert.deepEqual(new Set(received.matchedCaseIds), new Set([exact.id, wildcard.id]));
  assert.equal(store.get(exact.id)?.status, "ready");
  assert.equal(store.get(other.id)?.status, "waiting");
  assert.deepEqual(store.receiveEvent({ provider: "sonarr", eventId: "evt-1", eventType: "Download", mediaId: "42" }), {
    duplicate: true,
    matchedCaseIds: [],
  });

  const series = store.create(caseParams("series-match"));
  store.setWake(series.id, { type: "arr_event", provider: "sonarr", eventType: "download", mediaId: "series:1480" });
  const hierarchical = store.receiveEvent({
    provider: "sonarr",
    eventId: "evt-hierarchical",
    eventType: "download",
    mediaIds: ["episode:152122", "series:1480"],
  });
  assert.deepEqual(hierarchical.matchedCaseIds, [series.id]);
  assert.equal(store.get(series.id)?.status, "ready");

  store.receiveEvent({ provider: "sonarr", eventId: "early-event", eventType: "download", mediaIds: ["episode:late", "series:late"] });
  const late = store.create(caseParams("late-wake"));
  store.setWake(late.id, { type: "arr_event", provider: "sonarr", eventType: "download", mediaId: "series:late" });
  assert.equal(store.get(late.id)?.status, "ready");
  assert.equal((store.latestActivity(late.id)?.details as { reason?: string }).reason, "recent_event");
});

test("multi-media waits resume only after all expected events and do not replay consumed events", (t) => {
  const { db } = openFixture(t);
  const store = new RepairCaseStore(db);
  const repairCase = store.create(caseParams("all-episodes"));
  const expected = ["episode:1", "episode:2", "episode:3"];
  store.setWake(repairCase.id, { type: "arr_event", provider: "sonarr", eventType: "download", mediaIds: expected, completionPolicy: "all" });

  assert.deepEqual(store.receiveEvent({ provider: "sonarr", eventId: "one", eventType: "download", mediaIds: ["episode:1", "series:9"] }).matchedCaseIds, []);
  assert.equal(store.get(repairCase.id)?.status, "waiting");
  assert.deepEqual(store.receiveEvent({ provider: "sonarr", eventId: "two", eventType: "download", mediaId: "episode:2" }).matchedCaseIds, []);
  assert.deepEqual(store.receiveEvent({ provider: "sonarr", eventId: "three", eventType: "download", mediaId: "episode:3" }).matchedCaseIds, [repairCase.id]);
  assert.equal(store.get(repairCase.id)?.status, "ready");

  store.setWake(repairCase.id, { type: "arr_event", provider: "sonarr", eventType: "download", mediaIds: expected, completionPolicy: "all" });
  assert.equal(store.get(repairCase.id)?.status, "waiting");
  assert.deepEqual(store.receiveEvent({ provider: "sonarr", eventId: "one-again", eventType: "download", mediaId: "episode:1" }).matchedCaseIds, []);
  assert.equal(store.get(repairCase.id)?.status, "waiting");
});

test("service suppresses duplicate progress without adding idle messages", async (t) => {
  const { db } = openFixture(t);
  const store = new RepairCaseStore(db);
  const repairCase = store.create(caseParams("quiet-progress"));
  const delivered: unknown[] = [];
  const service = new RepairCaseService(store, {
    runner: async (_current, context) => {
      await context.progress("Checking the imported episodes.");
      await context.progress("Checking the imported episodes.");
      await delay(50);
      return { status: "resolved" };
    },
    onDelivery: async (delivery) => { delivered.push(delivery.payload); },
  });
  service.start();
  await waitUntil(() => store.get(repairCase.id)?.status === "resolved");
  assert.deepEqual(delivered, ["Checking the imported episodes."]);
  assert.equal(store.listActivity(repairCase.id).filter((entry) => entry.kind === "progress").length, 1);
  await service.shutdown();
});

test("event waits have no timer, preserve webhook context, and convert when the provider is disabled", async (t) => {
  let now = new Date("2026-07-10T12:00:00.000Z");
  const { db } = openFixture(t);
  const store = new RepairCaseStore(db, () => now);
  const repairCase = store.create(caseParams("webhook-resume"));
  store.setWake(repairCase.id, { type: "arr_event", provider: "sonarr", eventType: "download", mediaId: "episode:42" });
  assert.equal(store.getWake(repairCase.id)?.type, "arr_event");
  assert.equal(store.nextTimerDueAt(), undefined);

  let observedResume: unknown;
  const service = new RepairCaseService(store, {
    runner: async (_current, context) => {
      observedResume = context.resume;
      return { status: "resolved" };
    },
  });
  service.start();
  service.receiveEvent({ provider: "sonarr", eventId: "download-42", eventType: "download", mediaIds: ["episode:42"] });
  await waitUntil(() => store.get(repairCase.id)?.status === "resolved");
  assert.deepEqual(observedResume, { source: "webhook", provider: "sonarr", eventType: "download", mediaIds: ["episode:42"] });
  await service.shutdown();

  const disabled = store.create(caseParams("provider-disabled"));
  store.setWake(disabled.id, { type: "arr_event", provider: "sonarr", mediaId: "episode:99" });
  const dueAt = new Date("2026-07-10T12:15:00.000Z");
  assert.equal(store.replaceProviderWakesWithTimers("sonarr", dueAt), 1);
  const converted = store.getWake(disabled.id);
  assert.equal(converted?.type, "timer");
  assert.equal(converted?.type === "timer" ? converted.dueAt : undefined, dueAt.toISOString());
  now = new Date("2026-07-10T12:15:00.001Z");
  assert.deepEqual(store.claimDueTimers().map((item) => item.id), [disabled.id]);
  assert.equal((store.latestActivity(disabled.id)?.details as { reason?: string }).reason, "timer");
});

test("an event received during work reruns immediately without sending a stale waiting update", async (t) => {
  const { db } = openFixture(t);
  const store = new RepairCaseStore(db);
  store.receiveEvent({ provider: "sonarr", eventId: "already-imported", eventType: "download", mediaId: "episode:42" });
  const repairCase = store.create(caseParams("event-during-work"));
  let runs = 0;
  const delivered: unknown[] = [];
  const service = new RepairCaseService(store, {
    runner: async () => {
      runs += 1;
      return runs === 1
        ? { wake: { type: "arr_event", provider: "sonarr", eventType: "download", mediaId: "episode:42" }, activity: { kind: "waiting", details: "stale" }, deliveries: [{ kind: "discord_message", payload: "stale" }] }
        : { status: "resolved" };
    },
    onDelivery: async (delivery) => { delivered.push(delivery.payload); },
  });
  service.start();
  await waitUntil(() => store.get(repairCase.id)?.status === "resolved");
  assert.equal(runs, 2);
  assert.deepEqual(delivered, []);
  assert.equal(store.listActivity(repairCase.id).some((entry) => entry.details === "stale"), false);
  await service.shutdown();
});

test("service runs cases fairly within concurrency, and waiting cases consume no slot", async (t) => {
  const { db } = openFixture(t);
  const store = new RepairCaseStore(db);
  const cases = [store.create(caseParams("one")), store.create(caseParams("two")), store.create(caseParams("three"))];
  let active = 0;
  let maximum = 0;
  const started: string[] = [];
  const service = new RepairCaseService(store, {
    maxConcurrent: 2,
    runner: async (repairCase) => {
      active += 1;
      maximum = Math.max(maximum, active);
      started.push(repairCase.title);
      await delay(15);
      active -= 1;
      return repairCase.title === "one"
        ? { wake: { type: "arr_event", provider: "sonarr", mediaId: "1" } }
        : { status: "resolved" };
    },
  });
  service.start();
  await waitUntil(() => cases.every((item) => ["waiting", "resolved"].includes(store.get(item.id)!.status)));
  assert.equal(maximum, 2);
  assert.deepEqual(started, ["one", "two", "three"]);
  assert.equal(store.get(cases[0]!.id)?.status, "waiting");
  assert.equal(store.get(cases[1]!.id)?.status, "resolved");
  await service.shutdown();
});

test("service recovers expired leases, receives events, and cancels running work", async (t) => {
  let now = new Date("2026-07-10T12:00:00.000Z");
  const { db } = openFixture(t);
  const store = new RepairCaseStore(db, () => now);
  const crashed = store.create(caseParams("crashed"));
  assert.equal(store.claimRunnable(crashed.id, "dead-process", 100)?.status, "working");
  now = new Date(now.getTime() + 101);
  let aborted = false;
  const service = new RepairCaseService(store, {
    ownerId: "replacement",
    runner: async (repairCase, context) => {
      if (repairCase.title === "cancel-me") {
        await waitForAbort(context.signal);
        aborted = true;
        throw context.signal.reason;
      }
      return { status: "resolved", checkpoint: { recovered: true } };
    },
  });
  service.start();
  await waitUntil(() => store.get(crashed.id)?.status === "resolved");
  assert.deepEqual(store.get(crashed.id)?.checkpoint, { recovered: true });
  assert.equal(store.get(crashed.id)?.attempts, 2);

  const eventCase = store.create(caseParams("event-case"));
  store.setWake(eventCase.id, { type: "arr_event", provider: "radarr", eventType: "Rename", mediaId: "movie" });
  assert.deepEqual(service.receiveEvent({ provider: "radarr", eventId: "rename-1", eventType: "Rename", mediaId: "movie" }).matchedCaseIds, [eventCase.id]);
  await waitUntil(() => store.get(eventCase.id)?.status === "resolved");

  const cancellable = store.create(caseParams("cancel-me"));
  service.notifyNewMessage(cancellable.id, { content: "start" });
  await waitUntil(() => store.get(cancellable.id)?.status === "working");
  assert.equal(service.cancel(cancellable.id, "user")?.status, "cancelled");
  await waitUntil(() => aborted);
  assert.equal(store.get(cancellable.id)?.status, "cancelled");
  await service.shutdown();
});

test("runner timeout remains visible and automatically continues when an aborted runner resolves normally", async (t) => {
  const { db } = openFixture(t);
  const store = new RepairCaseStore(db);
  const repairCase = store.create(caseParams("timeout-visible"));
  const delivered: unknown[] = [];
  const cancelledWork: string[] = [];
  let runs = 0;
  const service = new RepairCaseService(store, {
    leaseMs: 100,
    maxRuntimeMs: 5,
    runner: async (_current, context) => {
      runs += 1;
      if (runs > 1) return { status: "resolved" };
      await waitForAbort(context.signal);
      return { status: "resolved" };
    },
    onSystemEvent: async (_current, event) => event.type === "timeout_continuing" ? "Generated continuation update" : undefined,
    onDelivery: async (delivery) => { delivered.push(delivery.payload); },
    onCancelWork: (caseId) => { cancelledWork.push(caseId); },
  });
  service.start();
  await waitUntil(() => store.get(repairCase.id)?.status === "resolved");
  await waitUntil(() => delivered.length === 1);
  assert.equal(store.get(repairCase.id)?.attempts, 2);
  assert.equal(store.listActivity(repairCase.id).some((entry) => entry.kind === "user_update" && (entry.details as { event?: string }).event === "timeout_continuing"), true);
  assert.match(JSON.stringify(delivered[0]), /Generated continuation update/);
  assert.deepEqual(cancelledWork, [repairCase.id]);
  await service.shutdown();
});

test("a new thread message reopens a completed repair without another mention", async (t) => {
  const { db } = openFixture(t);
  const store = new RepairCaseStore(db);
  const repairCase = store.create(caseParams("reopen-completed"));
  store.transition(repairCase.id, "resolved", { from: ["ready"] });
  const service = new RepairCaseService(store, { runner: async () => ({ status: "resolved" }) });
  service.start();
  const reopened = service.notifyNewMessage(repairCase.id, { content: "That fixed most of it, but episode 13 is still missing.", sourceMessageId: "follow-up" });
  assert.equal(reopened.status, "ready");
  await waitUntil(() => store.get(repairCase.id)?.status === "resolved" && store.get(repairCase.id)?.attempts === 1);
  assert.equal(store.listMessages(repairCase.id).at(-1)?.sourceMessageId, "follow-up");
  assert.equal(store.listActivity(repairCase.id).some((entry) => entry.kind === "status_changed" && (entry.details as { reason?: string }).reason === "new_thread_message"), true);
  await service.shutdown();
});

test("a follow-up interrupts stale running work and reruns with the new message", async (t) => {
  const { db } = openFixture(t);
  const store = new RepairCaseStore(db);
  const repairCase = store.create(caseParams("interrupt-follow-up"));
  let runs = 0;
  const service = new RepairCaseService(store, {
    runner: async (_current, context) => {
      runs += 1;
      if (runs === 1) {
        await waitForAbort(context.signal);
        throw context.signal.reason;
      }
      assert.equal(context.messages.at(-1)?.content, "Actually, check episode four instead.");
      return { status: "resolved" };
    },
  });
  service.start();
  await waitUntil(() => store.get(repairCase.id)?.status === "working");
  service.notifyNewMessage(repairCase.id, { content: "Actually, check episode four instead.", sourceMessageId: "correction" });
  await waitUntil(() => store.get(repairCase.id)?.status === "resolved");
  assert.equal(runs, 2);
  assert.equal(store.listActivity(repairCase.id).some((entry) => entry.kind === "rerun_requested"), true);
  await service.shutdown();
});

test("clearing all repairs aborts work and removes completed history", async (t) => {
  const { db } = openFixture(t);
  const store = new RepairCaseStore(db);
  const running = store.create(caseParams("clear-running"));
  const waiting = store.create(caseParams("clear-waiting"));
  store.setWake(waiting.id, { type: "timer", dueAt: new Date(Date.now() + 60_000) });
  const completed = store.create(caseParams("keep-completed"));
  store.transition(completed.id, "resolved", { from: ["ready"] });
  const service = new RepairCaseService(store, {
    runner: async (repairCase, context) => {
      if (repairCase.id === running.id) await waitForAbort(context.signal);
      return { status: "resolved" };
    },
  });
  service.start();
  await waitUntil(() => store.get(running.id)?.status === "working");
  assert.equal(await service.clearAll("test"), 3);
  assert.equal(store.get(running.id), undefined);
  assert.equal(store.get(waiting.id), undefined);
  assert.equal(store.get(completed.id), undefined);
  await service.shutdown();
});

function caseParams(title: string): CreateRepairCase {
  return {
    id: title,
    guildId: "guild",
    threadId: `thread-${title}`,
    source: "discord",
    userId: "user",
    authorizationActor: "user:admin",
    title,
    objective: `Repair ${title}`,
  };
}

function createFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plex-repair-cases-"));
  let latest: AppDatabase | undefined;
  t.after(() => {
    if (latest?.open) latest.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    open() {
      latest = openDatabase({ databasePath: path.join(root, "app.db") } as AppConfig);
      return latest;
    },
  };
}

function openFixture(t: test.TestContext) {
  const fixture = createFixture(t);
  return { db: fixture.open() };
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await delay(2);
  }
  throw new Error("Condition was not met");
}

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
  });
  service.start();
  await waitUntil(() => store.get(repairCase.id)?.status === "resolved");
  await waitUntil(() => delivered.length === 1);
  assert.equal(store.get(repairCase.id)?.attempts, 2);
  assert.equal(store.listActivity(repairCase.id).some((entry) => entry.kind === "user_update" && (entry.details as { event?: string }).event === "timeout_continuing"), true);
  assert.match(JSON.stringify(delivered[0]), /Generated continuation update/);
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

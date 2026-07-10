import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { ToolAgentQueueService, type ToolAgentTaskRequest } from "../src/agent/tool-agent-queue.js";
import { openDatabase } from "../src/storage/db.js";
import { ToolAgentTaskStore, type CreateToolAgentTaskParams } from "../src/storage/tool-agent-tasks.js";

test("running cancellation aborts cooperatively and retains its concurrency slot until stopped", async (t) => {
  const { store, close } = createStore();
  t.after(close);
  const started: string[] = [];
  let stopped = false;
  const queue = new ToolAgentQueueService(
    store,
    async (task, _roles, signal) => {
      started.push(task.id);
      if (started.length === 1) {
        await aborted(signal);
        await delay(30);
        stopped = true;
        throw signal.reason;
      }
      assert.equal(stopped, true);
      return "second result";
    },
    undefined,
    { maxConcurrent: 1, maxRuntimeMs: 1000 },
  );

  const first = queue.enqueue(request("first"));
  const second = queue.enqueue(request("second"));
  await waitUntil(() => queue.get(first.id)?.status === "running");
  const cancellation = queue.cancel(first.id, { conversationKey: "conversation", userId: "user" });
  await delay(10);
  assert.deepEqual(started, [first.id]);

  assert.equal((await cancellation)?.status, "cancelled");
  assert.equal((await queue.waitForTask(second.id)).status, "succeeded");
  assert.deepEqual(started, [first.id, second.id]);
});

test("timeout aborts before another task starts and settles only after the runner stops", async (t) => {
  const { store, close } = createStore();
  t.after(close);
  const events: string[] = [];
  const queue = new ToolAgentQueueService(
    store,
    async (task, _roles, signal) => {
      events.push(`start:${task.title}`);
      if (task.title === "slow") {
        await aborted(signal);
        events.push("abort:slow");
        await delay(25);
        events.push("stop:slow");
        throw signal.reason;
      }
      events.push("stop:next");
      return "ok";
    },
    undefined,
    { maxConcurrent: 1, maxRuntimeMs: 20 },
  );

  const slow = queue.enqueue(request("slow"));
  const next = queue.enqueue(request("next"));
  assert.equal((await queue.waitForTask(slow.id)).status, "failed");
  assert.equal((await queue.waitForTask(next.id)).status, "succeeded");
  assert.deepEqual(events, ["start:slow", "abort:slow", "stop:slow", "start:next", "stop:next"]);
});

test("ownership scope and parent filters cannot be bypassed", (t) => {
  const { store, close } = createStore();
  t.after(close);
  const parent = store.create(taskParams("parent", "conversation-a", "user-a"));
  const ownedChild = store.create({ ...taskParams("owned-child", "conversation-a", "user-a"), parentTaskId: parent.id });
  store.create(taskParams("other-user", "conversation-a", "user-b"));
  store.create(taskParams("other-conversation", "conversation-b", "user-a"));

  assert.equal(store.getScoped(parent.id, { conversationKey: "conversation-a", userId: "user-a" })?.id, parent.id);
  assert.equal(store.getScoped(parent.id, { conversationKey: "conversation-a", userId: "user-b" }), undefined);
  assert.deepEqual(
    store.list({ conversationKey: "conversation-a", userId: "user-a", parentTaskId: parent.id }).map((task) => task.id),
    [ownedChild.id],
  );
  assert.throws(
    () => store.create({ ...taskParams("invalid-child", "conversation-a", "user-b"), parentTaskId: parent.id }),
    /not found in this conversation/,
  );

  const queue = new ToolAgentQueueService(store, async () => "unused");
  assert.throws(
    () => queue.list({ conversationKey: "conversation-a", userId: "user-b", parentTaskId: parent.id }),
    /not found in this conversation/,
  );
});

test("task transitions are atomic, terminal states are guarded, and stored JSON remains valid", (t) => {
  const { store, close } = createStore();
  t.after(close);
  const task = store.create(taskParams("transition", "conversation", "user", { value: "valid" }));
  assert.equal(store.markSucceeded(task.id, "too early"), undefined);
  assert.equal(store.markRunning(task.id)?.status, "running");
  assert.equal(store.markRunning(task.id), undefined);
  const succeeded = store.markSucceeded(task.id, "ok", { value: "\\\"".repeat(20000) });
  assert.equal(succeeded?.status, "succeeded");
  assert.equal((succeeded?.result as { truncated?: boolean }).truncated, true);
  assert.equal(store.markFailed(task.id, "late failure"), undefined);
  assert.equal(store.markCancelled(task.id), undefined);
  assert.equal(store.get(task.id)?.status, "succeeded");
  assert.throws(
    () => store.create(taskParams("oversized", "conversation", "user", { value: "x".repeat(12000) })),
    /input exceeds/,
  );
});

test("shutdown cancels queued work, aborts running work, and rejects new tasks", async (t) => {
  const { store, close } = createStore();
  t.after(close);
  const queue = new ToolAgentQueueService(
    store,
    async (_task, _roles, signal) => {
      await aborted(signal);
      throw signal.reason;
    },
    undefined,
    { maxConcurrent: 1, maxRuntimeMs: 1000 },
  );
  const running = queue.enqueue(request("running"));
  const queued = queue.enqueue(request("queued"));
  await waitUntil(() => queue.get(running.id)?.status === "running");

  await queue.shutdown();

  assert.equal(queue.get(running.id)?.status, "cancelled");
  assert.equal(queue.get(queued.id)?.status, "cancelled");
  assert.throws(() => queue.enqueue(request("late")), /shutting down/);
});

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plex-repairman-tasks-"));
  const config = { databasePath: path.join(root, "app.db") } as AppConfig;
  const db = openDatabase(config);
  return {
    store: new ToolAgentTaskStore(db),
    close: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function request(title: string): ToolAgentTaskRequest {
  return {
    title,
    toolProfile: "media_readonly_agent",
    prompt: title,
    conversationKey: "conversation",
    channelId: "channel",
    userId: "user",
    roles: [],
  };
}

function taskParams(id: string, conversationKey: string, userId: string, input?: unknown): CreateToolAgentTaskParams {
  return {
    id,
    title: id,
    toolProfile: "media_readonly_agent",
    prompt: id,
    conversationKey,
    channelId: "channel",
    userId,
    input,
  };
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(2);
  }
  throw new Error("Condition was not met");
}

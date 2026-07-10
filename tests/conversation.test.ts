import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { KeyedSerialQueue } from "../src/discord/bot.js";
import { ConversationStore } from "../src/storage/conversation.js";
import { openDatabase } from "../src/storage/db.js";

function createStore(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plex-repairman-conversation-"));
  const config = {
    databasePath: path.join(root, "app.db"),
  } as AppConfig;
  const db = openDatabase(config);
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { db, store: new ConversationStore(db) };
}

test("ConversationStore writes an exchange atomically and filters assistant history", (t) => {
  const { db, store } = createStore(t);
  const createdAt = new Date("2026-07-09T12:00:00.000Z");

  store.addExchange({
    conversationKey: "one",
    userId: "user",
    userMessageId: "discord-1",
    userContent: "question",
    userCreatedAt: createdAt,
    assistantUserId: "bot",
    assistantContent: "delivered answer",
  });

  assert.equal(store.hasMessageId("discord-1"), true);
  assert.deepEqual(store.getRecent("one", 10, 100_000, false).map((message) => message.content), ["question"]);
  assert.deepEqual(store.getRecent("one", 10, 100_000, true).map((message) => message.content), ["question", "delivered answer"]);

  db.exec(`CREATE TRIGGER reject_assistant BEFORE INSERT ON conversation_messages
    WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'rejected'); END`);
  assert.throws(() => store.addExchange({
    conversationKey: "two",
    userId: "user",
    userMessageId: "discord-2",
    userContent: "must roll back",
    userCreatedAt: createdAt,
    assistantContent: "rejected",
  }), /rejected/);
  assert.equal(store.hasMessageId("discord-2"), false);

  store.recordProcessedMessage("discord-without-memory");
  assert.equal(store.hasMessageId("discord-without-memory"), true);
  assert.equal(store.listSessions(100_000).some((session) => session.conversationKey === "discord-without-memory"), false);

  db.prepare("UPDATE processed_discord_messages SET created_at = ? WHERE message_id = ?").run("2000-01-01T00:00:00.000Z", "discord-without-memory");
  store.prune(1);
  assert.equal(store.hasMessageId("discord-without-memory"), false);
});

test("ConversationStore chooses the latest session row by timestamp rather than id", (t) => {
  const { store } = createStore(t);
  store.addMessage({ conversationKey: "session", role: "assistant", content: "newer", createdAt: new Date() });
  store.addMessage({ conversationKey: "session", role: "user", content: "older higher id", createdAt: new Date(Date.now() - 1_000) });

  const [session] = store.listSessions(1);
  assert.equal(session?.latestContent, "newer");
  assert.equal(session?.latestRole, "assistant");
});

test("KeyedSerialQueue serializes matching keys while allowing other keys to run", async () => {
  const queue = new KeyedSerialQueue();
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = queue.run("same", async () => {
    events.push("first:start");
    await blocked;
    events.push("first:end");
  });
  const second = queue.run("same", async () => { events.push("second"); });
  const other = queue.run("other", async () => { events.push("other"); });

  await other;
  assert.deepEqual(events, ["first:start", "other"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "other", "first:end", "second"]);
});

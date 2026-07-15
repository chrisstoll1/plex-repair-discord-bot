import assert from "node:assert/strict";
import test from "node:test";
import { DiscordBotService } from "../src/discord/bot.js";
import type { RepairCase, RepairCaseStatus } from "../src/storage/repair-cases.js";

const logger = {
  debug() {},
  error(value: unknown) {
    if (value && typeof value === "object" && "err" in value) throw value.err;
  },
  info() {},
  warn() {},
};
const settingsStore = {
  getString: () => undefined,
  getJson: (_key: string, fallback: unknown) => fallback,
};

test("new repair cases rely on reactions and typing instead of a generic acknowledgement", async () => {
  const repairCase = caseWithStatus("ready");
  const deliveries: unknown[] = [];
  let notified = false;
  const store = {
    createOrGetByThread: () => ({ repairCase, created: true }),
    enqueueDelivery: (...args: unknown[]) => deliveries.push(args),
    get: () => undefined,
    ...settingsStore,
  };
  const conversations = {
    hasMessageId: () => false,
    recordProcessedMessage() {},
  };
  const service = {
    notifyNewMessage: () => {
      notified = true;
      return repairCase;
    },
  };
  const channel = { isTextBased: () => true, sendTyping: async () => undefined };
  const message = fakeMessage("request-1", channel);
  const bot = new DiscordBotService(store as never, conversations as never, logger as never, store as never);
  bot.setRepairCaseService(service as never);

  await (bot as unknown as {
    handleRepairCaseMessage(message: unknown, content: string): Promise<void>;
  }).handleRepairCaseMessage(message, "Hello");

  assert.equal(notified, true);
  assert.deepEqual(deliveries, []);
  assert.deepEqual([...message.reactions.cache.keys()], ["👀"]);
  await bot.stopRepairCaseActivity(repairCase.id);
});

test("paused repair indicators remain attached until a terminal state replaces them", async () => {
  const bot = new DiscordBotService({} as never, {} as never, logger as never);
  const applied: string[] = [];
  let stopped = 0;
  let resumed = 0;
  const indicators = {
    reactions: { set: async (emoji: string) => { applied.push(emoji); } },
    stop: () => { stopped += 1; },
    resume: () => { resumed += 1; },
  };
  const registry = (bot as unknown as {
    repairIndicators: Map<string, typeof indicators>;
  }).repairIndicators;
  const settle = (value: RepairCase) => (bot as unknown as {
    settleRepairIndicators(repairCase: RepairCase): Promise<void>;
  }).settleRepairIndicators(value);

  registry.set("case-1", indicators);
  await settle(caseWithStatus("waiting"));
  assert.equal(registry.get("case-1"), indicators);
  assert.deepEqual(applied, ["⏳"]);

  (bot as unknown as { client: unknown }).client = {
    channels: { fetch: async () => ({ isTextBased: () => true }) },
  };
  await bot.startRepairCaseActivity(caseWithStatus("ready"));
  assert.equal(resumed, 1);

  await settle(caseWithStatus("resolved"));
  assert.equal(registry.has("case-1"), false);
  assert.deepEqual(applied, ["⏳", "✅"]);
  assert.equal(stopped, 2);
});

test("activity recovery follows the latest persisted user message", async () => {
  const repairCase = caseWithStatus("ready");
  const fetched: string[] = [];
  let fetchedStarter = false;
  const channel = {
    isTextBased: () => true,
    isThread: () => true,
    messages: {
      fetch: async (id: string) => {
        fetched.push(id);
        return message;
      },
    },
    fetchStarterMessage: async () => {
      fetchedStarter = true;
      return message;
    },
    sendTyping: async () => undefined,
  };
  const client = {
    user: { id: "bot-1" },
    channels: { fetch: async () => channel },
  };
  const message = fakeMessage("follow-up", channel, client);
  const store = {
    listMessages: () => [
      { role: "user", sourceMessageId: "original" },
      { role: "assistant", sourceMessageId: "reply" },
      { role: "user", sourceMessageId: "follow-up" },
    ],
  };
  const bot = new DiscordBotService(settingsStore as never, {} as never, logger as never, store as never);
  (bot as unknown as { client: unknown }).client = client;

  await bot.startRepairCaseActivity(repairCase);

  assert.deepEqual(fetched, ["follow-up"]);
  assert.equal(fetchedStarter, false);
  assert.deepEqual([...message.reactions.cache.keys()], ["👀"]);
  await bot.stopRepairCaseActivity(repairCase.id);
});

function caseWithStatus(status: RepairCaseStatus): RepairCase {
  return {
    id: "case-1",
    status,
    guildId: "",
    threadId: "thread-1",
    source: "original",
    userId: "user-1",
    authorizationActor: "user-1",
    title: "Test repair",
    objective: "Test repair",
    attempts: 1,
    maxAttempts: 20,
    expiresAt: "2026-07-22T00:00:00.000Z",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function fakeMessage(id: string, channel: unknown, client: unknown = { user: { id: "bot-1" } }) {
  const cache = new Map<string, { me: boolean; users: { remove: (userId: string) => Promise<void> } }>();
  const message = {
    id,
    guildId: null,
    channelId: "thread-1",
    channel,
    client,
    author: { id: "user-1" },
    member: undefined,
    createdAt: new Date("2026-07-15T00:00:00.000Z"),
    reactions: { cache },
    reply: async () => undefined,
    react: async (emoji: string) => {
      cache.set(emoji, {
        me: true,
        users: { remove: async () => { cache.delete(emoji); } },
      });
    },
  };
  return message;
}

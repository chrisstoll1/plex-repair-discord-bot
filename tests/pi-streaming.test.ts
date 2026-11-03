import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { piAiPackageDir } from "../scripts/pi-ai-package.mjs";
import { readAgentSessionResponse } from "../src/agent/pi-agent.js";
import { RepairCaseService } from "../src/agent/repair-case-service.js";
import { RepairCaseStore } from "../src/storage/repair-cases.js";
import { openDatabase } from "../src/storage/db.js";
import type { AppConfig } from "../src/config.js";

const piAiDist = path.join(piAiPackageDir, "dist");
const { parseStreamingJson } = await import(pathToFileURL(path.join(piAiDist, "utils/json-parse.js")).href);

test("Pi rejects oversized tool arguments before attempting JSON repair", () => {
  for (const input of [JSON.stringify({ value: "x".repeat(65_536) }), '{"value":"' + "x".repeat(65_536), '{"checkpoint":"complete"' + " ".repeat(65_536)]) {
    assert.throws(() => parseStreamingJson(input), /Tool call arguments exceeded the 65536 character safety limit/);
  }
  assert.deepEqual(parseStreamingJson('{"value":"normal"}'), { value: "normal" });
});

test("a runaway Codex tool stream fails promptly and leaves HTTP and timers responsive", async () => {
  // A subprocess deadline still works if the provider parser blocks its event loop.
  const { stdout } = await promisify(execFile)(process.execPath, ["tests/fixtures/pi-streaming.mjs"], {
    timeout: 10_000,
    maxBuffer: 32_000,
  });
  const { failure, ...status } = JSON.parse(stdout);
  assert.deepEqual(status, { oversized: "error", normal: "toolUse", health: 200, timerFired: true });

  // Feed the real provider error through the repair runner: it must leave
  // "working", release ownership and deliver a fallback without another AI call.
  const db = openDatabase({ databasePath: ":memory:" } as AppConfig);
  const store = new RepairCaseStore(db);
  const repairCase = store.create({ id: "oversized", guildId: "guild", threadId: "thread", source: "discord", userId: "user", authorizationActor: "user", title: "Missing episode", objective: "Diagnose missing episode" });
  const delivered: unknown[] = [];
  let statusCalls = 0;
  const service = new RepairCaseService(store, {
    runner: async () => { readAgentSessionResponse({ messages: [failure] }, true); return { status: "resolved" }; },
    onSystemEvent: async () => { statusCalls += 1; return "Unexpected extra AI call"; },
    onDelivery: async (delivery) => { delivered.push(delivery.payload); },
  });
  try {
    service.start();
    const deadline = Date.now() + 2_000;
    while (!delivered.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(store.get(repairCase.id)?.status, "blocked");
    assert.equal(store.get(repairCase.id)?.leaseOwner, undefined);
    assert.equal(delivered.length, 1);
    assert.equal(statusCalls, 0);
    assert.match(JSON.stringify(delivered[0]), /stopped this repair safely/);
    assert.match(JSON.stringify(store.listActivity(repairCase.id)), /65536 character safety limit/);
  } finally {
    await service.shutdown();
    db.close();
  }
});

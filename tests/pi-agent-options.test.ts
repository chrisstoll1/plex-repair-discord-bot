import assert from "node:assert/strict";
import test from "node:test";
import { applyOpenAiCodexServiceTier, repairProgressLimit, resolveConfiguredModel } from "../src/agent/pi-agent.js";

test("priority service tier is added only to OpenAI Codex payloads", () => {
  const payload = { model: "gpt-5.6-sol", stream: true };

  assert.deepEqual(applyOpenAiCodexServiceTier(payload, "openai-codex", "priority"), {
    ...payload,
    service_tier: "priority",
  });
  assert.deepEqual(payload, { model: "gpt-5.6-sol", stream: true });
  assert.equal(applyOpenAiCodexServiceTier(payload, "openai-codex", "default"), payload);
  assert.equal(applyOpenAiCodexServiceTier(payload, "openai", "priority"), payload);
  assert.equal(applyOpenAiCodexServiceTier(null, "openai-codex", "priority"), null);
});

test("explicitly configured models cannot silently fall back", () => {
  const expected = { id: "gpt-5.6-sol" };
  const registry = { find: (provider: string, modelId: string) => provider === "openai-codex" && modelId === expected.id ? expected : undefined };

  assert.equal(resolveConfiguredModel(registry as never, "openai-codex", expected.id), expected);
  assert.equal(resolveConfiguredModel(registry as never, "openai-codex", ""), undefined);
  assert.throws(
    () => resolveConfiguredModel(registry as never, "openai-codex", "missing"),
    /Configured AI model is unavailable: openai-codex\/missing/,
  );
});

test("resumed repairs emit only one task progress update", () => {
  assert.equal(repairProgressLimit(), 2);
  assert.equal(repairProgressLimit({ source: "webhook" }), 1);
  assert.equal(repairProgressLimit({ source: "timer" }), 1);
});

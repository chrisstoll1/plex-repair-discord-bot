import assert from "node:assert/strict";
import test from "node:test";
import { applyOpenAiCodexServiceTier } from "../src/agent/pi-agent.js";

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

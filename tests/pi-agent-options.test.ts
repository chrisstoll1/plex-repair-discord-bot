import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ModelUnavailableError } from "../src/agent/model-errors.js";
import { applyOpenAiCodexServiceTier, readAgentSessionResponse, repairProgressLimit, resolveConfiguredModel } from "../src/agent/pi-agent.js";

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
    { name: "ModelUnavailableError", message: "Configured AI model is unavailable: openai-codex/missing" },
  );
});

test("resumed repairs emit only one task progress update", () => {
  assert.equal(repairProgressLimit(), 2);
  assert.equal(repairProgressLimit({ source: "webhook" }), 1);
  assert.equal(repairProgressLimit({ source: "timer" }), 1);
});

type AssistantMessage = Extract<AgentSession["messages"][number], { role: "assistant" }>;

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", content: [], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.5",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 0, ...overrides,
  };
}

test("provider failures preserve the real error even when empty lifecycle responses are allowed", () => {
  const session = { messages: [assistant({ stopReason: "error", errorMessage: "Usage limit reached. Try again later." })] };
  assert.throws(() => readAgentSessionResponse(session, true), {
    message: "AI request failed (openai-codex/gpt-5.5): Usage limit reached. Try again later.",
  });
});

test("partial text cannot hide a final provider failure or cancellation", () => {
  const partial = assistant({ content: [{ type: "text", text: "Checking your library." }], stopReason: "toolUse" });
  for (const stopReason of ["error", "aborted"] as const) {
    assert.throws(() => readAgentSessionResponse({ messages: [partial, assistant({ stopReason })] }, true), /AI request failed/);
  }
});

test("model rejections are propagated as typed failures with original diagnostics", () => {
  const reason = "The model `gpt-5.5` does not exist or you do not have access to it.";
  assert.throws(
    () => readAgentSessionResponse({ messages: [assistant({ stopReason: "error", errorMessage: reason })] }, true),
    (error: unknown) => error instanceof ModelUnavailableError && error.message.endsWith(reason),
  );
  assert.throws(
    () => readAgentSessionResponse({ messages: [assistant({ stopReason: "error", errorMessage: "Usage limit reached" })] }, true),
    (error: unknown) => error instanceof Error && !(error instanceof ModelUnavailableError),
  );
});

test("a successful retry excludes text from failed attempts", () => {
  const response = readAgentSessionResponse({ messages: [
    assistant({ stopReason: "error", errorMessage: "Temporary failure", content: [{ type: "text", text: "Discard this partial answer." }] }),
    assistant({ content: [{ type: "text", text: "Library checked successfully." }] }),
  ] });
  assert.equal(response, "Library checked successfully.");
});

test("valid tool-only lifecycle responses remain allowed while other empty responses fail", () => {
  const session = { messages: [assistant({ stopReason: "toolUse", content: [{ type: "toolCall", id: "finish", name: "finish_repair", arguments: {} }] })] };
  assert.equal(readAgentSessionResponse(session, true), "");
  assert.throws(() => readAgentSessionResponse(session), /completed without a response/);
});

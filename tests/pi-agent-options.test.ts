import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { AiAuthenticationError, ModelUnavailableError } from "../src/agent/model-errors.js";
import { PiAgentService, applyOpenAiCodexServiceTier, buildAiModelHierarchy, readAgentSessionResponse, repairProgressLimit, resolveConfiguredModel, runWithModelFallback, type AgentRequestContext, type RepairCaseControlResult } from "../src/agent/pi-agent.js";

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

test("external wait tool carries release metadata through both event and timer routes", async () => {
  const store = { getString: () => undefined, getJson: (_key: string, fallback: unknown) => fallback };
  const service = new PiAgentService({} as never, store as never);
  for (const webhookProviders of [["sonarr"], []] as Array<Array<"sonarr" | "radarr">>) {
    let result: RepairCaseControlResult | undefined;
    const context: AgentRequestContext = {
      roles: [], userId: "user", channelId: "channel",
      caseControl: { webhookProviders, history: [], setResult: (value) => { result = value; } },
    };
    const tool = service["createOrchestrationTools"](context).find((item) => item.name === "wait_for_external_progress")!;
    const availableAt = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const params = { reason: "release", availableAt, provider: "sonarr", eventType: "Download", mediaIds: ["episode:42"], userUpdate: "Waiting for release", checkpoint: "Exact episode is monitored" };
    await tool.execute("wait-42", params as never);
    assert.ok(result?.type === "wait");
    assert.equal(result.externalWait?.availableAt, availableAt);
    assert.equal(result.externalWait?.reason, "release");
    assert.deepEqual(result.externalWait?.mediaIds, ["episode:42"]);
    assert.equal(result.externalWait?.eventType, "download");
    assert.equal(result.provider, webhookProviders.length ? "sonarr" : undefined);
    assert.equal(result.resumeAt, webhookProviders.length ? undefined : availableAt);
    result = undefined;
    await assert.rejects(tool.execute("bad-date", { ...params, availableAt: "2026-11-18" } as never), /ISO timestamp/);
    assert.equal(result, undefined);
  }
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

test("expired AI login overrides partial text and becomes an actionable typed failure", () => {
  const reason = "Your authentication token has expired. Please try refreshing it.";
  const partial = assistant({ content: [{ type: "text", text: "Checking your library." }], stopReason: "toolUse" });
  assert.throws(
    () => readAgentSessionResponse({ messages: [partial, assistant({ stopReason: "error", errorMessage: reason })] }, true),
    (error: unknown) => error instanceof AiAuthenticationError && error.message === `AI request failed (openai-codex/gpt-5.5): ${reason}`,
  );
  assert.throws(
    () => readAgentSessionResponse({ messages: [assistant({ stopReason: "aborted", errorMessage: reason })] }, true),
    (error: unknown) => error instanceof Error && !(error instanceof AiAuthenticationError),
  );
});

test("valid tool-only lifecycle responses remain allowed while other empty responses fail", () => {
  const session = { messages: [assistant({ stopReason: "toolUse", content: [{ type: "toolCall", id: "finish", name: "finish_repair", arguments: {} }] })] };
  assert.equal(readAgentSessionResponse(session, true), "");
  assert.throws(() => readAgentSessionResponse(session), /completed without a response/);
});

test("model fallback hierarchy deduplicates candidates and falls back in order", async () => {
  const candidates = buildAiModelHierarchy({
    modelProvider: "openai-codex",
    modelId: "gpt-6.1-sol",
    fallbacks: [
      { modelProvider: "openai-codex", modelId: "gpt-6.1-sol" },
      { modelProvider: "anthropic", modelId: "claude-fable-5" },
      { modelProvider: "local-ollama", modelId: "llama3.3" },
      { modelProvider: "anthropic", modelId: "claude-fable-5" },
    ],
  });
  assert.deepEqual(candidates, [
    { provider: "openai-codex", modelId: "gpt-6.1-sol" },
    { provider: "anthropic", modelId: "claude-fable-5" },
    { provider: "local-ollama", modelId: "llama3.3" },
  ]);

  const tried: string[] = [];
  const fallbacksLogged: string[] = [];
  const value = await runWithModelFallback({
    candidates,
    runAttempt: async (candidate) => {
      tried.push(`${candidate.provider}/${candidate.modelId}`);
      if (candidate.provider === "openai-codex") throw new AiAuthenticationError("OAuth token expired");
      if (candidate.provider === "anthropic") throw new Error("503 Service unavailable");
      return { value: "recovered via local ollama" };
    },
    onFallback: ({ failed, next }) => fallbacksLogged.push(`${failed.provider}->${next.provider}`),
  });
  assert.equal(value, "recovered via local ollama");
  assert.deepEqual(tried, ["openai-codex/gpt-6.1-sol", "anthropic/claude-fable-5", "local-ollama/llama3.3"]);
  assert.deepEqual(fallbacksLogged, ["openai-codex->anthropic", "anthropic->local-ollama"]);
});

test("model fallback does not replay after side effects or cancellation", async () => {
  const candidates = [
    { provider: "openai-codex", modelId: "gpt-6.1-sol" },
    { provider: "anthropic", modelId: "claude-fable-5" },
  ];

  const afterToolTried: string[] = [];
  await assert.rejects(
    runWithModelFallback({
      candidates,
      didExecuteSideEffects: () => true,
      runAttempt: async (candidate) => {
        afterToolTried.push(candidate.provider);
        throw new Error("503 Service unavailable");
      },
    }),
    /503 Service unavailable/,
  );
  assert.deepEqual(afterToolTried, ["openai-codex"]);

  const controller = new AbortController();
  const abortTried: string[] = [];
  await assert.rejects(
    runWithModelFallback({
      candidates,
      signal: controller.signal,
      runAttempt: async (candidate) => {
        abortTried.push(candidate.provider);
        controller.abort(new Error("User cancelled"));
        throw new Error("Request aborted");
      },
    }),
    /Request aborted/,
  );
  assert.deepEqual(abortTried, ["openai-codex"]);
});

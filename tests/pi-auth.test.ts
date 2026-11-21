import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CredentialSynchronizationError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiAuthService } from "../src/agent/pi-auth.js";
import type { AppConfig } from "../src/config.js";

test("stored OAuth credentials expose current Codex models and logout clears availability", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repairman-pi-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "auth.json"), JSON.stringify({
    "openai-codex": { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 86_400_000 },
  }));
  const service = new PiAuthService({ piAgentDir: root } as AppConfig);
  const snapshot = await service.refreshExpiredCredential();
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.credential?.expired, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-access|synthetic-refresh/);
  const models = await service.listAvailableModels();
  for (const id of ["gpt-6.1-sol", "gpt-6.1-terra"]) {
    assert.ok(models.some((model) => model.provider === "openai-codex" && model.id === id));
  }
  assert.equal((await service.logout()).configured, false);
  assert.equal((await service.listAvailableModels()).some((model) => model.provider === "openai-codex"), false);
});

test("device-code login maps SDK interactions and cancellation to the portal", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repairman-pi-login-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null });
  t.mock.method(ModelRuntime, "create", async () => runtime);
  let cancelled = false;
  t.mock.method(runtime, "login", async (_provider: string, _type: string, interaction: Parameters<ModelRuntime["login"]>[2]) => {
    assert.equal(await interaction.prompt({ type: "select", message: "Login", options: [{ id: "device_code", label: "Device code" }] }), "device_code");
    interaction.notify({ type: "device_code", userCode: "TEST-CODE", verificationUri: "https://example.test/verify", expiresInSeconds: 60 });
    await new Promise<void>((_resolve, reject) => interaction.signal?.addEventListener("abort", () => { cancelled = true; reject(new Error("Cancelled")); }, { once: true }));
  });
  const service = new PiAuthService({ piAgentDir: root } as AppConfig);
  const snapshot = await service.startLoginAndWaitForDeviceCode();
  assert.equal(snapshot.activeLogin?.deviceCode?.userCode, "TEST-CODE");
  assert.equal(snapshot.activeLogin?.status, "pending");
  assert.equal((await service.cancelLogin()).activeLogin, undefined);
  assert.equal(cancelled, true);
});

test("supports API key auth, Anthropic copy-code OAuth, and custom OpenAI-compatible endpoints", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repairman-multi-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = new PiAuthService({ piAgentDir: root } as AppConfig);

  const afterKey = await service.setApiKey("openai", "sk-synthetic-openai-key");
  assert.doesNotMatch(JSON.stringify(afterKey), /sk-synthetic-openai-key/);
  const openaiProvider = afterKey.providers.find((provider) => provider.id === "openai");
  assert.equal(openaiProvider?.configured, true);
  assert.equal(openaiProvider?.authType, "api_key");
  assert.ok((await service.listAvailableModels()).some((model) => model.provider === "openai"));

  const afterCustomNoKey = await service.saveCustomProvider({
    id: "local-ollama",
    name: "Local Ollama",
    baseUrl: "http://127.0.0.1:11434/v1/",
    api: "openai-completions",
    requiresApiKey: false,
    models: [{ id: "llama3.3", name: "Llama 3.3" }],
  });
  const ollama = afterCustomNoKey.providers.find((provider) => provider.id === "local-ollama");
  assert.equal(ollama?.configured, true);
  assert.equal(ollama?.kind, "custom");
  assert.equal(ollama?.authType, "none");
  assert.equal(ollama?.custom?.baseUrl, "http://127.0.0.1:11434/v1");
  assert.ok((await service.listAvailableModels()).some((model) => model.provider === "local-ollama" && model.id === "llama3.3"));

  const afterCustomWithKey = await service.saveCustomProvider({
    id: "litellm-proxy",
    name: "LiteLLM Proxy",
    baseUrl: "http://litellm.local:4000/v1",
    api: "openai-completions",
    requiresApiKey: true,
    apiKey: { action: "replace", value: "sk-litellm-secret" },
    models: [{ id: "gpt-4o" }],
  });
  assert.doesNotMatch(JSON.stringify(afterCustomWithKey), /sk-litellm-secret/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "models.json"), "utf8"), /sk-litellm-secret/);
  const litellm = afterCustomWithKey.providers.find((provider) => provider.id === "litellm-proxy");
  assert.equal(litellm?.configured, true);
  assert.equal(litellm?.custom?.apiKeyConfigured, true);

  await assert.rejects(
    service.saveCustomProvider({
      id: "openai",
      name: "Shadow OpenAI",
      baseUrl: "http://example.test/v1",
      api: "openai-completions",
      requiresApiKey: false,
      models: [{ id: "model-1" }],
    }),
    /conflicts with a built-in provider/,
  );

  const afterDelete = await service.deleteCustomProvider("local-ollama");
  assert.equal(afterDelete.providers.some((provider) => provider.id === "local-ollama"), false);
  const afterLogout = await service.logout("openai");
  assert.equal(afterLogout.providers.find((provider) => provider.id === "openai")?.configured, false);
});

test("Anthropic copy-code OAuth pauses for manual input and completes when submitted", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repairman-anthropic-oauth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null });
  t.mock.method(ModelRuntime, "create", async () => runtime);
  let receivedCode = "";
  t.mock.method(runtime, "login", async (providerId: string, type: string, interaction: Parameters<ModelRuntime["login"]>[2]) => {
    assert.equal(providerId, "anthropic");
    assert.equal(type, "oauth");
    const method = await interaction.prompt({
      type: "select",
      message: "Select Anthropic login method:",
      options: [
        { id: "browser", label: "Browser login" },
        { id: "copy_code", label: "Copy code login (headless)" },
      ],
    });
    assert.equal(method, "copy_code");
    interaction.notify({ type: "auth_url", url: "https://claude.ai/oauth/authorize?test=1", instructions: "Copy the code shown after sign-in." });
    receivedCode = await interaction.prompt({ type: "manual_code", message: "Paste the code:", placeholder: "code#state" });
  });

  const service = new PiAuthService({ piAgentDir: root } as AppConfig);
  const waiting = await service.startLoginAndWaitForDeviceCode("anthropic");
  assert.equal(waiting.activeLogin?.providerId, "anthropic");
  assert.equal(waiting.activeLogin?.authUrl?.url, "https://claude.ai/oauth/authorize?test=1");
  assert.equal(waiting.activeLogin?.inputPrompt?.type, "manual_code");

  const done = await service.submitLoginInput("abc#xyz", "anthropic");
  assert.equal(receivedCode, "abc#xyz");
  assert.equal(done.activeLogin, undefined);
});

test("recovers cleanly when OAuth login commits credentials but local sync throws CredentialSynchronizationError", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repairman-sync-err-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authPath = path.join(root, "auth.json");
  fs.writeFileSync(authPath, JSON.stringify({
    "openai-codex": { type: "oauth", access: "expired", refresh: "bad-refresh", expires: Date.now() - 60_000 },
  }));

  const runtime = await ModelRuntime.create({ authPath, modelsPath: null });
  let createCalls = 0;
  t.mock.method(ModelRuntime, "create", async () => {
    createCalls += 1;
    return runtime;
  });
  t.mock.method(runtime, "getAuth", async () => {
    throw new Error("invalid_refresh_token");
  });

  const service = new PiAuthService({ piAgentDir: root } as AppConfig);
  const failedRefresh = await service.refreshExpiredCredential();
  assert.match(failedRefresh.providers.find((p) => p.id === "openai-codex")?.refresh?.error ?? "", /invalid_refresh_token/);

  t.mock.method(runtime, "login", async () => {
    const fresh = { type: "oauth" as const, access: "fresh-access", refresh: "fresh-refresh", expires: Date.now() + 86_400_000 };
    fs.writeFileSync(authPath, JSON.stringify({ "openai-codex": fresh }));
    throw new CredentialSynchronizationError("openai-codex", "login", fresh);
  });

  const afterLogin = await service.startLoginAndWaitForDeviceCode("openai-codex");
  assert.equal(afterLogin.activeLogin, undefined);
  const codex = afterLogin.providers.find((p) => p.id === "openai-codex");
  assert.equal(codex?.configured, true);
  assert.equal(codex?.credential?.expired, false);
  assert.equal(codex?.refresh, undefined);
  assert.ok(createCalls >= 2);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
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

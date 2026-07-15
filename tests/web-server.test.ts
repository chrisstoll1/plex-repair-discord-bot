import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import type { PiAuthSnapshot } from "../src/agent/pi-auth.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/storage/db.js";
import { SecretBox } from "../src/storage/secrets.js";
import { SettingsStore } from "../src/storage/settings.js";
import { RepairCaseStore } from "../src/storage/repair-cases.js";
import { createWebServer } from "../src/web/server.js";

test("web API redacts secrets, validates atomically, and serves the SPA", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plex-repairman-web-"));
  const webRoot = path.join(root, "web");
  fs.mkdirSync(webRoot);
  fs.writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>Repairman</title><div id=\"root\"></div>");

  const config: AppConfig = {
    configDir: root,
    databasePath: path.join(root, "app.db"),
    secretsKeyPath: path.join(root, "secrets.key"),
    piAgentDir: path.join(root, "pi"),
    httpHost: "127.0.0.1",
    httpPort: 3000,
    logLevel: "silent",
  };
  const db = openDatabase(config);
  const settings = new SettingsStore(db, SecretBox.open(config.secretsKeyPath));
  const repairs = new RepairCaseStore(db);
  settings.setString("discord.token", "never-return-this", { secret: true });
  settings.setString("discord.applicationId", "before");

  let restartCount = 0;
  const discord = { restart: async () => { restartCount += 1; }, stopRepairCaseActivity: async () => undefined };
  const queue = {
    list: () => [],
    get: () => undefined,
    cancel: () => undefined,
  };
  const piSnapshot: PiAuthSnapshot = {
    authPath: path.join(config.piAgentDir, "auth.json"),
    configured: false,
    status: { configured: false },
  };
  const piAuth = {
    refreshExpiredCredential: async () => piSnapshot,
    startLoginAndWaitForDeviceCode: async () => piSnapshot,
    cancelLogin: () => piSnapshot,
    logout: () => piSnapshot,
  };
  const repairService = {
    receiveEvent: (event: Parameters<RepairCaseStore["receiveEvent"]>[0]) => repairs.receiveEvent(event),
    cancel: (id: string) => repairs.cancel(id, "test"),
    resume: (id: string) => repairs.resume(id, "test"),
    clearAll: async () => repairs.deleteAll(),
    refreshScheduling: () => undefined,
  };

  const app = await createWebServer(
    settings,
    queue as never,
    discord as never,
    piAuth as never,
    pino({ level: "silent" }),
    webRoot,
    repairs,
    repairService as never,
  );
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const read = await app.inject({ method: "GET", url: "/api/settings" });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json().settings.discord.token, { configured: true });
  assert.equal(read.json().settings.ai.serviceTier, "default");
  assert.doesNotMatch(read.body, /never-return-this/);

  const invalid = await app.inject({
    method: "PUT",
    url: "/api/settings",
    payload: settingsPayload({ sonarrUrl: "not-a-url" }),
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(settings.getString("discord.applicationId"), "before");
  assert.equal(restartCount, 0);

  const updated = await app.inject({
    method: "PUT",
    url: "/api/settings",
    payload: settingsPayload({ discordToken: { action: "clear" }, serviceTier: "priority" }),
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.json().settings.discord.token, { configured: false });
  assert.equal(updated.json().settings.ai.serviceTier, "priority");
  assert.equal(settings.getJson<{ serviceTier?: string }>("ai", {}).serviceTier, "priority");
  assert.equal(settings.getString("discord.token"), undefined);
  assert.equal(restartCount, 1);

  assert.equal((await app.inject({ method: "GET", url: "/api/memory/sessions" })).statusCode, 404);
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/tasks" })).json(), { tasks: [] });
  const repair = repairs.create({ guildId: "guild", threadId: "thread", source: "message", userId: "user", authorizationActor: "user", title: "Missing episode", objective: "Fix it" });
  repairs.addMessage(repair.id, { role: "user", content: "The episode is missing", sourceMessageId: "discord-user", metadata: { userId: "user" } });
  repairs.addActivity(repair.id, "progress", "I am checking it", "agent");
  repairs.addMessage(repair.id, { role: "assistant", content: "I am checking it", sourceMessageId: "discord-bot" });
  repairs.setWake(repair.id, { type: "arr_event", provider: "sonarr", eventType: "download", mediaId: "episode:42" });
  const webhookConfig = await app.inject({ method: "PUT", url: "/api/webhooks/config", payload: { publicBaseUrl: "https://repair.example.com", sonarrEnabled: true, radarrEnabled: false } });
  assert.equal(webhookConfig.statusCode, 200);
  const sonarrUrl = webhookConfig.json().sonarrUrl as string;
  const webhookPath = new URL(sonarrUrl).pathname;
  const webhook = await app.inject({ method: "POST", url: webhookPath, payload: { eventType: "Download", episodes: [{ id: 42 }], downloadId: "download-one" } });
  assert.equal(webhook.statusCode, 202);
  assert.equal(webhook.json().matched, 1);
  assert.equal(repairs.get(repair.id)?.status, "ready");
  const repairList = await app.inject({ method: "GET", url: "/api/repairs" });
  assert.equal(repairList.json().repairs[0].threadUrl, "https://discord.com/channels/guild/thread");
  const timeline = (await app.inject({ method: "GET", url: `/api/repairs/${repair.id}/timeline` })).json().timeline;
  assert.equal(timeline.some((entry: { type: string; source: string; actor?: string }) => entry.type === "user_message" && entry.source === "user" && entry.actor === "user"), true);
  assert.equal(timeline.filter((entry: { message?: string }) => entry.message === "I am checking it").length, 1);
  assert.equal(timeline.some((entry: { source: string; actor?: string }) => entry.source === "bot" && entry.actor === "agent"), true);
  const clearedRepairs = await app.inject({ method: "DELETE", url: "/api/repairs" });
  assert.equal(clearedRepairs.statusCode, 200);
  assert.equal(clearedRepairs.json().deleted, 1);
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/repairs" })).json(), { repairs: [] });
  assert.equal((await app.inject({ method: "GET", url: "/api/not-real" })).statusCode, 404);
  assert.match((await app.inject({ method: "GET", url: "/connections" })).body, /Repairman/);
});

function settingsPayload(overrides: { sonarrUrl?: string; discordToken?: { action: "keep" | "clear" }; serviceTier?: "default" | "priority" } = {}) {
  return {
    discord: {
      token: overrides.discordToken ?? { action: "keep" },
      applicationId: "after",
      allowedGuildIds: "",
      allowedChannelIds: "",
      repairRoleIds: "",
      allowDirectMessages: false,
      reactionsEnabled: true,
    },
    sonarr: { url: overrides.sonarrUrl ?? "", apiKey: { action: "keep" } },
    radarr: { url: "", apiKey: { action: "keep" } },
    plex: { url: "", token: { action: "keep" } },
    ai: { modelProvider: "openai-codex", modelId: "", thinkingLevel: "medium", serviceTier: overrides.serviceTier ?? "default" },
    timeouts: { standardSeconds: 60, releaseLookupSeconds: 300 },
    repair: { requireConfirmation: true, allowDestructive: false },
  };
}

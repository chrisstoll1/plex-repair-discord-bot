import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import type { PiAuthSnapshot } from "../src/agent/pi-auth.js";
import type { AppConfig } from "../src/config.js";
import { ConversationStore } from "../src/storage/conversation.js";
import { openDatabase } from "../src/storage/db.js";
import { SecretBox } from "../src/storage/secrets.js";
import { SettingsStore } from "../src/storage/settings.js";
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
  const conversations = new ConversationStore(db);
  settings.setString("discord.token", "never-return-this", { secret: true });
  settings.setString("discord.applicationId", "before");

  let restartCount = 0;
  const discord = { restart: async () => { restartCount += 1; } };
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

  const app = await createWebServer(
    settings,
    conversations,
    queue as never,
    discord as never,
    piAuth as never,
    pino({ level: "silent" }),
    webRoot,
  );
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const read = await app.inject({ method: "GET", url: "/api/settings" });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json().settings.discord.token, { configured: true });
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
    payload: settingsPayload({ discordToken: { action: "clear" } }),
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.json().settings.discord.token, { configured: false });
  assert.equal(settings.getString("discord.token"), undefined);
  assert.equal(restartCount, 1);

  assert.deepEqual((await app.inject({ method: "GET", url: "/api/memory/sessions" })).json(), { sessions: [] });
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/tasks" })).json(), { tasks: [] });
  assert.equal((await app.inject({ method: "GET", url: "/api/not-real" })).statusCode, 404);
  assert.match((await app.inject({ method: "GET", url: "/connections" })).body, /Repairman/);
});

function settingsPayload(overrides: { sonarrUrl?: string; discordToken?: { action: "keep" | "clear" } } = {}) {
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
    ai: { modelProvider: "openai-codex", modelId: "", thinkingLevel: "medium" },
    memory: { enabled: true, scope: "channel_user", maxMessages: 10, ttlHours: 24, includeBotReplies: true },
    timeouts: { standardSeconds: 60, releaseLookupSeconds: 300 },
    repair: { requireConfirmation: true, allowDestructive: false },
  };
}

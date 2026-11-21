import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import type { InjectOptions } from "fastify";
import { PortalAuthService } from "../src/web/portal-auth.js";
import type { PiAuthSnapshot } from "../src/agent/pi-auth.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/storage/db.js";
import { SecretBox } from "../src/storage/secrets.js";
import { SettingsStore } from "../src/storage/settings.js";
import { RepairCaseStore } from "../src/storage/repair-cases.js";
import { ToolAgentTaskStore } from "../src/storage/tool-agent-tasks.js";
import { ToolAgentQueueService } from "../src/agent/tool-agent-queue.js";
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
  settings.setString("seerr.apiKey", "never-return-seerr", { secret: true });
  settings.setString("discord.applicationId", "before");

  let restartCount = 0;
  const discord = { restart: async () => { restartCount += 1; }, stopRepairCaseActivity: async () => undefined };
  const taskStore = new ToolAgentTaskStore(db);
  const queue = new ToolAgentQueueService(taskStore, async () => { throw new Error("Web tests must not execute tasks"); });
  const piSnapshot: PiAuthSnapshot = {
    authPath: path.join(config.piAgentDir, "auth.json"),
    configured: false,
    status: { configured: false },
    providers: [],
  };
  const piAuth = {
    refreshExpiredCredential: async () => piSnapshot,
    listAvailableModels: () => [{ provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true, contextWindow: 372000 }],
    startLoginAndWaitForDeviceCode: async () => piSnapshot,
    submitLoginInput: async () => piSnapshot,
    cancelLogin: () => piSnapshot,
    logout: () => piSnapshot,
    setApiKey: async () => piSnapshot,
    saveCustomProvider: async () => piSnapshot,
    deleteCustomProvider: async () => piSnapshot,
    discoverCustomProviderModels: async () => [{ id: "llama3.3", name: "llama3.3" }],
  };
  const repairService = {
    receiveEvent: (event: Parameters<RepairCaseStore["receiveEvent"]>[0]) => repairs.receiveEvent(event),
    cancel: (id: string) => repairs.cancel(id, "test"),
    resume: (id: string) => repairs.resume(id, "test"),
    clearAll: async () => repairs.deleteAll(),
    refreshScheduling: () => undefined,
  };

  const portalAuth = new PortalAuthService(settings, root);
  const app = await createWebServer(
    settings,
    queue as never,
    discord as never,
    piAuth as never,
    portalAuth,
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

  const inject = (options: InjectOptions) => app.inject({ ...options, headers: { "x-repairman-request": "1", ...options.headers } });
  const read = await inject({ method: "GET", url: "/api/settings" });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json().settings.discord.token, { configured: true });
  assert.equal(read.json().settings.ai.serviceTier, "default");
  assert.doesNotMatch(read.body, /never-return-this/);
  assert.doesNotMatch(read.body, /never-return-seerr/);
  assert.equal(read.json().settings.seerr.preferForRequests, true);
  assert.equal(read.json().settings.repair.allowDirectAdd, false);

  const invalid = await inject({
    method: "PUT",
    url: "/api/settings",
    payload: settingsPayload({ sonarrUrl: "not-a-url" }),
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(settings.getString("discord.applicationId"), "before");
  assert.equal(restartCount, 0);

  const updated = await inject({
    method: "PUT",
    url: "/api/settings",
    payload: settingsPayload({ discordToken: { action: "clear" }, serviceTier: "priority" }),
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.json().settings.discord.token, { configured: false });
  assert.equal(updated.json().settings.ai.serviceTier, "priority");
  assert.deepEqual(updated.json().settings.ai.fallbacks, []);
  const withFallbacks = await inject({
    method: "PUT",
    url: "/api/settings",
    payload: {
      ...settingsPayload(),
      ai: {
        modelProvider: "openai-codex",
        modelId: "gpt-5.6-sol",
        fallbacks: [
          { modelProvider: "openai-codex", modelId: "gpt-5.6-sol" },
          { modelProvider: "anthropic", modelId: "claude-fable-5" },
          { modelProvider: "anthropic", modelId: "claude-fable-5" },
        ],
        thinkingLevel: "medium",
        serviceTier: "priority",
      },
    },
  });
  assert.equal(withFallbacks.statusCode, 200);
  assert.deepEqual(withFallbacks.json().settings.ai.fallbacks, [{ modelProvider: "anthropic", modelId: "claude-fable-5" }]);
  assert.equal((await inject({ method: "POST", url: "/api/pi-auth/api-key", payload: { providerId: "openai", apiKey: "sk-test" } })).statusCode, 200);
  assert.equal((await inject({ method: "POST", url: "/api/pi-auth/input", payload: { providerId: "anthropic", value: "code#state" } })).statusCode, 200);
  assert.equal((await inject({ method: "PUT", url: "/api/pi-auth/custom", payload: { id: "local-ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", requiresApiKey: false, models: [{ id: "llama3.3" }] } })).statusCode, 200);
  assert.equal((await inject({ method: "DELETE", url: "/api/pi-auth/custom/local-ollama" })).statusCode, 200);
  assert.equal((await inject({ method: "POST", url: "/api/pi-auth/custom/discover", payload: { baseUrl: "http://127.0.0.1:11434/v1" } })).statusCode, 200);
  assert.equal(settings.getJson<{ serviceTier?: string }>("ai", {}).serviceTier, "priority");
  assert.equal(settings.getString("discord.token"), undefined);
  assert.equal(restartCount, 2);
  assert.equal(settings.getString("seerr.apiKey"), "never-return-seerr", "legacy settings saves keep Seerr credentials");
  const withSeerr = { ...settingsPayload(), seerr: { url: "http://seerr:5055", apiKey: { action: "replace", value: "new-seerr-secret" }, preferForRequests: true, userMappings: "107286271453356032:1", defaultUserId: 1 }, repair: { requireConfirmation: true, allowDestructive: false, allowDirectAdd: true } };
  const connected = await inject({ method: "PUT", url: "/api/settings", payload: withSeerr });
  assert.equal(connected.statusCode, 200);
  assert.doesNotMatch(connected.body, /new-seerr-secret/);
  assert.equal(connected.json().settings.seerr.apiKey.configured, true);
  assert.equal(connected.json().settings.seerr.defaultUserId, 1);
  assert.equal(connected.json().settings.repair.allowDirectAdd, true);
  assert.equal(settings.getString("seerr.apiKey"), "new-seerr-secret");
  assert.equal((db.prepare("SELECT secret FROM app_settings WHERE key = 'seerr.apiKey'").get() as { secret: number }).secret, 1);
  const invalidMapping = await inject({ method: "PUT", url: "/api/settings", payload: { ...withSeerr, seerr: { ...withSeerr.seerr, userMappings: "name:1" } } });
  assert.equal(invalidMapping.statusCode, 400);
  assert.equal(settings.getString("seerr.userMappings"), "107286271453356032:1");
  const cleared = await inject({ method: "PUT", url: "/api/settings", payload: { ...withSeerr, seerr: { ...withSeerr.seerr, apiKey: { action: "clear" } } } });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().settings.seerr.apiKey.configured, false);

  assert.equal((await inject({ method: "GET", url: "/api/memory/sessions" })).statusCode, 404);
  assert.deepEqual((await inject({ method: "GET", url: "/api/tasks" })).json(), { tasks: [] });
  assert.deepEqual((await inject({ method: "GET", url: "/api/pi-models" })).json(), {
    models: [{ provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true, contextWindow: 372000 }],
  });
  const repair = repairs.create({ guildId: "guild", threadId: "thread", source: "message", userId: "user", authorizationActor: "user", title: "Missing episode", objective: "Fix it" });
  repairs.addMessage(repair.id, { role: "user", content: "The episode is missing", sourceMessageId: "discord-user", metadata: { userId: "user" } });
  repairs.addActivity(repair.id, "progress", "I am checking it", "agent");
  repairs.addMessage(repair.id, { role: "assistant", content: "I am checking it", sourceMessageId: "discord-bot" });
  repairs.setWake(repair.id, { type: "arr_event", provider: "sonarr", eventType: "download", mediaId: "episode:42" });
  const webhookConfig = await inject({ method: "PUT", url: "/api/webhooks/config", payload: { publicBaseUrl: "https://repair.example.com", sonarrEnabled: true, radarrEnabled: false } });
  assert.equal(webhookConfig.statusCode, 200);
  const sonarrUrl = webhookConfig.json().sonarrUrl as string;
  const webhookPath = new URL(sonarrUrl).pathname;
  const webhook = await inject({ method: "POST", url: webhookPath, payload: { eventType: "Download", episodes: [{ id: 42 }], downloadId: "download-one" } });
  assert.equal(webhook.statusCode, 202);
  assert.equal(webhook.json().matched, 1);
  assert.equal(repairs.get(repair.id)?.status, "ready");
  const repairList = await inject({ method: "GET", url: "/api/repairs" });
  assert.equal(repairList.json().repairs[0].threadUrl, "https://discord.com/channels/guild/thread");
  const timeline = (await inject({ method: "GET", url: `/api/repairs/${repair.id}/timeline` })).json().timeline;
  assert.equal(timeline.some((entry: { type: string; source: string; actor?: string }) => entry.type === "user_message" && entry.source === "user" && entry.actor === "user"), true);
  assert.equal(timeline.filter((entry: { message?: string }) => entry.message === "I am checking it").length, 1);
  assert.equal(timeline.some((entry: { source: string; actor?: string }) => entry.source === "bot" && entry.actor === "agent"), true);
  const clearedRepairs = await inject({ method: "DELETE", url: "/api/repairs" });
  assert.equal(clearedRepairs.statusCode, 200);
  assert.equal(clearedRepairs.json().deleted, 1);
  assert.deepEqual((await inject({ method: "GET", url: "/api/repairs" })).json(), { repairs: [] });
  await t.test("pagination reaches older history, keeps global counts, and recovers after deletion", async () => {
    for (let index = 0; index < 73; index += 1) {
      const id = `task-${String(index).padStart(3, "0")}`;
      taskStore.create({ id, channelId: "channel", userId: "user", title: id, toolProfile: "read", prompt: "Synthetic task" });
      if (index > 0) { taskStore.markRunning(id); taskStore.markSucceeded(id, "done"); }
    }
    db.prepare("UPDATE tool_agent_tasks SET created_at = '2026-01-01' WHERE id != 'task-000'").run();
    db.prepare("UPDATE tool_agent_tasks SET created_at = '2025-01-01' WHERE id = 'task-000'").run();
    const seenTasks = new Set<string>();
    for (const offset of [0, 25, 50]) {
      const response = await inject({ method: "GET", url: `/api/tasks?limit=25&offset=${offset}` });
      assert.equal(response.statusCode, 200);
      const page = response.json();
      assert.deepEqual(page.pagination, { total: 73, offset, limit: 25 });
      assert.equal(page.counts.queued, 1, "active counts include tasks outside the current page");
      for (const task of page.tasks) { assert(!seenTasks.has(task.id)); seenTasks.add(task.id); }
    }
    assert.equal(seenTasks.size, 73);
    assert(seenTasks.has("task-000"));
    assert.deepEqual((await inject({ method: "GET", url: "/api/tasks?limit=25&offset=999" })).json().pagination, { total: 73, offset: 50, limit: 25 });
    assert.equal((await inject({ method: "DELETE", url: "/api/tasks/history" })).json().deleted, 72);
    const afterClear = (await inject({ method: "GET", url: "/api/tasks?limit=25&offset=50" })).json();
    assert.deepEqual(afterClear.pagination, { total: 1, offset: 0, limit: 25 });
    assert.equal(afterClear.tasks[0].id, "task-000");

    const statuses = ["ready", "waiting", "blocked", "resolved"] as const;
    for (let index = 0; index < 506; index += 1) {
      const id = `paged-${String(index).padStart(3, "0")}`;
      repairs.create({ id, guildId: "guild", threadId: id, source: "message", userId: "user", authorizationActor: "user", title: id, objective: "Synthetic repair", status: statuses[index % statuses.length] });
    }
    db.prepare("UPDATE repair_cases SET updated_at = '2026-01-01'").run();
    const seenRepairs = new Set<string>();
    for (let offset = 0; offset < 506; offset += 100) {
      const page = (await inject({ method: "GET", url: `/api/repairs?limit=100&offset=${offset}` })).json();
      assert.equal(page.pagination.total, 506);
      assert.equal(page.counts.ready, 127);
      for (const repair of page.repairs) { assert(!seenRepairs.has(repair.id)); seenRepairs.add(repair.id); }
    }
    assert.equal(seenRepairs.size, 506, "repairs beyond the former 500-row cap are reachable");
    const completed = (await inject({ method: "GET", url: "/api/repairs?group=completed&limit=10&offset=10" })).json();
    assert.equal(completed.pagination.total, 126);
    assert.equal(completed.counts.ready, 127, "filter counts stay global");
    assert.equal(completed.repairs.length, 10);
    assert(completed.repairs.every((repair: { status: string }) => repair.status === "resolved"));

    for (let index = 0; index < 50; index += 1) repairs.addMessage("paged-000", { role: "user", content: `Timeline ${index}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)) });
    repairs.addActivity("paged-000", "progress", "Deduplicated bot update");
    repairs.addMessage("paged-000", { role: "assistant", content: "Deduplicated bot update" });
    const seenTimeline = new Set<string>();
    for (const offset of [0, 20, 40]) {
      const page = (await inject({ method: "GET", url: `/api/repairs/paged-000/timeline?limit=20&offset=${offset}` })).json();
      assert.equal(page.pagination.total, 52, "duplicate bot updates are merged before pagination");
      for (const entry of page.timeline) { assert(!seenTimeline.has(entry.id)); seenTimeline.add(entry.id); }
      assert.deepEqual(page.timeline.map((entry: { createdAt: string }) => entry.createdAt), page.timeline.map((entry: { createdAt: string }) => entry.createdAt).sort().reverse());
    }
    assert.equal(seenTimeline.size, 52);
    for (const url of ["/api/tasks?offset=-1", "/api/tasks?offset=1.5", "/api/tasks?limit=201&offset=0", "/api/repairs?group=invalid&offset=0", "/api/repairs/paged-000/timeline?offset=-1"]) {
      assert.equal((await inject({ method: "GET", url })).statusCode, 400, url);
    }
    await inject({ method: "DELETE", url: "/api/repairs" });
    const empty = (await inject({ method: "GET", url: "/api/repairs?limit=10&offset=500" })).json();
    assert.deepEqual(empty.pagination, { total: 0, offset: 0, limit: 10 });
    assert.deepEqual(empty.repairs, []);
  });
  assert.equal((await inject({ method: "GET", url: "/api/not-real" })).statusCode, 404);
  assert.match((await inject({ method: "GET", url: "/connections" })).body, /Repairman/);
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
    ai: { modelProvider: "openai-codex", modelId: "gpt-5.6-sol", thinkingLevel: "medium", serviceTier: overrides.serviceTier ?? "default" },
    timeouts: { standardSeconds: 60, releaseLookupSeconds: 300 },
    repair: { requireConfirmation: true, allowDestructive: false },
  };
}

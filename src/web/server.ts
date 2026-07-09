import Fastify from "fastify";
import fs from "node:fs/promises";
import type { Logger } from "pino";
import { aiSettingsSchema, memorySettingsSchema, readRuntimeSettings, repairSettingsSchema, timeoutSettingsSchema } from "../domain/settings.js";
import { createMediaClients } from "../services/service-factory.js";
import type { SettingsStore } from "../storage/settings.js";
import type { ConversationStore } from "../storage/conversation.js";
import type { ToolAgentQueueService } from "../agent/tool-agent-queue.js";
import type { DiscordBotService } from "../discord/bot.js";
import type { PiAuthService } from "../agent/pi-auth.js";
import { escapeHtml, layout, memorySessionsTable, piAuthPanel, type ServiceStatus, settingsPage, statusTable, toolAgentTasksTable } from "./templates.js";

export async function createWebServer(
  store: SettingsStore,
  conversations: ConversationStore,
  toolAgentQueue: ToolAgentQueueService,
  discord: DiscordBotService,
  piAuth: PiAuthService,
  logger: Logger,
) {
  const app = Fastify({ loggerInstance: logger });

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.get("/repairman.png", async (_request, reply) => {
    reply.type("image/png").send(await fs.readFile(new URL("./assets/repairman.png", import.meta.url)));
  });

  app.get("/favicon.png", async (_request, reply) => {
    reply.type("image/png").send(await fs.readFile(new URL("./assets/repairman.png", import.meta.url)));
  });

  app.get("/favicon.ico", async (_request, reply) => {
    reply.type("image/png").send(await fs.readFile(new URL("./assets/repairman.png", import.meta.url)));
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/", async (_request, reply) => {
    const settings = readRuntimeSettings(store);
    const piAuthSnapshot = await piAuth.refreshExpiredCredential();
    const sessions = conversations.listSessions(settings.memory.ttlHours);
    const statuses = await collectStatuses(store, logger, settings, piAuthSnapshot.configured, sessions.length);
    const toolAgentTasks = toolAgentQueue.list({ limit: 50 });

    reply.type("text/html").send(settingsPage({ settings, piAuth: piAuthSnapshot, statuses, sessions, toolAgentTasks }));
  });

  app.get("/settings", async (_request, reply) => {
    reply.redirect("/");
  });

  app.post("/settings", async (request, reply) => {
    const body = request.body as Record<string, string | undefined>;

    setIfPresent(store, "discord.token", body.discordToken, true);
    setIfPresent(store, "discord.applicationId", body.discordApplicationId, false, true);
    setIfPresent(store, "discord.allowedGuildIds", body.discordAllowedGuildIds, false, true);
    setIfPresent(store, "discord.allowedChannelIds", body.discordAllowedChannelIds, false, true);
    setIfPresent(store, "discord.repairRoleIds", body.discordRepairRoleIds, false, true);
    store.setString("discord.allowDirectMessages", String(body.discordAllowDirectMessages === "true"));
    store.setString("discord.reactionsEnabled", String(body.discordReactionsEnabled === "true"));

    setIfPresent(store, "sonarr.url", body.sonarrUrl, false, true);
    setIfPresent(store, "sonarr.apiKey", body.sonarrApiKey, true);
    setIfPresent(store, "radarr.url", body.radarrUrl, false, true);
    setIfPresent(store, "radarr.apiKey", body.radarrApiKey, true);
    setIfPresent(store, "plex.url", body.plexUrl, false, true);
    setIfPresent(store, "plex.token", body.plexToken, true);

    const ai = aiSettingsSchema.parse({
      modelProvider: body.aiModelProvider,
      modelId: body.aiModelId,
      thinkingLevel: body.aiThinkingLevel,
    });
    store.setJson("ai", ai);
    store.setJson(
      "memory",
      memorySettingsSchema.parse({
        enabled: body.memoryEnabled === "true",
        scope: body.memoryScope,
        maxMessages: body.memoryMaxMessages,
        ttlHours: body.memoryTtlHours,
        includeBotReplies: body.memoryIncludeBotReplies === "true",
      }),
    );
    store.setJson(
      "timeouts",
      timeoutSettingsSchema.parse({
        standardSeconds: body.timeoutStandardSeconds,
        releaseLookupSeconds: body.timeoutReleaseLookupSeconds,
      }),
    );
    store.setJson(
      "repair",
      repairSettingsSchema.parse({
        requireConfirmation: body.repairRequireConfirmation === "true",
        allowDestructive: body.repairAllowDestructive === "true",
      }),
    );

    await discord.restart();
    reply.redirect("/");
  });

  app.post("/memory/delete", async (request, reply) => {
    const body = request.body as Record<string, string | undefined>;
    if (body.conversationKey) {
      conversations.deleteSession(body.conversationKey);
    }

    reply.redirect("/#memory");
  });

  app.post("/memory/sessions", async (_request, reply) => {
    const settings = readRuntimeSettings(store);
    reply.type("text/html").send(memorySessionsTable(conversations.listSessions(settings.memory.ttlHours)));
  });

  app.post("/tool-agent-tasks", async (_request, reply) => {
    reply.type("text/html").send(toolAgentTasksTable(toolAgentQueue.list({ limit: 50 })));
  });

  app.post("/tool-agent-tasks/cancel", async (request, reply) => {
    const body = request.body as Record<string, string | undefined>;
    if (body.taskId) toolAgentQueue.cancel(body.taskId);
    reply.redirect("/#tool-agent-tasks");
  });

  app.post("/status/table", async (_request, reply) => {
    reply.type("text/html").send(await renderStatusTable(store, conversations, piAuth, logger));
  });

  app.get("/pi-auth", async (_request, reply) => {
    reply.redirect("/#auth-services");
  });

  app.post("/pi-auth/start", async (request, reply) => {
    const snapshot = await piAuth.startLoginAndWaitForDeviceCode();
    if (wantsPartial(request.headers)) {
      reply.type("text/html").send(piAuthPanel(snapshot));
      return;
    }

    reply.redirect("/#auth-services");
  });

  app.post("/pi-auth/cancel", async (request, reply) => {
    const snapshot = piAuth.cancelLogin();
    if (wantsPartial(request.headers)) {
      reply.type("text/html").send(piAuthPanel(snapshot));
      return;
    }

    reply.redirect("/#auth-services");
  });

  app.post("/pi-auth/logout", async (request, reply) => {
    const snapshot = piAuth.logout();
    if (wantsPartial(request.headers)) {
      reply.type("text/html").send(piAuthPanel(snapshot));
      return;
    }

    reply.redirect("/#auth-services");
  });

  app.post("/pi-auth/status", async (_request, reply) => {
    reply.type("text/html").send(piAuthPanel(await piAuth.refreshExpiredCredential()));
  });

  app.get("/health/services", async (_request, reply) => {
    const clients = createMediaClients(store, logger);
    const results: Record<string, unknown> = {};

    for (const [name, check] of Object.entries({
      sonarr: () => clients.sonarr.getSystemStatus(),
      radarr: () => clients.radarr.getSystemStatus(),
      plex: () => clients.plex.getIdentity(),
    })) {
      try {
        results[name] = await check();
      } catch (error) {
        results[name] = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    results.pi = await piAuth.refreshExpiredCredential();

    reply.type("text/html").send(layout("Health", `<section class="panel"><pre>${escapeHtml(JSON.stringify(results, null, 2))}</pre></section>`));
  });

  return app;
}

async function renderStatusTable(store: SettingsStore, conversations: ConversationStore, piAuth: PiAuthService, logger: Logger): Promise<string> {
  const settings = readRuntimeSettings(store);
  const piAuthSnapshot = await piAuth.refreshExpiredCredential();
  const sessions = conversations.listSessions(settings.memory.ttlHours);
  return statusTable(await collectStatuses(store, logger, settings, piAuthSnapshot.configured, sessions.length));
}

async function collectStatuses(
  store: SettingsStore,
  logger: Logger,
  settings = readRuntimeSettings(store),
  piAuthConfigured = false,
  activeMemorySessions = 0,
): Promise<ServiceStatus[]> {
  const clients = createMediaClients(store, logger);
  const statuses: ServiceStatus[] = [
    {
      name: "Discord",
      state: settings.discord.token ? "configured" : "missing",
      target: settings.discord.applicationId || "Application ID not set",
      detail: settings.discord.token ? "Bot token is configured." : "Bot token is missing.",
    },
    {
      name: "Pi Auth",
      state: piAuthConfigured ? "configured" : "missing",
      target: "OpenAI Codex",
      detail: piAuthConfigured ? "Codex auth is configured." : "Start login to connect Codex auth.",
    },
  ];

  statuses.push(await checkService("Sonarr", settings.sonarr.url, Boolean(settings.sonarr.url && settings.sonarr.apiKey), () => clients.sonarr.getSystemStatus()));
  statuses.push(await checkService("Radarr", settings.radarr.url, Boolean(settings.radarr.url && settings.radarr.apiKey), () => clients.radarr.getSystemStatus()));
  statuses.push(await checkService("Plex", settings.plex.url, Boolean(settings.plex.url && settings.plex.token), () => clients.plex.getIdentity()));
  statuses.push({
    name: "Memory",
    state: settings.memory.enabled ? "configured" : "missing",
    target: settings.memory.scope === "channel_user" ? "Channel/thread + user" : "Shared channel/thread",
    detail: settings.memory.enabled
      ? `${activeMemorySessions} active session${activeMemorySessions === 1 ? "" : "s"}; ${settings.memory.maxMessages} messages for ${settings.memory.ttlHours} hours.`
      : "Conversation memory is disabled.",
  });

  return statuses;
}

async function checkService(name: string, target: string | undefined, configured: boolean, check: () => Promise<unknown>): Promise<ServiceStatus> {
  if (!configured) {
    return {
      name,
      state: "missing",
      target: target || "Not configured",
      detail: "URL and credential are required.",
    };
  }

  try {
    const result = await check();
    return {
      name,
      state: "connected",
      target: target || "Configured",
      detail: summarizeHealth(result),
    };
  } catch (error) {
    return {
      name,
      state: "error",
      target: target || "Configured",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeHealth(value: unknown): string {
  if (!value || typeof value !== "object") return "Connected.";
  const record = value as Record<string, unknown>;
  const name = firstString(record.friendlyName, record.instanceName, record.appName);
  const version = firstString(record.version);
  return [name, version ? `version ${version}` : undefined].filter(Boolean).join(", ") || "Connected.";
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function setIfPresent(store: SettingsStore, key: string, value: string | undefined, secret: boolean, allowEmpty = false): void {
  if (value === undefined) return;
  if (!allowEmpty && value.trim() === "") return;
  store.setString(key, value.trim(), { secret });
}

function wantsPartial(headers: Record<string, string | string[] | undefined>): boolean {
  return headers["x-requested-with"] === "fetch";
}

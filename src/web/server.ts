import Fastify, { type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  aiSettingsSchema,
  memorySettingsSchema,
  readRuntimeSettings,
  repairSettingsSchema,
  timeoutSettingsSchema,
  type RuntimeSettings,
} from "../domain/settings.js";
import { createMediaClients } from "../services/service-factory.js";
import type { SettingsStore, SettingsWriter } from "../storage/settings.js";
import type { ConversationStore } from "../storage/conversation.js";
import type { ToolAgentQueueService } from "../agent/tool-agent-queue.js";
import type { ToolAgentTask } from "../storage/tool-agent-tasks.js";
import type { DiscordBotService } from "../discord/bot.js";
import type { PiAuthService, PiAuthSnapshot } from "../agent/pi-auth.js";

const nonEmptyTrimmedString = z.string().trim().min(1);
const optionalUrl = z.union([z.literal(""), z.string().trim().url()]);
const secretUpdateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep") }).strict(),
  z.object({ action: z.literal("clear") }).strict(),
  z.object({ action: z.literal("replace"), value: nonEmptyTrimmedString }).strict(),
]);

const settingsUpdateSchema = z
  .object({
    discord: z
      .object({
        token: secretUpdateSchema,
        applicationId: z.string().trim(),
        allowedGuildIds: z.string().trim(),
        allowedChannelIds: z.string().trim(),
        repairRoleIds: z.string().trim(),
        allowDirectMessages: z.boolean(),
        reactionsEnabled: z.boolean(),
      })
      .strict(),
    sonarr: z.object({ url: optionalUrl, apiKey: secretUpdateSchema }).strict(),
    radarr: z.object({ url: optionalUrl, apiKey: secretUpdateSchema }).strict(),
    plex: z.object({ url: optionalUrl, token: secretUpdateSchema }).strict(),
    ai: z
      .object({
        modelProvider: nonEmptyTrimmedString,
        modelId: z.string().trim(),
        thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
      })
      .strict(),
    memory: z
      .object({
        enabled: z.boolean(),
        scope: z.enum(["channel_user", "channel"]),
        maxMessages: z.number().int().min(0).max(50),
        ttlHours: z.number().int().min(1).max(720),
        includeBotReplies: z.boolean(),
      })
      .strict(),
    timeouts: z
      .object({
        standardSeconds: z.number().int().min(5).max(600),
        releaseLookupSeconds: z.number().int().min(15).max(900),
      })
      .strict(),
    repair: z.object({ requireConfirmation: z.boolean(), allowDestructive: z.boolean() }).strict(),
  })
  .strict();

const deleteSessionSchema = z.object({ conversationKey: nonEmptyTrimmedString }).strict();
const taskParamsSchema = z.object({ id: nonEmptyTrimmedString }).strict();
const taskQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();

type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;
type SecretUpdate = z.infer<typeof secretUpdateSchema>;
type ServiceStatus = {
  name: string;
  state: "connected" | "configured" | "missing" | "error";
  target: string;
  detail: string;
};

export async function createWebServer(
  store: SettingsStore,
  conversations: ConversationStore,
  toolAgentQueue: ToolAgentQueueService,
  discord: DiscordBotService,
  piAuth: PiAuthService,
  logger: Logger,
  webRoot = path.resolve(process.cwd(), "dist/web/public"),
) {
  const app = Fastify({ loggerInstance: logger });

  app.setErrorHandler((error, _request, reply) => {
    const errorRecord = typeof error === "object" && error !== null ? (error as { statusCode?: number; message?: string }) : {};
    const statusCode = errorRecord.statusCode && errorRecord.statusCode >= 400 && errorRecord.statusCode < 500 ? errorRecord.statusCode : 500;
    if (statusCode === 500) logger.error({ err: error }, "Unhandled web API error");
    reply.status(statusCode).send({
      error: {
        code: statusCode === 500 ? "internal_error" : "bad_request",
        message: statusCode === 500 ? "An internal error occurred." : (errorRecord.message ?? "Bad request."),
      },
    });
  });

  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: "/",
    wildcard: false,
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/settings", async () => ({ settings: publicSettings(readRuntimeSettings(store)) }));

  app.put("/api/settings", async (request, reply) => {
    const update = parseOrReply(settingsUpdateSchema, request.body, reply);
    if (!update) return;

    // Parsing and cross-field normalization are complete before the transaction starts.
    const normalized = normalizeSettings(update);
    store.transaction((writer) => writeSettings(writer, normalized));
    await discord.restart();
    return { settings: publicSettings(readRuntimeSettings(store)) };
  });

  app.get("/api/status", async () => {
    const settings = readRuntimeSettings(store);
    const activeMemorySessions = conversations.listSessions(settings.memory.ttlHours).length;
    const clients = createMediaClients(store, logger);
    const [piSnapshot, sonarr, radarr, plex] = await Promise.all([
      piAuth.refreshExpiredCredential(),
      checkService("Sonarr", settings.sonarr.url, Boolean(settings.sonarr.url && settings.sonarr.apiKey), () => clients.sonarr.getSystemStatus()),
      checkService("Radarr", settings.radarr.url, Boolean(settings.radarr.url && settings.radarr.apiKey), () => clients.radarr.getSystemStatus()),
      checkService("Plex", settings.plex.url, Boolean(settings.plex.url && settings.plex.token), () => clients.plex.getIdentity()),
    ]);

    return {
      checkedAt: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      services: [
        discordStatus(settings),
        piAuthStatus(piSnapshot.configured),
        sonarr,
        radarr,
        plex,
        memoryStatus(settings, activeMemorySessions),
      ],
    };
  });

  app.get("/api/memory/sessions", async () => {
    const settings = readRuntimeSettings(store);
    return { sessions: conversations.listSessions(settings.memory.ttlHours) };
  });

  app.delete("/api/memory/sessions", async (request, reply) => {
    const body = parseOrReply(deleteSessionSchema, request.body, reply);
    if (!body) return;
    if (!conversations.deleteSession(body.conversationKey)) {
      return sendError(reply, 404, "session_not_found", "Conversation session was not found.");
    }
    return { deleted: true, conversationKey: body.conversationKey };
  });

  app.get("/api/tasks", async (request, reply) => {
    const query = parseOrReply(taskQuerySchema, request.query, reply);
    if (!query) return;
    return { tasks: toolAgentQueue.list({ limit: query.limit }) };
  });

  app.post("/api/tasks/:id/cancel", async (request, reply) => {
    const params = parseOrReply(taskParamsSchema, request.params, reply);
    if (!params) return;
    const existing = toolAgentQueue.get(params.id);
    if (!existing) return sendError(reply, 404, "task_not_found", "Task was not found.");
    if (isTerminal(existing)) return sendError(reply, 409, "task_not_cancellable", `Task is already ${existing.status}.`);
    const task = toolAgentQueue.cancel(params.id);
    if (!task) return sendError(reply, 404, "task_not_found", "Task was not found.");
    if (task.status !== "cancelled") return sendError(reply, 409, "task_not_cancellable", `Task is already ${task.status}.`);
    return { task };
  });

  app.get("/api/pi-auth", async () => ({ piAuth: publicPiAuth(await piAuth.refreshExpiredCredential()) }));
  app.post("/api/pi-auth/start", async () => ({ piAuth: publicPiAuth(await piAuth.startLoginAndWaitForDeviceCode()) }));
  app.post("/api/pi-auth/cancel", async () => ({ piAuth: publicPiAuth(piAuth.cancelLogin()) }));
  app.post("/api/pi-auth/logout", async () => ({ piAuth: publicPiAuth(piAuth.logout()) }));

  app.get("/*", async (request, reply) => {
    if (request.url === "/api" || request.url.startsWith("/api/") || request.url.startsWith("/health/")) {
      return sendError(reply, 404, "route_not_found", "Route was not found.");
    }
    return reply.sendFile("index.html");
  });

  return app;
}

function parseOrReply<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  reply.status(400).send({
    error: {
      code: "validation_error",
      message: "Request validation failed.",
      details: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    },
  });
  return undefined;
}

function sendError(reply: FastifyReply, statusCode: number, code: string, message: string): FastifyReply {
  return reply.status(statusCode).send({ error: { code, message } });
}

function normalizeSettings(update: SettingsUpdate): SettingsUpdate {
  return {
    ...update,
    ai: aiSettingsSchema.pick({ modelProvider: true, modelId: true, thinkingLevel: true }).parse(update.ai),
    memory: memorySettingsSchema.parse(update.memory),
    timeouts: timeoutSettingsSchema.parse(update.timeouts),
    repair: repairSettingsSchema.parse(update.repair),
  };
}

function writeSettings(writer: SettingsWriter, update: SettingsUpdate): void {
  applySecret(writer, "discord.token", update.discord.token);
  writer.setString("discord.applicationId", update.discord.applicationId);
  writer.setString("discord.allowedGuildIds", update.discord.allowedGuildIds);
  writer.setString("discord.allowedChannelIds", update.discord.allowedChannelIds);
  writer.setString("discord.repairRoleIds", update.discord.repairRoleIds);
  writer.setString("discord.allowDirectMessages", String(update.discord.allowDirectMessages));
  writer.setString("discord.reactionsEnabled", String(update.discord.reactionsEnabled));

  writer.setString("sonarr.url", update.sonarr.url);
  applySecret(writer, "sonarr.apiKey", update.sonarr.apiKey);
  writer.setString("radarr.url", update.radarr.url);
  applySecret(writer, "radarr.apiKey", update.radarr.apiKey);
  writer.setString("plex.url", update.plex.url);
  applySecret(writer, "plex.token", update.plex.token);

  writer.setJson("ai", update.ai);
  writer.setJson("memory", update.memory);
  writer.setJson("timeouts", update.timeouts);
  writer.setJson("repair", update.repair);
}

function applySecret(writer: SettingsWriter, key: string, update: SecretUpdate): void {
  if (update.action === "replace") writer.setString(key, update.value, { secret: true });
  if (update.action === "clear") writer.delete(key);
}

function publicSettings(settings: RuntimeSettings) {
  return {
    discord: {
      token: { configured: Boolean(settings.discord.token) },
      applicationId: settings.discord.applicationId,
      allowedGuildIds: settings.discord.allowedGuildIds,
      allowedChannelIds: settings.discord.allowedChannelIds,
      repairRoleIds: settings.discord.repairRoleIds,
      allowDirectMessages: settings.discord.allowDirectMessages,
      reactionsEnabled: settings.discord.reactionsEnabled,
    },
    sonarr: { url: settings.sonarr.url, apiKey: { configured: Boolean(settings.sonarr.apiKey) } },
    radarr: { url: settings.radarr.url, apiKey: { configured: Boolean(settings.radarr.apiKey) } },
    plex: { url: settings.plex.url, token: { configured: Boolean(settings.plex.token) } },
    ai: {
      modelProvider: settings.ai.modelProvider,
      modelId: settings.ai.modelId,
      thinkingLevel: settings.ai.thinkingLevel,
    },
    memory: settings.memory,
    timeouts: settings.timeouts,
    repair: settings.repair,
  };
}

function publicPiAuth(snapshot: PiAuthSnapshot): Omit<PiAuthSnapshot, "authPath"> {
  const { authPath: _authPath, ...publicSnapshot } = snapshot;
  return publicSnapshot;
}

function discordStatus(settings: RuntimeSettings): ServiceStatus {
  return {
    name: "Discord",
    state: settings.discord.token ? "configured" : "missing",
    target: settings.discord.applicationId || "Application ID not set",
    detail: settings.discord.token ? "Bot token is configured." : "Bot token is missing.",
  };
}

function piAuthStatus(configured: boolean): ServiceStatus {
  return {
    name: "Pi Auth",
    state: configured ? "configured" : "missing",
    target: "OpenAI Codex",
    detail: configured ? "Codex auth is configured." : "Start login to connect Codex auth.",
  };
}

function memoryStatus(settings: RuntimeSettings, activeSessions: number): ServiceStatus {
  return {
    name: "Memory",
    state: settings.memory.enabled ? "configured" : "missing",
    target: settings.memory.scope === "channel_user" ? "Channel/thread + user" : "Shared channel/thread",
    detail: settings.memory.enabled
      ? `${activeSessions} active session${activeSessions === 1 ? "" : "s"}; ${settings.memory.maxMessages} messages for ${settings.memory.ttlHours} hours.`
      : "Conversation memory is disabled.",
  };
}

async function checkService(name: string, target: string | undefined, configured: boolean, check: () => Promise<unknown>): Promise<ServiceStatus> {
  if (!configured) {
    return { name, state: "missing", target: target || "Not configured", detail: "URL and credential are required." };
  }
  try {
    const result = await check();
    return { name, state: "connected", target: target || "Configured", detail: summarizeHealth(result) };
  } catch (error) {
    return { name, state: "error", target: target || "Configured", detail: error instanceof Error ? error.message : String(error) };
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

function isTerminal(task: ToolAgentTask): boolean {
  return ["succeeded", "failed", "cancelled"].includes(task.status);
}

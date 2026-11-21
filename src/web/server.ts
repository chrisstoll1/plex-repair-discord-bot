import Fastify, { type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  aiFallbackTargetSchema,
  aiSettingsSchema,
  readRuntimeSettings,
  seerrUserMappingsSchema,
  repairSettingsSchema,
  timeoutSettingsSchema,
  type RuntimeSettings,
} from "../domain/settings.js";
import { createMediaClients } from "../services/service-factory.js";
import type { SettingsStore, SettingsWriter } from "../storage/settings.js";
import type { ToolAgentQueueService } from "../agent/tool-agent-queue.js";
import type { ToolAgentTask } from "../storage/tool-agent-tasks.js";
import type { DiscordBotService } from "../discord/bot.js";
import type { PiAuthService, PiAuthSnapshot } from "../agent/pi-auth.js";
import type { RepairCaseService } from "../agent/repair-case-service.js";
import { REPAIR_CASE_STATUSES, type RepairCase, type RepairCaseActivity, type RepairCaseStore, type RepairCaseStatus } from "../storage/repair-cases.js";
import { registerPortalAuth, type PortalAuthService } from "./portal-auth.js";

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
    seerr: z.object({ url: optionalUrl, apiKey: secretUpdateSchema, preferForRequests: z.boolean(), userMappings: seerrUserMappingsSchema, defaultUserId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) }).strict().optional(),
    ai: z
      .object({
        modelProvider: nonEmptyTrimmedString,
        modelId: z.string().trim(),
        fallbacks: z.array(aiFallbackTargetSchema).max(10).default([]),
        thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
        serviceTier: z.enum(["default", "priority"]).default("default"),
      })
      .strict(),
    timeouts: z
      .object({
        standardSeconds: z.number().int().min(5).max(600),
        releaseLookupSeconds: z.number().int().min(15).max(900),
      })
      .strict(),
    repair: z.object({ requireConfirmation: z.boolean(), allowDestructive: z.boolean(), allowDirectAdd: z.boolean().default(false) }).strict(),
  })
  .strict();

const taskParamsSchema = z.object({ id: nonEmptyTrimmedString }).strict();
const taskQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
const repairGroups = {
  working: ["working", "ready", "verifying"], waiting: ["waiting"],
  attention: ["needs_input", "blocked", "exhausted"], completed: ["resolved", "cancelled"],
} satisfies Record<string, RepairCaseStatus[]>;
const repairQuerySchema = taskQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  group: z.enum(["all", "working", "waiting", "attention", "completed"]).default("all"),
});
const repairParamsSchema = z.object({ id: nonEmptyTrimmedString }).strict();
const webhookParamsSchema = z.object({ provider: z.enum(["sonarr", "radarr"]), secret: nonEmptyTrimmedString }).strict();
const webhookConfigSchema = z.object({
  publicBaseUrl: optionalUrl,
  sonarrEnabled: z.boolean(),
  radarrEnabled: z.boolean(),
}).strict();

const piAuthStartSchema = z.object({
  providerId: nonEmptyTrimmedString.optional(),
  enterpriseDomain: z.string().trim().max(255).optional(),
}).strict().optional();

const piAuthInputSchema = z.object({
  providerId: nonEmptyTrimmedString.optional(),
  value: nonEmptyTrimmedString.max(4096),
}).strict();

const piAuthLogoutSchema = z.object({
  providerId: nonEmptyTrimmedString.optional(),
}).strict().optional();

const piAuthApiKeySchema = z.object({
  providerId: nonEmptyTrimmedString,
  apiKey: nonEmptyTrimmedString.max(4096),
}).strict();

const customModelSchema = z.object({
  id: nonEmptyTrimmedString.max(256),
  name: z.string().trim().max(256).optional(),
  reasoning: z.boolean().optional(),
  contextWindow: z.number().int().min(1024).max(10_000_000).optional(),
  maxTokens: z.number().int().min(128).max(1_000_000).optional(),
}).strict();

const customProviderSchema = z.object({
  id: nonEmptyTrimmedString.max(48),
  name: nonEmptyTrimmedString.max(120),
  baseUrl: z.string().trim().url(),
  api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]).default("openai-completions"),
  requiresApiKey: z.boolean().default(true),
  apiKey: secretUpdateSchema.optional(),
  models: z.array(customModelSchema).min(1).max(100),
}).strict();

const customProviderParamsSchema = z.object({
  id: nonEmptyTrimmedString.max(48),
}).strict();

const customProviderDiscoverSchema = z.object({
  baseUrl: z.string().trim().url(),
  apiKey: z.string().trim().max(4096).optional(),
  providerId: nonEmptyTrimmedString.max(48).optional(),
}).strict();

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
  toolAgentQueue: ToolAgentQueueService,
  discord: DiscordBotService,
  piAuth: PiAuthService,
  portalAuth: PortalAuthService,
  logger: Logger,
  webRoot = path.resolve(process.cwd(), "dist/web/public"),
  repairCases?: RepairCaseStore,
  repairCaseService?: RepairCaseService,
) {
  const app = Fastify({ loggerInstance: logger, logController: new Fastify.LogController({ disableRequestLogging: true }) });

  registerPortalAuth(app, portalAuth);

  app.setErrorHandler((error, _request, reply) => {
    const errorRecord = typeof error === "object" && error !== null ? (error as { statusCode?: number; message?: string }) : {};
    const statusCode = error instanceof z.ZodError ? 400 : errorRecord.statusCode && errorRecord.statusCode >= 400 && errorRecord.statusCode < 500 ? errorRecord.statusCode : 500;
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

  const repairmanImage = new URL("./assets/repairman.png", import.meta.url);
  app.get("/repairman.png", async (_request, reply) => reply.type("image/png").send(await fs.readFile(repairmanImage)));
  app.get("/favicon.png", async (_request, reply) => reply.type("image/png").send(await fs.readFile(repairmanImage)));
  app.get("/favicon.ico", async (_request, reply) => reply.type("image/png").send(await fs.readFile(repairmanImage)));

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
    const clients = createMediaClients(store, logger);
    const [piSnapshot, sonarr, radarr, plex, seerr] = await Promise.all([
      piAuth.refreshExpiredCredential(),
      checkService("Sonarr", settings.sonarr.url, Boolean(settings.sonarr.url && settings.sonarr.apiKey), () => clients.sonarr.getSystemStatus()),
      checkService("Radarr", settings.radarr.url, Boolean(settings.radarr.url && settings.radarr.apiKey), () => clients.radarr.getSystemStatus()),
      checkService("Plex", settings.plex.url, Boolean(settings.plex.url && settings.plex.token), () => clients.plex.getIdentity()),
      checkService("Seerr", settings.seerr.url, clients.seerr.isConfigured(), () => clients.seerr.getStatus()),
    ]);

    return {
      checkedAt: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      services: [
        discordStatus(settings),
        piAuthStatus(piSnapshot, settings),
        sonarr,
        radarr,
        plex,
        seerr,
      ],
    };
  });

  app.get("/api/tasks", async (request, reply) => {
    const query = parseOrReply(taskQuerySchema, request.query, reply);
    if (!query) return;
    if (query.offset === undefined) return { tasks: toolAgentQueue.list({ limit: query.limit }) };
    const counts = toolAgentQueue.statusCounts();
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const offset = pageOffset(query.offset, total, query.limit);
    return { tasks: toolAgentQueue.list({ limit: query.limit, offset }), counts, pagination: { total, offset, limit: query.limit } };
  });

  app.delete("/api/tasks/history", async () => ({ deleted: toolAgentQueue.clearHistory() }));

  app.post("/api/tasks/:id/cancel", async (request, reply) => {
    const params = parseOrReply(taskParamsSchema, request.params, reply);
    if (!params) return;
    const existing = toolAgentQueue.get(params.id);
    if (!existing) return sendError(reply, 404, "task_not_found", "Task was not found.");
    if (isTerminal(existing)) return sendError(reply, 409, "task_not_cancellable", `Task is already ${existing.status}.`);
    const task = await toolAgentQueue.cancel(params.id);
    if (!task) return sendError(reply, 404, "task_not_found", "Task was not found.");
    if (task.status !== "cancelled") return sendError(reply, 409, "task_not_cancellable", `Task is already ${task.status}.`);
    return { task };
  });

  app.get("/api/repairs", async (request, reply) => {
    const query = parseOrReply(repairQuerySchema, request.query, reply);
    if (!query) return;
    const statuses = query.group === "all" ? undefined : repairGroups[query.group];
    if (query.offset === undefined) return { repairs: repairCases?.list({ limit: query.limit, statuses }).map((repair) => publicRepairCase(repair, repairCases)) ?? [] };
    const counts = repairCases?.statusCounts() ?? Object.fromEntries(REPAIR_CASE_STATUSES.map((status) => [status, 0])) as Record<RepairCaseStatus, number>;
    const total = (statuses ?? REPAIR_CASE_STATUSES).reduce((sum, status) => sum + counts[status], 0);
    const offset = pageOffset(query.offset, total, query.limit);
    return { repairs: repairCases?.list({ limit: query.limit, offset, statuses }).map((repair) => publicRepairCase(repair, repairCases)) ?? [], counts, pagination: { total, offset, limit: query.limit } };
  });

  app.delete("/api/repairs", async () => {
    const ids = repairCases?.listAll().map((repairCase) => repairCase.id) ?? [];
    const deleted = await repairCaseService?.clearAll("admin") ?? 0;
    await Promise.all(ids.map((id) => discord.stopRepairCaseActivity(id)));
    return { deleted };
  });

  app.get("/api/repairs/:id/activity", async (request, reply) => {
    const params = parseOrReply(repairParamsSchema, request.params, reply);
    if (!params) return;
    if (!repairCases?.get(params.id)) return sendError(reply, 404, "repair_not_found", "Repair was not found.");
    return { activity: repairCases.listActivity(params.id).map(publicRepairActivity) };
  });

  app.get("/api/repairs/:id/timeline", async (request, reply) => {
    const params = parseOrReply(repairParamsSchema, request.params, reply);
    if (!params) return;
    const query = parseOrReply(taskQuerySchema, request.query, reply);
    if (!query) return;
    if (!repairCases?.get(params.id)) return sendError(reply, 404, "repair_not_found", "Repair was not found.");
    const activity = repairCases.listActivity(params.id).map((entry) => ({ ...publicRepairActivity(entry), id: `activity:${entry.id}`, source: activitySource(entry.kind) }));
    const botActivityCounts = activity.filter((entry) => entry.source === "bot" && entry.message).reduce((counts, entry) => counts.set(entry.message!, (counts.get(entry.message!) ?? 0) + 1), new Map<string, number>());
    const messages = repairCases.listMessages(params.id).filter((message) => {
      if (message.role !== "assistant") return true;
      const remaining = botActivityCounts.get(message.content) ?? 0;
      if (remaining === 0) return true;
      botActivityCounts.set(message.content, remaining - 1);
      return false;
    }).map((message) => ({
      id: `message:${message.id}`,
      repairId: message.caseId,
      type: `${message.role}_message`,
      source: message.role === "user" ? "user" : message.role === "assistant" ? "bot" : "system",
      message: message.content,
      actor: message.metadata && typeof message.metadata === "object" && "userId" in message.metadata ? String(message.metadata.userId) : undefined,
      createdAt: message.createdAt,
    }));
    const timeline = [...activity, ...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    if (query.offset === undefined) return { timeline };
    const offset = pageOffset(query.offset, timeline.length, query.limit);
    return { timeline: timeline.reverse().slice(offset, offset + query.limit), pagination: { total: timeline.length, offset, limit: query.limit } };
  });

  app.post("/api/repairs/:id/cancel", async (request, reply) => {
    const params = parseOrReply(repairParamsSchema, request.params, reply);
    if (!params) return;
    const repair = repairCaseService?.cancel(params.id, "admin");
    if (!repair) return sendError(reply, 404, "repair_not_found", "Repair was not found.");
    await discord.stopRepairCaseActivity(repair.id);
    return { repair: publicRepairCase(repair, repairCases!) };
  });

  app.post("/api/repairs/:id/resume", async (request, reply) => {
    const params = parseOrReply(repairParamsSchema, request.params, reply);
    if (!params) return;
    const repair = repairCaseService?.resume(params.id, "admin");
    if (!repair) return sendError(reply, 409, "repair_not_resumable", "Repair cannot be resumed from its current state.");
    return { repair: publicRepairCase(repair, repairCases!) };
  });

  app.get("/api/webhooks/config", async () => publicWebhookConfig(store));
  app.put("/api/webhooks/config", async (request, reply) => {
    const config = parseOrReply(webhookConfigSchema, request.body, reply);
    if (!config) return;
    const sonarrWasEnabled = store.getString("webhooks.sonarr.enabled") === "true";
    const radarrWasEnabled = store.getString("webhooks.radarr.enabled") === "true";
    store.setString("webhooks.publicBaseUrl", config.publicBaseUrl);
    store.setString("webhooks.sonarr.enabled", String(config.sonarrEnabled));
    store.setString("webhooks.radarr.enabled", String(config.radarrEnabled));
    const dueAt = new Date(Date.now() + 15 * 60_000);
    if (sonarrWasEnabled && !config.sonarrEnabled) repairCases?.replaceProviderWakesWithTimers("sonarr", dueAt);
    if (radarrWasEnabled && !config.radarrEnabled) repairCases?.replaceProviderWakesWithTimers("radarr", dueAt);
    repairCaseService?.refreshScheduling();
    ensureWebhookSecret(store);
    return publicWebhookConfig(store);
  });
  app.post("/api/webhooks/rotate-secret", async () => {
    store.setString("webhooks.secret", crypto.randomBytes(24).toString("base64url"), { secret: true });
    return publicWebhookConfig(store);
  });

  app.post("/webhooks/:provider/:secret", async (request, reply) => {
    const params = parseOrReply(webhookParamsSchema, request.params, reply);
    if (!params) return;
    const expected = store.getString("webhooks.secret");
    if (!expected || !safeEqual(params.secret, expected)) return sendError(reply, 401, "invalid_webhook_secret", "Webhook authentication failed.");
    if (store.getString(`webhooks.${params.provider}.enabled`) !== "true") return sendError(reply, 409, "webhook_disabled", "This webhook integration is disabled.");
    if (!repairCaseService) return sendError(reply, 503, "repair_service_unavailable", "Repair service is unavailable.");
    const event = normalizeArrWebhook(params.provider, request.body);
    store.setString(`webhooks.${params.provider}.lastReceivedAt`, new Date().toISOString());
    const result = repairCaseService.receiveEvent(event);
    return reply.status(202).send({ accepted: true, duplicate: result.duplicate, matched: result.matchedCaseIds.length });
  });

  app.get("/api/pi-auth", async () => ({ piAuth: publicPiAuth(await piAuth.refreshExpiredCredential()) }));
  app.get("/api/pi-models", async () => {
    await piAuth.refreshExpiredCredential();
    return { models: await piAuth.listAvailableModels() };
  });
  app.post("/api/pi-auth/start", async (request, reply) => {
    const body = request.body === undefined || request.body === null ? undefined : parseOrReply(piAuthStartSchema, request.body, reply);
    if (request.body !== undefined && request.body !== null && !body) return;
    return {
      piAuth: publicPiAuth(
        await piAuth.startLoginAndWaitForDeviceCode(body?.providerId, { enterpriseDomain: body?.enterpriseDomain }),
      ),
    };
  });
  app.post("/api/pi-auth/input", async (request, reply) => {
    const body = parseOrReply(piAuthInputSchema, request.body, reply);
    if (!body) return;
    return { piAuth: publicPiAuth(await piAuth.submitLoginInput(body.value, body.providerId)) };
  });
  app.post("/api/pi-auth/cancel", async () => ({ piAuth: publicPiAuth(await piAuth.cancelLogin()) }));
  app.post("/api/pi-auth/logout", async (request, reply) => {
    const body = request.body === undefined || request.body === null ? undefined : parseOrReply(piAuthLogoutSchema, request.body, reply);
    if (request.body !== undefined && request.body !== null && !body) return;
    return { piAuth: publicPiAuth(await piAuth.logout(body?.providerId)) };
  });
  app.post("/api/pi-auth/api-key", async (request, reply) => {
    const body = parseOrReply(piAuthApiKeySchema, request.body, reply);
    if (!body) return;
    return { piAuth: publicPiAuth(await piAuth.setApiKey(body.providerId, body.apiKey)) };
  });
  app.put("/api/pi-auth/custom", async (request, reply) => {
    const body = parseOrReply(customProviderSchema, request.body, reply);
    if (!body) return;
    return { piAuth: publicPiAuth(await piAuth.saveCustomProvider(body)) };
  });
  app.delete("/api/pi-auth/custom/:id", async (request, reply) => {
    const params = parseOrReply(customProviderParamsSchema, request.params, reply);
    if (!params) return;
    return { piAuth: publicPiAuth(await piAuth.deleteCustomProvider(params.id)) };
  });
  app.post("/api/pi-auth/custom/discover", async (request, reply) => {
    const body = parseOrReply(customProviderDiscoverSchema, request.body, reply);
    if (!body) return;
    return { models: await piAuth.discoverCustomProviderModels(body) };
  });

  app.get("/*", async (request, reply) => {
    if (request.url === "/api" || request.url.startsWith("/api/") || request.url.startsWith("/health/")) {
      return sendError(reply, 404, "route_not_found", "Route was not found.");
    }
    return reply.sendFile("index.html");
  });

  return app;
}

function pageOffset(requested: number, total: number, limit: number) {
  return Math.min(requested, Math.max(0, Math.ceil(total / limit) - 1) * limit);
}

function publicRepairCase(repairCase: RepairCase, store: RepairCaseStore) {
  const activity = store.listActivity(repairCase.id);
  const latest = [...activity].reverse().find((entry) => entry.kind === "progress" || entry.kind === "waiting" || entry.kind === "resolved" || entry.kind === "needs_input" || entry.kind === "blocked" || entry.kind === "user_update");
  const details = latest?.details && typeof latest.details === "object" ? latest.details as { message?: string; userUpdate?: string } : {};
  const latestText = typeof latest?.details === "string" ? latest.details : details.userUpdate ?? details.message;
  const wake = store.getWake(repairCase.id);
  return {
    id: repairCase.id,
    status: repairCase.status,
    title: repairCase.title,
    latestUpdate: latestText,
    nextWakeAt: wake?.type === "timer" ? String(wake.dueAt) : wake?.fallbackAt ? String(wake.fallbackAt) : undefined,
    threadUrl: repairCase.guildId ? `https://discord.com/channels/${repairCase.guildId}/${repairCase.threadId}` : undefined,
    createdAt: repairCase.createdAt,
    updatedAt: repairCase.updatedAt,
    resolvedAt: repairCase.resolvedAt,
    cancelledAt: repairCase.cancelledAt,
  };
}

function publicRepairActivity(activity: RepairCaseActivity) {
  const details = activity.details && typeof activity.details === "object" ? activity.details as { message?: string; userUpdate?: string; to?: RepairCase["status"] } : {};
  return { id: String(activity.id), repairId: activity.caseId, type: activity.kind, actor: activity.actor, message: typeof activity.details === "string" ? activity.details : details.userUpdate ?? details.message, status: details.to, details: activity.details, createdAt: activity.createdAt };
}

function activitySource(kind: string): "bot" | "agent" | "system" {
  if (["progress", "waiting", "resolved", "needs_input", "blocked", "user_update"].includes(kind)) return "bot";
  return kind === "attempt_started" || kind === "rerun_requested" ? "agent" : "system";
}

function ensureWebhookSecret(store: SettingsStore): string {
  const existing = store.getString("webhooks.secret");
  if (existing) return existing;
  const created = crypto.randomBytes(24).toString("base64url");
  store.setString("webhooks.secret", created, { secret: true });
  return created;
}

function publicWebhookConfig(store: SettingsStore) {
  const secret = ensureWebhookSecret(store);
  const base = (store.getString("webhooks.publicBaseUrl") ?? "").replace(/\/$/, "");
  const endpoint = (provider: "sonarr" | "radarr") => `${base}/webhooks/${provider}/${secret}`;
  return {
    publicBaseUrl: base,
    sonarrEnabled: store.getString("webhooks.sonarr.enabled") === "true",
    radarrEnabled: store.getString("webhooks.radarr.enabled") === "true",
    sonarrUrl: base ? endpoint("sonarr") : undefined,
    radarrUrl: base ? endpoint("radarr") : undefined,
    sonarrLastReceivedAt: store.getString("webhooks.sonarr.lastReceivedAt"),
    radarrLastReceivedAt: store.getString("webhooks.radarr.lastReceivedAt"),
  };
}

function normalizeArrWebhook(provider: "sonarr" | "radarr", body: unknown) {
  if (!body || typeof body !== "object") throw Object.assign(new Error("Webhook payload must be a JSON object"), { statusCode: 400 });
  const payload = body as Record<string, unknown>;
  const eventType = normalizeEventType(typeof payload.eventType === "string" ? payload.eventType : "unknown");
  const mediaIds = provider === "sonarr" ? sonarrMediaIds(payload) : radarrMediaIds(payload);
  const stable = JSON.stringify({ eventType, mediaIds, downloadId: payload.downloadId, episodeFile: objectId(payload.episodeFile), movieFile: objectId(payload.movieFile) });
  const eventId = crypto.createHash("sha256").update(stable).digest("hex");
  return { provider, eventId, eventType, mediaIds, payload };
}

function sonarrMediaIds(payload: Record<string, unknown>): string[] {
  const mediaIds: string[] = [];
  if (Array.isArray(payload.episodes)) {
    for (const episode of payload.episodes) {
      const id = objectId(episode);
      if (id !== undefined) mediaIds.push(`episode:${id}`);
    }
  }
  const seriesId = objectId(payload.series);
  if (seriesId !== undefined) mediaIds.push(`series:${seriesId}`);
  return [...new Set(mediaIds)].sort();
}

function radarrMediaIds(payload: Record<string, unknown>): string[] {
  const id = objectId(payload.movie);
  return id === undefined ? [] : [`movie:${id}`];
}

function objectId(value: unknown): string | number | undefined {
  if (!value || typeof value !== "object" || !("id" in value)) return undefined;
  const id = value.id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

function normalizeEventType(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
  const ai = aiSettingsSchema.pick({ modelProvider: true, modelId: true, fallbacks: true, thinkingLevel: true, serviceTier: true }).parse(update.ai);
  const seen = new Set([`${ai.modelProvider}\0${ai.modelId}`]);
  const fallbacks = ai.fallbacks.filter((item) => {
    const key = `${item.modelProvider}\0${item.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ...update,
    ai: { ...ai, fallbacks },
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
  if (update.seerr) {
    writer.setString("seerr.url", update.seerr.url);
    applySecret(writer, "seerr.apiKey", update.seerr.apiKey);
    writer.setString("seerr.preferForRequests", String(update.seerr.preferForRequests));
    writer.setString("seerr.userMappings", update.seerr.userMappings);
    writer.setString("seerr.defaultUserId", String(update.seerr.defaultUserId));
  }

  writer.setJson("ai", update.ai);
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
    seerr: { url: settings.seerr.url, apiKey: { configured: Boolean(settings.seerr.apiKey) }, preferForRequests: settings.seerr.preferForRequests, userMappings: settings.seerr.userMappings, defaultUserId: settings.seerr.defaultUserId },
    ai: {
      modelProvider: settings.ai.modelProvider,
      modelId: settings.ai.modelId,
      fallbacks: settings.ai.fallbacks,
      thinkingLevel: settings.ai.thinkingLevel,
      serviceTier: settings.ai.serviceTier,
    },
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

function piAuthStatus(snapshot: PiAuthSnapshot, settings: RuntimeSettings): ServiceStatus {
  const providers = snapshot.providers ?? [];
  const configuredProviders = providers.filter((provider) => provider.configured);
  const primaryProvider = providers.find((provider) => provider.id === settings.ai.modelProvider);
  const fallbackProviders = settings.ai.fallbacks
    .map((fallback) => providers.find((provider) => provider.id === fallback.modelProvider))
    .filter((provider): provider is NonNullable<typeof provider> => Boolean(provider?.configured));

  if (primaryProvider?.configured) {
    const uniqueFallbacks = new Set(fallbackProviders.map((provider) => provider.id));
    uniqueFallbacks.delete(primaryProvider.id);
    const fallbackNote = uniqueFallbacks.size > 0
      ? ` (${uniqueFallbacks.size} fallback ${uniqueFallbacks.size === 1 ? "provider" : "providers"} ready)`
      : "";
    return {
      name: "AI Auth",
      state: "configured",
      target: primaryProvider.name,
      detail: `${primaryProvider.name} is configured${fallbackNote}.`,
    };
  }

  if (fallbackProviders.length > 0) {
    const firstFallback = fallbackProviders[0]!;
    return {
      name: "AI Auth",
      state: "configured",
      target: firstFallback.name,
      detail: `Primary provider (${primaryProvider?.name ?? settings.ai.modelProvider}) is not connected; fallback ${firstFallback.name} is ready.`,
    };
  }

  if (configuredProviders.length > 0 || snapshot.configured) {
    const names = configuredProviders.map((provider) => provider.name).join(", ");
    return {
      name: "AI Auth",
      state: "configured",
      target: names || "Connected",
      detail: configuredProviders.length > 0
        ? `${configuredProviders.length} AI ${configuredProviders.length === 1 ? "provider is" : "providers are"} connected.`
        : "AI auth is configured.",
    };
  }

  return {
    name: "AI Auth",
    state: "missing",
    target: "No AI provider",
    detail: "Connect an AI provider in Settings → AI.",
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

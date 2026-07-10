import fs from "node:fs";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { PiAuthService } from "./agent/pi-auth.js";
import { PiAgentService } from "./agent/pi-agent.js";
import { ToolAgentQueueService } from "./agent/tool-agent-queue.js";
import { RepairCaseService } from "./agent/repair-case-service.js";
import { DiscordBotService } from "./discord/bot.js";
import { openDatabase } from "./storage/db.js";
import { ConversationStore } from "./storage/conversation.js";
import { ToolAgentTaskStore } from "./storage/tool-agent-tasks.js";
import { RepairCaseStore } from "./storage/repair-cases.js";
import { SecretBox } from "./storage/secrets.js";
import { SettingsStore } from "./storage/settings.js";
import { createWebServer } from "./web/server.js";
import { readRuntimeSettings } from "./domain/settings.js";

const config = loadConfig();
fs.mkdirSync(config.configDir, { recursive: true });
fs.mkdirSync(config.piAgentDir, { recursive: true });

const logger = createLogger(config);
const db = openDatabase(config);
const secrets = SecretBox.open(config.secretsKeyPath);
const settings = new SettingsStore(db, secrets);
const conversations = new ConversationStore(db);
const toolAgentTasks = new ToolAgentTaskStore(db);
const repairCases = new RepairCaseStore(db);
const piAuth = new PiAuthService(config);
const agent = new PiAgentService(config, settings, logger);
const toolAgentQueue = new ToolAgentQueueService(toolAgentTasks, (task, roles, signal) => agent.runToolAgentTask(task, roles, signal), logger);
agent.setToolAgentQueue(toolAgentQueue);
toolAgentQueue.recover();
const discord = new DiscordBotService(settings, conversations, agent, logger, repairCases);
const repairCaseService = new RepairCaseService(repairCases, {
  logger,
  runner: async (repairCase, runContext) => {
    const latestMessage = [...runContext.messages].reverse().find((message) => message.role === "user");
    const metadata = latestMessage?.metadata && typeof latestMessage.metadata === "object" ? latestMessage.metadata as { userId?: string; roles?: string[] } : {};
    const authorizationActor = repairCase.authorizationActor || metadata.userId || repairCase.userId;
    let roles = metadata.userId === authorizationActor && Array.isArray(metadata.roles) ? metadata.roles : [];
    if (repairCase.guildId) {
      try {
        roles = await discord.getMemberRoles(repairCase.guildId, authorizationActor);
      } catch (error) {
        logger.warn({ err: error, caseId: repairCase.id, userId: authorizationActor }, "Failed to refresh repair-case Discord roles");
      }
    }
    const webhookBaseUrl = settings.getString("webhooks.publicBaseUrl");
    const webhookProviders = webhookBaseUrl
      ? (["sonarr", "radarr"] as const).filter((provider) => settings.getString(`webhooks.${provider}.enabled`) === "true")
      : [];
    const result = await agent.runRepairCase({
      objective: repairCase.objective,
      checkpoint: repairCase.checkpoint,
      messages: runContext.messages.map((message) => ({
        role: message.role,
        content: message.content,
        userId: message.metadata && typeof message.metadata === "object" && "userId" in message.metadata ? String(message.metadata.userId) : undefined,
        createdAt: message.createdAt,
      })),
      context: {
        guildId: repairCase.guildId || undefined,
        channelId: repairCase.threadId,
        userId: authorizationActor,
        roles,
        conversationKey: `repair:${repairCase.id}`,
        sourceMessageId: repairCase.source,
        onProgress: async (update) => {
          if (update.type === "tasks_started") await runContext.progress(update.message?.trim() || "I’m checking the most likely causes now and will keep you updated.");
        },
      },
      webhookProviders,
      signal: runContext.signal,
    });
    const control = result.control;
    if (!control) {
      return {
        status: "needs_input",
        checkpoint: { summary: result.response, reason: "No lifecycle decision was recorded" },
        deliveries: [{ kind: "discord_message", payload: { content: result.response }, dedupeKey: `${repairCase.id}:attempt:${repairCase.attempts}:final` }],
      };
    }
    if (control.type === "wait") {
      const wake = control.provider
        ? { type: "arr_event" as const, provider: control.provider, eventType: control.eventType, mediaId: control.mediaId }
        : { type: "timer" as const, dueAt: normalizeResumeAt(control.resumeAt) };
      return {
        wake,
        checkpoint: { summary: control.checkpoint, waitingFor: control.provider ? `${control.provider}:${control.eventType}:${control.mediaId}` : control.resumeAt },
        activity: { kind: "waiting", details: { userUpdate: control.userUpdate, wake } },
        deliveries: [{ kind: "discord_message", payload: { content: control.userUpdate }, dedupeKey: `${repairCase.id}:attempt:${repairCase.attempts}:wait` }],
      };
    }
    return {
      status: control.status,
      checkpoint: { summary: control.checkpoint },
      activity: { kind: control.status, details: { userUpdate: control.userUpdate } },
      deliveries: [{ kind: "discord_message", payload: { content: control.userUpdate }, dedupeKey: `${repairCase.id}:attempt:${repairCase.attempts}:finish` }],
    };
  },
  onDelivery: (delivery, repairCase) => discord.deliverRepairMessage(delivery, repairCase),
});
discord.setRepairCaseService(repairCaseService);
repairCaseService.start();

const pruneConversations = () => {
  try {
    conversations.prune(readRuntimeSettings(settings).memory.ttlHours);
  } catch (error) {
    logger.warn({ err: error }, "Failed to prune expired conversation memory");
  }
};
pruneConversations();
const conversationPruneTimer = setInterval(pruneConversations, 15 * 60 * 1000);
conversationPruneTimer.unref();

await discord.start();

const web = await createWebServer(settings, conversations, toolAgentQueue, discord, piAuth, logger, undefined, repairCases, repairCaseService);
await web.listen({ host: config.httpHost, port: config.httpPort });

logger.info({ host: config.httpHost, port: config.httpPort, configDir: config.configDir }, "Plex Repairman started");

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  clearInterval(conversationPruneTimer);
  await discord.stop();
  await Promise.all([web.close(), agent.shutdown(), toolAgentQueue.shutdown(), repairCaseService.shutdown()]);
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

function normalizeResumeAt(value?: string): string {
  const parsed = value ? Date.parse(value) : Number.NaN;
  const minimum = Date.now() + 60_000;
  const maximum = Date.now() + 7 * 24 * 60 * 60 * 1000;
  return new Date(Number.isFinite(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : Date.now() + 15 * 60_000).toISOString();
}

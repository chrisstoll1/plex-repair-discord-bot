import fs from "node:fs";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { PiAuthService } from "./agent/pi-auth.js";
import { PiAgentService } from "./agent/pi-agent.js";
import { ToolAgentQueueService } from "./agent/tool-agent-queue.js";
import { DiscordBotService } from "./discord/bot.js";
import { openDatabase } from "./storage/db.js";
import { ConversationStore } from "./storage/conversation.js";
import { ToolAgentTaskStore } from "./storage/tool-agent-tasks.js";
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
const piAuth = new PiAuthService(config);
const agent = new PiAgentService(config, settings, logger);
const toolAgentQueue = new ToolAgentQueueService(toolAgentTasks, (task, roles, signal) => agent.runToolAgentTask(task, roles, signal), logger);
agent.setToolAgentQueue(toolAgentQueue);
toolAgentQueue.recover();
const discord = new DiscordBotService(settings, conversations, agent, logger);

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

const web = await createWebServer(settings, conversations, toolAgentQueue, discord, piAuth, logger);
await web.listen({ host: config.httpHost, port: config.httpPort });

logger.info({ host: config.httpHost, port: config.httpPort, configDir: config.configDir }, "Plex Repairman started");

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  clearInterval(conversationPruneTimer);
  await discord.stop();
  await Promise.all([web.close(), agent.shutdown(), toolAgentQueue.shutdown()]);
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

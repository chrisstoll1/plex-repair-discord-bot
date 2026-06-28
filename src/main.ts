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
const toolAgentQueue = new ToolAgentQueueService(toolAgentTasks, (task, roles) => agent.runToolAgentTask(task, roles), logger);
agent.setToolAgentQueue(toolAgentQueue);
toolAgentQueue.recover();
const discord = new DiscordBotService(settings, conversations, agent, logger);

await discord.start();

const web = await createWebServer(settings, conversations, toolAgentQueue, discord, piAuth, logger);
await web.listen({ host: config.httpHost, port: config.httpPort });

logger.info({ host: config.httpHost, port: config.httpPort, configDir: config.configDir }, "Plex Repairman started");

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  await discord.stop();
  await web.close();
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

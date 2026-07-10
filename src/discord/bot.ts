import { Client, Events, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } from "discord.js";
import type { Message } from "discord.js";
import type { Logger } from "pino";
import { csvToSet, readRuntimeSettings } from "../domain/settings.js";
import type { SettingsStore } from "../storage/settings.js";
import type { ConversationMessage, ConversationStore } from "../storage/conversation.js";
import type { PiAgentService } from "../agent/pi-agent.js";

export class DiscordBotService {
  private client: Client | undefined;
  private readonly conversationQueue = new KeyedSerialQueue();
  private readonly processingMessageIds = new Set<string>();

  constructor(
    private readonly store: SettingsStore,
    private readonly conversations: ConversationStore,
    private readonly agent: PiAgentService,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    const settings = readRuntimeSettings(this.store);
    if (!settings.discord.token) {
      this.logger.warn("Discord token is not configured; bot will remain offline");
      return;
    }

    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel],
    });

    client.once(Events.ClientReady, async (readyClient) => {
      this.logger.info({ user: readyClient.user.tag }, "Discord bot connected");
      await this.registerHealthCommand(settings.discord.token!, settings.discord.applicationId);
    });

    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== "health") return;

      await interaction.reply({ content: "Plex Repairman is online.", ephemeral: true });
    });

    client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot) return;
      if (!client.user) return;

      const latest = readRuntimeSettings(this.store);
      const isDirectMessage = message.guildId === null;

      if (isDirectMessage) {
        if (!latest.discord.allowDirectMessages) {
          this.logger.debug({ userId: message.author.id }, "Ignoring Discord DM because direct messages are disabled");
          return;
        }
      } else {
        if (!message.mentions.has(client.user)) return;
        if (!isAllowed(message.guildId, csvToSet(latest.discord.allowedGuildIds))) return;
        if (!isAllowed(message.channelId, csvToSet(latest.discord.allowedChannelIds))) return;
      }

      const content = message.content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
      const reactions = new MessageReactionTracker(message, latest.discord.reactionsEnabled, this.logger);
      if (!content) {
        await reactions.set("❓");
        await message.reply(
          isDirectMessage
            ? "Tell me what media issue to check, e.g. `why is Dune missing?`"
            : "Tell me what media issue to check, e.g. `@Plex Repairman why is Dune missing?`",
        );
        return;
      }

      if (this.processingMessageIds.has(message.id)) {
        this.logger.debug({ messageId: message.id }, "Ignoring duplicate in-flight Discord message");
        return;
      }

      const conversationKey = getConversationKey({
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        scope: latest.memory.scope,
      });
      const botUserId = client.user.id;
      this.processingMessageIds.add(message.id);

      await reactions.set(selectInitialReaction(content));
      const typing = startTypingRefresh(message, this.logger);
      const progress = startReactionProgress(reactions, content);

      try {
        await this.conversationQueue.run(conversationKey, async () => {
          try {
            if (this.conversations.hasMessageId(message.id)) {
              this.logger.debug({ messageId: message.id }, "Ignoring previously processed Discord message");
              return;
            }
          } catch (error) {
            this.logger.warn({ err: error, messageId: message.id }, "Failed to check conversation memory for a duplicate message");
          }

          const roles = message.member?.roles.cache.map((role) => role.id) ?? [];
          let recentMessages: ConversationMessage[] = [];
          if (latest.memory.enabled && latest.memory.maxMessages > 0) {
            try {
              recentMessages = this.conversations.getRecent(
                conversationKey,
                latest.memory.maxMessages,
                latest.memory.ttlHours,
                latest.memory.includeBotReplies,
              );
            } catch (error) {
              this.logger.warn({ err: error, conversationKey }, "Failed to read conversation memory; continuing without it");
            }
          }

          const response = await this.agent.runDiscordRequest(content, {
            guildId: message.guildId ?? undefined,
            channelId: message.channelId,
            userId: message.author.id,
            roles,
            conversationKey,
            sourceMessageId: message.id,
            recentMessages,
            onProgress: async (update) => {
              if (update.type !== "tasks_started") return;
              await message.reply({
                content: formatAgentProgress(update.titles, update.message),
                allowedMentions: { parse: [], repliedUser: false },
              });
            },
          });
          const deliveredResponse = truncateDiscord(response);

          progress.stop();
          await message.reply({ content: deliveredResponse, allowedMentions: { parse: [], repliedUser: false } });

          try {
            const persistenceSettings = readRuntimeSettings(this.store).memory;
            if (persistenceSettings.enabled && persistenceSettings.maxMessages > 0) {
              this.conversations.addExchange({
                conversationKey,
                userId: message.author.id,
                userMessageId: message.id,
                userContent: content,
                userCreatedAt: message.createdAt,
                assistantUserId: botUserId,
                assistantContent: persistenceSettings.includeBotReplies ? deliveredResponse : undefined,
              });
            } else {
              this.conversations.recordProcessedMessage(message.id);
            }
          } catch (error) {
            this.logger.warn({ err: error, messageId: message.id, conversationKey }, "Failed to persist delivered conversation response");
          }

          await reactions.set("✅");
        });
      } catch (error) {
        progress.stop();
        this.logger.error({ err: error }, "Failed to process Discord message");
        await message.reply({ content: "I couldn't complete that request. Please try again shortly.", allowedMentions: { parse: [], repliedUser: false } });
        await reactions.set("❌");
      } finally {
        this.processingMessageIds.delete(message.id);
        typing.stop();
        progress.stop();
      }
    });

    try {
      await client.login(settings.discord.token);
      this.client = client;
    } catch (error) {
      this.logger.error({ err: error }, "Discord bot login failed; web portal will remain online so settings can be fixed");
      await client.destroy();
      this.client = undefined;
    }
  }

  async restart(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = undefined;
    }
    await this.start();
  }

  async stop(): Promise<void> {
    await this.client?.destroy();
  }

  private async registerHealthCommand(token: string, applicationId?: string): Promise<void> {
    if (!applicationId) return;

    const command = new SlashCommandBuilder().setName("health").setDescription("Check whether Plex Repairman is online");
    const rest = new REST({ version: "10" }).setToken(token);

    try {
      await rest.put(Routes.applicationCommands(applicationId), { body: [command.toJSON()] });
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to register Discord health command");
    }
  }
}

export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

function getConversationKey(params: { guildId: string | null; channelId: string; userId: string; scope: "channel_user" | "channel" }): string {
  const base = params.guildId ? `guild:${params.guildId}:channel:${params.channelId}` : `dm:${params.userId}`;
  return params.scope === "channel_user" && params.guildId ? `${base}:user:${params.userId}` : base;
}

function isAllowed(value: string | null, allowed: Set<string>): boolean {
  return allowed.size === 0 || (value !== null && allowed.has(value));
}

function truncateDiscord(value: string): string {
  if (value.length <= 1900) return value;
  return `${value.slice(0, 1880)}\n...`;
}

export function formatAgentProgress(titles: string[], message?: string): string {
  const normalized = titles
    .map((title) => title.replace(/\s+/g, " ").trim().slice(0, 120))
    .filter(Boolean);
  const shown = normalized.slice(0, 3);
  const normalizedMessage = message?.replace(/\s+/g, " ").trim().slice(0, 180);
  if (normalizedMessage) {
    if (shown.length === 0) return normalizedMessage;

    const remaining = normalized.length - shown.length;
    const lines = shown.map((title) => `- ${title}`);
    if (remaining > 0) lines.push(`- ${remaining} other check${remaining === 1 ? "" : "s"}`);
    return `${normalizedMessage}\n\n${lines.join("\n")}`;
  }

  if (shown.length === 0) return "I'm checking that now. I'll follow up when it's finished.";

  const remaining = normalized.length - shown.length;
  const lines = shown.map((title) => `- ${title}`);
  if (remaining > 0) lines.push(`- ${remaining} other check${remaining === 1 ? "" : "s"}`);
  return `I'm checking:\n${lines.join("\n")}\n\nI'll follow up when it's finished.`;
}

class MessageReactionTracker {
  private currentEmoji: string | undefined;
  private chain = Promise.resolve();

  constructor(
    private readonly message: Message,
    private readonly enabled: boolean,
    private readonly logger: Logger,
  ) {}

  async set(emoji: string): Promise<void> {
    if (!this.enabled) return;

    this.chain = this.chain
      .then(() => this.apply(emoji))
      .catch((error) => {
        this.logger.debug({ err: error, messageId: this.message.id, emoji }, "Failed to update Discord reaction");
      });

    await this.chain;
  }

  private async apply(emoji: string): Promise<void> {
    if (this.currentEmoji === emoji) return;

    if (this.currentEmoji) {
      const existing = this.message.reactions.cache.get(this.currentEmoji);
      const botUserId = this.message.client.user?.id;
      if (botUserId) await existing?.users.remove(botUserId);
    }

    await this.message.react(emoji);
    this.currentEmoji = emoji;
  }
}

function startTypingRefresh(message: Message, logger: Logger): { stop: () => void } {
  let stopped = false;

  const send = async () => {
    try {
      if (!canSendTyping(message.channel)) return;
      await message.channel.sendTyping();
    } catch (error) {
      logger.debug({ err: error, messageId: message.id }, "Failed to refresh Discord typing indicator");
    }
  };

  void send();
  const interval = setInterval(() => {
    if (!stopped) void send();
  }, 8_000);

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}

function canSendTyping(channel: Message["channel"]): channel is Message["channel"] & { sendTyping: () => Promise<void> } {
  return "sendTyping" in channel && typeof channel.sendTyping === "function";
}

function startReactionProgress(reactions: MessageReactionTracker, content: string): { stop: () => void } {
  const emojis = uniqueEmojis([selectInitialReaction(content), "🤔", "🧐", "🔎", "🛠️"]);
  let index = 0;

  const interval = setInterval(() => {
    index = (index + 1) % emojis.length;
    void reactions.set(emojis[index] ?? "🤔");
  }, 10_000);

  return {
    stop: () => clearInterval(interval),
  };
}

function selectInitialReaction(content: string): string {
  const normalized = content.toLowerCase();

  if (/\b(fix|repair|replace|delete|remove|grab|download|upgrade|monitor)\b/.test(normalized)) return "🛠️";
  if (/\b(audio|language|dub|subtitle|subtitles|subs|english|japanese|multi-language|multilanguage)\b/.test(normalized)) return "🔊";
  if (/\b(search|find|missing|where|why|available|exists?)\b/.test(normalized)) return "🔎";
  if (/\b(movie|film|radarr|theatrical)\b/.test(normalized)) return "🎬";
  if (/\b(show|series|season|episode|anime|sonarr|specials?|s\d{1,2}e\d{1,2})\b/.test(normalized)) return "📺";
  if (/\b(wrong|weird|broken|bad|issue|problem)\b/.test(normalized)) return "🧐";

  return "👀";
}

function uniqueEmojis(emojis: string[]): string[] {
  return [...new Set(emojis)];
}

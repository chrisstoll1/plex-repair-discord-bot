import { Client, Events, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, ThreadAutoArchiveDuration } from "discord.js";
import type { Message } from "discord.js";
import type { Logger } from "pino";
import { csvToSet, readRuntimeSettings } from "../domain/settings.js";
import type { SettingsStore } from "../storage/settings.js";
import type { ConversationMessage, ConversationStore } from "../storage/conversation.js";
import type { PiAgentService } from "../agent/pi-agent.js";
import type { RepairCaseService } from "../agent/repair-case-service.js";
import type { RepairCase, RepairCaseOutboxItem, RepairCaseStatus, RepairCaseStore } from "../storage/repair-cases.js";

export class DiscordBotService {
  private client: Client | undefined;
  private readonly conversationQueue = new KeyedSerialQueue();
  private readonly processingMessageIds = new Set<string>();
  private repairCaseService?: RepairCaseService;

  constructor(
    private readonly store: SettingsStore,
    private readonly conversations: ConversationStore,
    private readonly agent: PiAgentService,
    private readonly logger: Logger,
    private readonly repairCases?: RepairCaseStore,
  ) {}

  setRepairCaseService(service: RepairCaseService): void {
    this.repairCaseService = service;
  }

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
      const existingCase = this.findActiveCase(message.guildId ?? "", message.channelId);

      if (isDirectMessage) {
        if (!latest.discord.allowDirectMessages) {
          this.logger.debug({ userId: message.author.id }, "Ignoring Discord DM because direct messages are disabled");
          return;
        }
      } else {
        if (!existingCase && !message.mentions.has(client.user)) return;
        if (!isAllowed(message.guildId, csvToSet(latest.discord.allowedGuildIds))) return;
        const allowedChannelId = message.channel.isThread() ? message.channel.parentId : message.channelId;
        if (!isAllowed(allowedChannelId, csvToSet(latest.discord.allowedChannelIds))) return;
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


      if (this.repairCases && this.repairCaseService) {
        await this.handleRepairCaseMessage(message, content, existingCase);
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

  async getMemberRoles(guildId: string, userId: string): Promise<string[]> {
    if (!guildId || !this.client) return [];
    const guild = await this.client.guilds.fetch(guildId);
    const member = await guild.members.fetch(userId);
    return member.roles.cache.map((role) => role.id);
  }

  async deliverRepairMessage(delivery: RepairCaseOutboxItem, repairCase: RepairCase): Promise<void> {
    if (!this.client) throw new Error("Discord is not connected");
    const payload = delivery.payload;
    const content = typeof payload === "string"
      ? payload
      : payload && typeof payload === "object" && "content" in payload && typeof payload.content === "string"
        ? payload.content
        : undefined;
    if (!content) throw new Error("Repair delivery has no message content");
    const channel = await this.client.channels.fetch(repairCase.threadId);
    if (!channel?.isTextBased() || !("send" in channel)) throw new Error("Repair thread is unavailable");
    if (channel.isThread() && channel.archived && !channel.locked) await channel.setArchived(false, "Repair work resumed");
    const sent = await channel.send({ content: truncateDiscord(content), allowedMentions: { parse: [] } });
    this.repairCases?.addMessage(repairCase.id, { role: "assistant", content: truncateDiscord(content), sourceMessageId: sent.id });
  }

  private findActiveCase(guildId: string, threadId: string): RepairCase | undefined {
    if (!this.repairCases) return undefined;
    const active: RepairCaseStatus[] = ["working", "waiting", "ready", "verifying", "needs_input", "blocked"];
    return this.repairCases.list({ guildId, threadId, statuses: active, limit: 1 })[0];
  }

  private async handleRepairCaseMessage(message: Message, content: string, existingCase?: RepairCase): Promise<void> {
    if (!this.repairCases || !this.repairCaseService) return;
    if (this.processingMessageIds.has(message.id) || this.conversations.hasMessageId(message.id)) return;
    this.processingMessageIds.add(message.id);
    const roles = message.member?.roles.cache.map((role) => role.id) ?? [];
    try {
      if (existingCase) {
        this.repairCases.setAuthorizationActor(existingCase.id, message.author.id);
        this.repairCaseService.notifyNewMessage(existingCase.id, {
          content,
          sourceMessageId: message.id,
          createdAt: message.createdAt,
          metadata: { userId: message.author.id, roles },
        });
        this.conversations.recordProcessedMessage(message.id);
        return;
      }

      let threadId = message.channelId;
      let sendAcknowledgement: (content: string) => Promise<{ id: string }>;
      if (message.guildId) {
        const thread = message.channel.isThread()
          ? message.channel
          : await message.startThread({
              name: repairThreadName(content),
              autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
              reason: "Plex Repairman issue thread",
            });
        threadId = thread.id;
        sendAcknowledgement = async (value) => thread.send({ content: value, allowedMentions: { parse: [] } });
      } else {
        if (!("send" in message.channel)) throw new Error("Discord channel cannot receive repair updates");
        const channel = message.channel;
        sendAcknowledgement = async (value) => channel.send({ content: value, allowedMentions: { parse: [] } });
      }
      const repairCase = this.repairCases.create({
        guildId: message.guildId ?? "",
        threadId,
        source: message.id,
        userId: message.author.id,
        authorizationActor: message.author.id,
        title: repairThreadName(content),
        objective: content,
      });
      const acknowledgement = "I’m looking into this now. I’ll keep this thread updated and continue automatically if anything needs time to finish.";
      const sent = await sendAcknowledgement(acknowledgement);
      this.repairCases.addMessage(repairCase.id, { role: "assistant", content: acknowledgement, sourceMessageId: sent.id });
      this.repairCases.addActivity(repairCase.id, "user_update", { message: acknowledgement }, "discord");
      this.repairCaseService.notifyNewMessage(repairCase.id, {
        content,
        sourceMessageId: message.id,
        createdAt: message.createdAt,
        metadata: { userId: message.author.id, roles },
      });
      this.conversations.recordProcessedMessage(message.id);
    } catch (error) {
      this.logger.error({ err: error, messageId: message.id }, "Failed to start or update repair case");
      await message.reply({ content: "I couldn't start that repair. Please check my thread permissions and try again.", allowedMentions: { parse: [], repliedUser: false } });
    } finally {
      this.processingMessageIds.delete(message.id);
    }
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

function repairThreadName(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return (normalized || "Media repair").slice(0, 90);
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

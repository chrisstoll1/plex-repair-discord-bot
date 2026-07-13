import { Client, Events, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, ThreadAutoArchiveDuration } from "discord.js";
import type { Message } from "discord.js";
import type { Logger } from "pino";
import { csvToSet, readRuntimeSettings } from "../domain/settings.js";
import type { SettingsStore } from "../storage/settings.js";
import type { ConversationStore } from "../storage/conversation.js";
import type { RepairCaseService } from "../agent/repair-case-service.js";
import type { RepairCase, RepairCaseOutboxItem, RepairCaseStatus, RepairCaseStore } from "../storage/repair-cases.js";

export class DiscordBotService {
  private client: Client | undefined;
  private readonly processingMessageIds = new Set<string>();
  private readonly repairIndicators = new Map<string, RepairIndicators>();
  private readonly repairMessageQueue = new KeyedSerialQueue();
  private repairCaseService?: RepairCaseService;

  constructor(
    private readonly store: SettingsStore,
    private readonly conversations: ConversationStore,
    private readonly logger: Logger,
    private readonly repairCases?: RepairCaseStore,
    private readonly generateRepairTitle?: (request: string) => Promise<string>,
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
      const existingCase = this.findRepairCase(message.guildId ?? "", message.channelId);

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


      if (!this.repairCases || !this.repairCaseService) {
        this.logger.error("Repair case service is not initialized");
        await message.reply({ content: "I couldn't start that repair. Please try again shortly.", allowedMentions: { parse: [], repliedUser: false } });
        return;
      }
      const repairKey = `${message.guildId ?? "dm"}:${message.channelId}`;
      await this.repairMessageQueue.run(repairKey, async () => {
        await this.handleRepairCaseMessage(message, content, this.findRepairCase(message.guildId ?? "", message.channelId));
      });
      return;
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
    for (const indicators of this.repairIndicators.values()) indicators.stop();
    this.repairIndicators.clear();
    if (this.client) {
      await this.client.destroy();
      this.client = undefined;
    }
    await this.start();
  }

  async stop(): Promise<void> {
    for (const indicators of this.repairIndicators.values()) indicators.stop();
    this.repairIndicators.clear();
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
    await this.settleRepairIndicators(repairCase);
  }

  async startRepairCaseActivity(repairCase: RepairCase): Promise<void> {
    if (!this.client || this.repairIndicators.has(repairCase.id)) return;
    const channel = await this.client.channels.fetch(repairCase.threadId);
    if (!channel?.isTextBased()) return;
    let sourceMessage: Message | undefined;
    if (channel.isThread()) {
      sourceMessage = await channel.fetchStarterMessage() ?? undefined;
    } else if ("messages" in channel) {
      sourceMessage = await channel.messages.fetch(repairCase.source).catch(() => undefined);
    }
    if (!sourceMessage) return;
    await this.startRepairIndicators(repairCase.id, sourceMessage, channel);
  }

  async stopRepairCaseActivity(caseId: string, emoji = "⛔"): Promise<void> {
    const indicators = this.repairIndicators.get(caseId);
    if (!indicators) return;
    indicators.stop();
    this.repairIndicators.delete(caseId);
    await indicators.reactions.set(emoji);
  }

  private findRepairCase(guildId: string, threadId: string): RepairCase | undefined {
    if (!this.repairCases) return undefined;
    return this.repairCases.list({ guildId, threadId, limit: 1 })[0];
  }

  private async handleRepairCaseMessage(message: Message, content: string, existingCase?: RepairCase): Promise<void> {
    if (!this.repairCases || !this.repairCaseService) return;
    if (this.processingMessageIds.has(message.id) || this.conversations.hasMessageId(message.id)) return;
    this.processingMessageIds.add(message.id);
    const roles = message.member?.roles.cache.map((role) => role.id) ?? [];
    try {
      if (existingCase) {
        this.repairCases.setAuthorizationActor(existingCase.id, message.author.id);
        await this.startRepairCaseActivity(existingCase);
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
      const title = await this.createRepairTitle(content);
      if (message.guildId) {
        const thread = message.channel.isThread()
          ? message.channel
          : await message.startThread({
              name: title,
              autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
              reason: "Plex Repairman issue thread",
            });
        threadId = thread.id;
      }
      const created = this.repairCases.createOrGetByThread({
        guildId: message.guildId ?? "",
        threadId,
        source: message.id,
        userId: message.author.id,
        authorizationActor: message.author.id,
        title,
        objective: content,
      });
      const repairCase = created.repairCase;
      if (!created.created) {
        this.repairCases.setAuthorizationActor(repairCase.id, message.author.id);
        await this.startRepairCaseActivity(repairCase);
        this.repairCaseService.notifyNewMessage(repairCase.id, {
          content,
          sourceMessageId: message.id,
          createdAt: message.createdAt,
          metadata: { userId: message.author.id, roles },
        });
        this.conversations.recordProcessedMessage(message.id);
        return;
      }
      const targetChannel = message.guildId ? await message.client.channels.fetch(threadId) : message.channel;
      await this.startRepairIndicators(repairCase.id, message, targetChannel?.isTextBased() ? targetChannel : message.channel);
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

  private async startRepairIndicators(caseId: string, message: Message, typingChannel: Message["channel"]): Promise<void> {
    this.repairIndicators.get(caseId)?.stop();
    const reactions = new MessageReactionTracker(message, readRuntimeSettings(this.store).discord.reactionsEnabled, this.logger);
    await reactions.reset(selectInitialReaction(message.content));
    const typing = startTypingRefreshForChannel(typingChannel, this.logger, message.id);
    const progress = startReactionProgress(reactions, message.content);
    this.repairIndicators.set(caseId, {
      reactions,
      stop: () => {
        typing.stop();
        progress.stop();
      },
    });
  }

  private async createRepairTitle(content: string): Promise<string> {
    try {
      const generated = await this.generateRepairTitle?.(content);
      if (generated?.trim()) return generated.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 70);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to generate repair thread title");
    }
    return "Media repair";
  }

  private async settleRepairIndicators(repairCase: RepairCase): Promise<void> {
    if (["working", "ready", "verifying"].includes(repairCase.status)) return;
    const indicators = this.repairIndicators.get(repairCase.id);
    if (!indicators) return;
    indicators.stop();
    this.repairIndicators.delete(repairCase.id);
    const emoji = repairCase.status === "resolved"
      ? "✅"
      : repairCase.status === "waiting"
        ? "⏳"
        : repairCase.status === "cancelled"
          ? "⛔"
          : "⚠️";
    await indicators.reactions.set(emoji);
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

type RepairIndicators = {
  reactions: MessageReactionTracker;
  stop: () => void;
};

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

  async reset(emoji: string): Promise<void> {
    if (!this.enabled) return;
    this.chain = this.chain
      .then(async () => {
        const botUserId = this.message.client.user?.id;
        if (botUserId) {
          for (const reaction of this.message.reactions.cache.values()) {
            if (reaction.me) await reaction.users.remove(botUserId);
          }
        }
        this.currentEmoji = undefined;
        await this.apply(emoji);
      })
      .catch((error) => {
        this.logger.debug({ err: error, messageId: this.message.id, emoji }, "Failed to reset Discord reaction");
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

function startTypingRefreshForChannel(channel: Message["channel"], logger: Logger, contextId: string): { stop: () => void } {
  let stopped = false;

  const send = async () => {
    try {
      if (!canSendTyping(channel)) return;
      await channel.sendTyping();
    } catch (error) {
      logger.debug({ err: error, contextId }, "Failed to refresh Discord typing indicator");
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

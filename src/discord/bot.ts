import crypto from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, ComponentType, Events, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, ThreadAutoArchiveDuration } from "discord.js";
import type { ButtonInteraction, Message } from "discord.js";
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

  async requestRepairConfirmation(repairCase: RepairCase, userId: string, summary: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.client || signal?.aborted) return false;
    const channel = await this.client.channels.fetch(repairCase.threadId);
    if (signal?.aborted || !channel?.isTextBased() || !("send" in channel)) return false;
    const token = crypto.randomUUID();
    const sent = await channel.send({
      content: `${summary}\n\nWould you like me to do this? This approval expires in 5 minutes.`,
      components: [confirmationControls(token, false)],
      allowedMentions: { parse: [] },
    });
    if (signal?.aborted) {
      const resultContent = `${summary}\n\nThis repair changed or stopped, so the approval was cancelled.`;
      await sent.edit({ content: resultContent, components: [confirmationControls(token, true)] }).catch(() => undefined);
      this.repairCases?.addMessage(repairCase.id, { role: "assistant", content: resultContent, sourceMessageId: sent.id });
      return false;
    }
    const collector = sent.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 5 * 60_000,
        filter: (candidate) => candidate.user.id === userId && candidate.customId.endsWith(token),
        max: 1,
      });
    const abort = () => collector.stop("aborted");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const interaction = await new Promise<ButtonInteraction | undefined>((resolve) => {
        collector.once("collect", resolve);
        collector.once("end", (collected) => { if (collected.size === 0) resolve(undefined); });
      });
      if (!interaction) throw new Error(signal?.aborted ? "aborted" : "expired");
      if (signal?.aborted) throw new Error("aborted");
      const approved = interaction.customId.startsWith("repair-confirm:");
      const resultContent = `${summary}\n\n${approved ? "Approved. I’ll continue with this repair." : "Cancelled. I didn’t make that change."}`;
      await interaction.update({
        content: resultContent,
        components: [confirmationControls(token, true)],
      });
      this.repairCases?.addMessage(repairCase.id, { role: "assistant", content: resultContent, sourceMessageId: sent.id });
      return approved;
    } catch {
      const resultContent = `${summary}\n\n${signal?.aborted ? "This repair changed or stopped, so the approval was cancelled." : "Approval expired. I didn’t make that change."}`;
      await sent.edit({ content: resultContent, components: [confirmationControls(token, true)] }).catch(() => undefined);
      this.repairCases?.addMessage(repairCase.id, { role: "assistant", content: resultContent, sourceMessageId: sent.id });
      return false;
    } finally {
      signal?.removeEventListener("abort", abort);
      collector.stop("settled");
    }
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
    const sent = await channel.send({
      content: truncateDiscord(content),
      allowedMentions: { parse: [] },
      nonce: `repair-${delivery.id}`,
      enforceNonce: true,
    });
    this.repairCases?.addMessage(repairCase.id, { role: "assistant", content: truncateDiscord(content), sourceMessageId: sent.id });
    await this.settleRepairIndicators(repairCase);
  }

  async startRepairCaseActivity(repairCase: RepairCase): Promise<void> {
    if (!this.client) return;
    const channel = await this.client.channels.fetch(repairCase.threadId);
    if (!channel?.isTextBased()) return;
    const existing = this.repairIndicators.get(repairCase.id);
    if (existing) {
      existing.resume(channel);
      return;
    }
    let sourceMessage: Message | undefined;
    const latestUserMessageId = [...(this.repairCases?.listMessages(repairCase.id) ?? [])]
      .reverse().find((message) => message.role === "user" && message.sourceMessageId)?.sourceMessageId;
    if (latestUserMessageId && "messages" in channel) {
      sourceMessage = await channel.messages.fetch(latestUserMessageId).catch(() => undefined);
    }
    if (!sourceMessage && channel.isThread()) {
      sourceMessage = await channel.fetchStarterMessage() ?? undefined;
    } else if (!sourceMessage && "messages" in channel) {
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
        if (isCancellationRequest(content)) {
          const cancelled = this.repairCaseService.cancel(existingCase.id, `message:${message.id}`);
          if (cancelled?.status === "cancelled") {
            this.repairCases.addMessage(existingCase.id, { role: "user", content, sourceMessageId: message.id, createdAt: message.createdAt, metadata: { userId: message.author.id, roles } });
            this.repairCases.enqueueDelivery(existingCase.id, "discord_message", { content: "I’ve stopped this repair. Any download already running in another service may continue there." }, { dedupeKey: `${existingCase.id}:cancel:${message.id}` });
            this.repairCaseService.refreshScheduling();
            this.conversations.recordProcessedMessage(message.id);
            return;
          }
          await message.reply({ content: "This repair is not currently running, so there’s nothing to stop.", allowedMentions: { parse: [], repliedUser: false } });
          this.conversations.recordProcessedMessage(message.id);
          return;
        }
        await this.startRepairIndicators(existingCase.id, message, message.channel);
        this.repairCaseService.notifyNewMessage(existingCase.id, {
          content,
          sourceMessageId: message.id,
          createdAt: message.createdAt,
          metadata: { userId: message.author.id, roles },
        });
        this.conversations.recordProcessedMessage(message.id);
        if (/^(?:media repair|general media help request)$/i.test(existingCase.title) || existingCase.title === provisionalRepairTitle(existingCase.objective)) {
          void this.refineRepairTitle(existingCase, content);
        }
        return;
      }

      let threadId = message.channelId;
      const title = provisionalRepairTitle(content);
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
      void this.refineRepairTitle(repairCase, content);
    } catch (error) {
      this.logger.error({ err: error, messageId: message.id }, "Failed to start or update repair case");
      await message.reply({ content: "I couldn't start that repair. Please check my thread permissions and try again.", allowedMentions: { parse: [], repliedUser: false } });
    } finally {
      this.processingMessageIds.delete(message.id);
    }
  }

  private async startRepairIndicators(caseId: string, message: Message, typingChannel: Message["channel"]): Promise<void> {
    const previous = this.repairIndicators.get(caseId);
    previous?.stop();
    await previous?.reactions.clear();
    const reactions = new MessageReactionTracker(message, readRuntimeSettings(this.store).discord.reactionsEnabled, this.logger);
    await reactions.reset("👀");
    let typing = startTypingRefreshForChannel(typingChannel, this.logger, message.id);
    let typingActive = true;
    this.repairIndicators.set(caseId, {
      reactions,
      stop: () => {
        if (!typingActive) return;
        typing.stop();
        typingActive = false;
      },
      resume: (channel) => {
        if (typingActive) return;
        typing = startTypingRefreshForChannel(channel, this.logger, message.id);
        typingActive = true;
      },
    });
  }

  async setRepairCaseStage(caseId: string, stage: "diagnosing" | "repairing" | "waiting" | "resolved" | "needs_input" | "blocked" | "cancelled"): Promise<void> {
    const indicators = this.repairIndicators.get(caseId);
    if (!indicators) return;
    const emoji = { diagnosing: "🔎", repairing: "🛠️", waiting: "⏳", resolved: "✅", needs_input: "❓", blocked: "⚠️", cancelled: "⛔" }[stage];
    await indicators.reactions.set(emoji);
  }

  private async refineRepairTitle(repairCase: RepairCase, content: string): Promise<void> {
    const title = await this.createRepairTitle(content);
    if (title === "Media repair" || title === repairCase.title) return;
    if (this.repairCases?.get(repairCase.id)?.title !== repairCase.title) return;
    const channel = await this.client?.channels.fetch(repairCase.threadId).catch(() => undefined);
    if (channel?.isThread()) {
      const renamed = await channel.setName(title, "Refined Plex Repairman issue title").then(() => true).catch((error) => {
        this.logger.debug({ err: error, caseId: repairCase.id }, "Failed to refine repair thread title");
        return false;
      });
      if (!renamed) return;
    }
    this.repairCases?.setTitle(repairCase.id, title);
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
    const emoji = repairCase.status === "resolved"
      ? "✅"
      : repairCase.status === "waiting"
        ? "⏳"
        : repairCase.status === "needs_input"
          ? "❓"
          : repairCase.status === "cancelled"
          ? "⛔"
          : "⚠️";
    await indicators.reactions.set(emoji);
    if (["resolved", "exhausted", "cancelled"].includes(repairCase.status)
      && this.repairIndicators.get(repairCase.id) === indicators) {
      this.repairIndicators.delete(repairCase.id);
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

type RepairIndicators = {
  reactions: MessageReactionTracker;
  stop: () => void;
  resume: (channel: Message["channel"]) => void;
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

  async clear(): Promise<void> {
    if (!this.enabled || !this.currentEmoji) return;
    const emoji = this.currentEmoji;
    this.chain = this.chain.then(async () => {
      const existing = this.message.reactions.cache.get(emoji);
      const botUserId = this.message.client.user?.id;
      if (botUserId) await existing?.users.remove(botUserId);
      this.currentEmoji = undefined;
    }).catch((error) => this.logger.debug({ err: error, messageId: this.message.id, emoji }, "Failed to clear Discord reaction"));
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

function provisionalRepairTitle(content: string): string {
  const cleaned = content.replace(/[^a-zA-Z0-9 '\-:]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 70) || "Media repair";
}

function isCancellationRequest(content: string): boolean {
  return /^(?:please\s+)?(?:stop|cancel|never\s*mind|nevermind|don'?t\s+continue)(?:\s+(?:this|the)\s+repair)?[.!\s]*$/i.test(content.trim());
}

function confirmationControls(token: string, disabled: boolean) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`repair-confirm:${token}`).setLabel("Confirm").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`repair-cancel:${token}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

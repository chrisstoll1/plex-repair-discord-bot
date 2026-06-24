import { Client, Events, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } from "discord.js";
import type { Logger } from "pino";
import { csvToSet, readRuntimeSettings } from "../domain/settings.js";
import type { SettingsStore } from "../storage/settings.js";
import type { PiAgentService } from "../agent/pi-agent.js";

export class DiscordBotService {
  private client: Client | undefined;

  constructor(
    private readonly store: SettingsStore,
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
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
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
      if (!message.mentions.has(client.user)) return;

      const latest = readRuntimeSettings(this.store);
      if (!isAllowed(message.guildId, csvToSet(latest.discord.allowedGuildIds))) return;
      if (!isAllowed(message.channelId, csvToSet(latest.discord.allowedChannelIds))) return;

      const content = message.content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
      if (!content) {
        await message.reply("Tell me what media issue to check, e.g. `@Plex Repairman why is Dune missing?`");
        return;
      }

      await message.channel.sendTyping();

      try {
        const roles = message.member?.roles.cache.map((role) => role.id) ?? [];
        const response = await this.agent.runDiscordRequest(content, {
          guildId: message.guildId ?? undefined,
          channelId: message.channelId,
          userId: message.author.id,
          roles,
        });

        await message.reply(truncateDiscord(response));
      } catch (error) {
        this.logger.error({ err: error }, "Failed to process Discord mention");
        await message.reply(`I hit an error while processing that request: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    await client.login(settings.discord.token);
    this.client = client;
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

function isAllowed(value: string | null, allowed: Set<string>): boolean {
  return allowed.size === 0 || (value !== null && allowed.has(value));
}

function truncateDiscord(value: string): string {
  if (value.length <= 1900) return value;
  return `${value.slice(0, 1880)}\n...`;
}

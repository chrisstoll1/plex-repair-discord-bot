import { z } from "zod";
import type { SettingsStore } from "../storage/settings.js";

export const discordSettingsSchema = z.object({
  token: z.string().min(1).optional().or(z.literal("")),
  applicationId: z.string().min(1).optional().or(z.literal("")),
  allowedGuildIds: z.string().default(""),
  allowedChannelIds: z.string().default(""),
  repairRoleIds: z.string().default(""),
  allowDirectMessages: z.boolean().default(false),
  reactionsEnabled: z.boolean().default(true),
});

export const arrSettingsSchema = z.object({
  url: z.string().url().optional().or(z.literal("")),
  apiKey: z.string().min(1).optional().or(z.literal("")),
});

export const plexSettingsSchema = z.object({
  url: z.string().url().optional().or(z.literal("")),
  token: z.string().min(1).optional().or(z.literal("")),
});

export const aiSettingsSchema = z.object({
  provider: z.string().default("openai-codex"),
  modelProvider: z.string().default("openai-codex"),
  modelId: z.string().default(""),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).default("medium"),
});

export const memorySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  scope: z.enum(["channel_user", "channel"]).default("channel_user"),
  maxMessages: z.coerce.number().int().min(0).max(50).default(10),
  ttlHours: z.coerce.number().int().min(1).max(720).default(24),
  includeBotReplies: z.boolean().default(true),
});

export const timeoutSettingsSchema = z.object({
  standardSeconds: z.coerce.number().int().min(5).max(600).default(60),
  releaseLookupSeconds: z.coerce.number().int().min(15).max(900).default(300),
});

export type DiscordSettings = z.infer<typeof discordSettingsSchema>;
export type ArrSettings = z.infer<typeof arrSettingsSchema>;
export type PlexSettings = z.infer<typeof plexSettingsSchema>;
export type AiSettings = z.infer<typeof aiSettingsSchema>;
export type MemorySettings = z.infer<typeof memorySettingsSchema>;
export type TimeoutSettings = z.infer<typeof timeoutSettingsSchema>;

export type RuntimeSettings = {
  discord: DiscordSettings;
  sonarr: ArrSettings;
  radarr: ArrSettings;
  plex: PlexSettings;
  ai: AiSettings;
  memory: MemorySettings;
  timeouts: TimeoutSettings;
  repair: {
    requireConfirmation: boolean;
    allowDestructive: boolean;
  };
};

export function readRuntimeSettings(store: SettingsStore): RuntimeSettings {
  return {
    discord: {
      token: store.getString("discord.token") ?? "",
      applicationId: store.getString("discord.applicationId") ?? "",
      allowedGuildIds: store.getString("discord.allowedGuildIds") ?? "",
      allowedChannelIds: store.getString("discord.allowedChannelIds") ?? "",
      repairRoleIds: store.getString("discord.repairRoleIds") ?? "",
      allowDirectMessages: store.getString("discord.allowDirectMessages") === "true",
      reactionsEnabled: store.getString("discord.reactionsEnabled") !== "false",
    },
    sonarr: {
      url: store.getString("sonarr.url") ?? "",
      apiKey: store.getString("sonarr.apiKey") ?? "",
    },
    radarr: {
      url: store.getString("radarr.url") ?? "",
      apiKey: store.getString("radarr.apiKey") ?? "",
    },
    plex: {
      url: store.getString("plex.url") ?? "",
      token: store.getString("plex.token") ?? "",
    },
    ai: store.getJson("ai", aiSettingsSchema.parse({})),
    memory: memorySettingsSchema.parse(
      store.getJson("memory", {
        enabled: true,
        scope: "channel_user",
        maxMessages: 10,
        ttlHours: 24,
        includeBotReplies: true,
      }),
    ),
    timeouts: timeoutSettingsSchema.parse(
      store.getJson("timeouts", {
        standardSeconds: 60,
        releaseLookupSeconds: 300,
      }),
    ),
    repair: store.getJson("repair", {
      requireConfirmation: true,
      allowDestructive: false,
    }),
  };
}

export function csvToSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

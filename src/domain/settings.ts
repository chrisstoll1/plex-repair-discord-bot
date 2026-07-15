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
  serviceTier: z.enum(["default", "priority"]).default("default"),
});

export const timeoutSettingsSchema = z.object({
  standardSeconds: z.coerce.number().int().min(5).max(600).default(60),
  releaseLookupSeconds: z.coerce.number().int().min(15).max(900).default(300),
});

export const repairSettingsSchema = z.object({
  requireConfirmation: z.boolean().default(true),
  allowDestructive: z.boolean().default(false),
});

export type DiscordSettings = z.infer<typeof discordSettingsSchema>;
export type ArrSettings = z.infer<typeof arrSettingsSchema>;
export type PlexSettings = z.infer<typeof plexSettingsSchema>;
export type AiSettings = z.infer<typeof aiSettingsSchema>;
export type TimeoutSettings = z.infer<typeof timeoutSettingsSchema>;
export type RepairSettings = z.infer<typeof repairSettingsSchema>;

export type RuntimeSettings = {
  discord: DiscordSettings;
  sonarr: ArrSettings;
  radarr: ArrSettings;
  plex: PlexSettings;
  ai: AiSettings;
  timeouts: TimeoutSettings;
  repair: RepairSettings;
};

const DEFAULT_AI_SETTINGS = aiSettingsSchema.parse({});
const DEFAULT_TIMEOUT_SETTINGS = timeoutSettingsSchema.parse({});
const DEFAULT_REPAIR_SETTINGS = repairSettingsSchema.parse({});

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
    ai: readJsonSetting(store, "ai", aiSettingsSchema, DEFAULT_AI_SETTINGS),
    timeouts: readJsonSetting(store, "timeouts", timeoutSettingsSchema, DEFAULT_TIMEOUT_SETTINGS),
    repair: readJsonSetting(store, "repair", repairSettingsSchema, DEFAULT_REPAIR_SETTINGS),
  };
}

function readJsonSetting<T>(store: SettingsStore, key: string, schema: z.ZodType<T>, fallback: T): T {
  const parsed = schema.safeParse(store.getJson(key, fallback));
  return parsed.success ? parsed.data : fallback;
}

export function csvToSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

import { z } from "zod";

const optionalUrl = z.string().trim().refine((value) => !value || z.url().safeParse(value).success, "Enter a valid URL including http:// or https://");
const secret = z.object({ configured: z.boolean(), value: z.string().optional(), clear: z.boolean().optional() });

export const settingsSchema = z.object({
  discord: z.object({
    token: secret,
    applicationId: z.string().trim(),
    allowedGuildIds: z.string(),
    allowedChannelIds: z.string(),
    repairRoleIds: z.string(),
    allowDirectMessages: z.boolean(),
    reactionsEnabled: z.boolean(),
  }),
  sonarr: z.object({ url: optionalUrl, apiKey: secret }),
  radarr: z.object({ url: optionalUrl, apiKey: secret }),
  plex: z.object({ url: optionalUrl, token: secret }),
  ai: z.object({
    modelProvider: z.string().min(1, "Model provider is required"),
    modelId: z.string(),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
  }),
  memory: z.object({
    enabled: z.boolean(),
    scope: z.enum(["channel_user", "channel"]),
    maxMessages: z.number().int().min(0).max(50),
    ttlHours: z.number().int().min(1).max(720),
    includeBotReplies: z.boolean(),
  }),
  timeouts: z.object({
    standardSeconds: z.number().int().min(5).max(600),
    releaseLookupSeconds: z.number().int().min(15).max(900),
  }),
  repair: z.object({ requireConfirmation: z.boolean(), allowDestructive: z.boolean() }),
});

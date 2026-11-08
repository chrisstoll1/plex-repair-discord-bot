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
  seerr: z.object({ url: optionalUrl, apiKey: secret, preferForRequests: z.boolean(), defaultUserId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), userMappings: z.string().max(20000).refine((value) => {
    const entries = value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
    const keys = entries.map((item) => item.split(":")[0]?.trim());
    return entries.every((item) => /^\d{15,22}\s*:\s*[1-9]\d*$/.test(item) && Number.isSafeInteger(Number(item.split(":")[1]))) && new Set(keys).size === keys.length;
  }, "Use unique DiscordID:SeerrUserID pairs, separated by commas or new lines") }),
  ai: z.object({
    modelProvider: z.string().min(1, "Model provider is required"),
    modelId: z.string(),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
    serviceTier: z.enum(["default", "priority"]),
  }),
  timeouts: z.object({
    standardSeconds: z.number().int().min(5).max(600),
    releaseLookupSeconds: z.number().int().min(15).max(900),
  }),
  repair: z.object({ requireConfirmation: z.boolean(), allowDestructive: z.boolean(), allowDirectAdd: z.boolean() }),
});

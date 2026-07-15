import { describe, expect, it } from "vitest";
import { settingsSchema } from "./schemas";

const settings = {
  discord: { token: { configured: true }, applicationId: "123", allowedGuildIds: "", allowedChannelIds: "", repairRoleIds: "", allowDirectMessages: false, reactionsEnabled: true },
  sonarr: { url: "http://sonarr.local:8989", apiKey: { configured: true } },
  radarr: { url: "", apiKey: { configured: false } },
  plex: { url: "http://plex.local:32400", token: { configured: true } },
  ai: { provider: "openai-codex", modelProvider: "openai-codex", modelId: "gpt-5.6-sol", thinkingLevel: "medium", serviceTier: "default" },
  timeouts: { standardSeconds: 60, releaseLookupSeconds: 300 },
  repair: { requireConfirmation: true, allowDestructive: false },
} as const;

describe("settingsSchema", () => {
  it("accepts a complete settings payload", () => expect(settingsSchema.safeParse(settings).success).toBe(true));
  it("rejects unsafe endpoint and timeout values", () => {
    const result = settingsSchema.safeParse({ ...settings, sonarr: { ...settings.sonarr, url: "sonarr.local" }, timeouts: { ...settings.timeouts, standardSeconds: 1 } });
    expect(result.success).toBe(false);
  });
});

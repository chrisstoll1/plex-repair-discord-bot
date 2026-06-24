import Fastify from "fastify";
import type { Logger } from "pino";
import { aiSettingsSchema, readRuntimeSettings } from "../domain/settings.js";
import { createMediaClients } from "../services/service-factory.js";
import type { SettingsStore } from "../storage/settings.js";
import type { DiscordBotService } from "../discord/bot.js";
import type { PiAuthService } from "../agent/pi-auth.js";
import { dashboard, escapeHtml, layout, piAuthPage, settingsPage } from "./templates.js";

export async function createWebServer(
  store: SettingsStore,
  discord: DiscordBotService,
  piAuth: PiAuthService,
  logger: Logger,
) {
  const app = Fastify({ loggerInstance: logger });

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.get("/", async (_request, reply) => {
    reply.type("text/html").send(dashboard(readRuntimeSettings(store), piAuth.getSnapshot().configured));
  });

  app.get("/settings", async (_request, reply) => {
    reply.type("text/html").send(settingsPage(readRuntimeSettings(store)));
  });

  app.post("/settings", async (request, reply) => {
    const body = request.body as Record<string, string | undefined>;

    setIfPresent(store, "discord.token", body.discordToken, true);
    setIfPresent(store, "discord.applicationId", body.discordApplicationId, false, true);
    setIfPresent(store, "discord.allowedGuildIds", body.discordAllowedGuildIds, false, true);
    setIfPresent(store, "discord.allowedChannelIds", body.discordAllowedChannelIds, false, true);
    setIfPresent(store, "discord.repairRoleIds", body.discordRepairRoleIds, false, true);
    store.setString("discord.allowDirectMessages", String(body.discordAllowDirectMessages === "true"));

    setIfPresent(store, "sonarr.url", body.sonarrUrl, false, true);
    setIfPresent(store, "sonarr.apiKey", body.sonarrApiKey, true);
    setIfPresent(store, "radarr.url", body.radarrUrl, false, true);
    setIfPresent(store, "radarr.apiKey", body.radarrApiKey, true);
    setIfPresent(store, "plex.url", body.plexUrl, false, true);
    setIfPresent(store, "plex.token", body.plexToken, true);

    const ai = aiSettingsSchema.parse({
      modelProvider: body.aiModelProvider,
      modelId: body.aiModelId,
      thinkingLevel: body.aiThinkingLevel,
    });
    store.setJson("ai", ai);
    store.setJson("repair", {
      requireConfirmation: body.repairRequireConfirmation === "true",
      allowDestructive: body.repairAllowDestructive === "true",
    });

    await discord.restart();
    reply.redirect("/settings");
  });

  app.get("/pi-auth", async (_request, reply) => {
    reply.type("text/html").send(piAuthPage(piAuth.getSnapshot()));
  });

  app.post("/pi-auth/start", async (_request, reply) => {
    piAuth.startLogin();
    reply.redirect("/pi-auth");
  });

  app.post("/pi-auth/cancel", async (_request, reply) => {
    piAuth.cancelLogin();
    reply.redirect("/pi-auth");
  });

  app.post("/pi-auth/logout", async (_request, reply) => {
    piAuth.logout();
    reply.redirect("/pi-auth");
  });

  app.get("/health", async (_request, reply) => {
    const clients = createMediaClients(store);
    const results: Record<string, unknown> = {};

    for (const [name, check] of Object.entries({
      sonarr: () => clients.sonarr.getSystemStatus(),
      radarr: () => clients.radarr.getSystemStatus(),
      plex: () => clients.plex.getIdentity(),
    })) {
      try {
        results[name] = await check();
      } catch (error) {
        results[name] = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    results.pi = piAuth.getSnapshot();

    reply.type("text/html").send(layout("Health", `<section class="panel"><pre>${escapeHtml(JSON.stringify(results, null, 2))}</pre></section>`));
  });

  return app;
}

function setIfPresent(store: SettingsStore, key: string, value: string | undefined, secret: boolean, allowEmpty = false): void {
  if (value === undefined) return;
  if (!allowEmpty && value.trim() === "") return;
  store.setString(key, value.trim(), { secret });
}

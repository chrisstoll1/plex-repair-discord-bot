import { readRuntimeSettings } from "../domain/settings.js";
import type { SettingsStore } from "../storage/settings.js";
import type { Logger } from "pino";
import { ArrClient } from "./arr-client.js";
import { PlexClient } from "./plex-client.js";

export function createMediaClients(store: SettingsStore, logger?: Logger) {
  const settings = readRuntimeSettings(store);

  return {
    sonarr: new ArrClient("sonarr", settings.sonarr, settings.timeouts, logger),
    radarr: new ArrClient("radarr", settings.radarr, settings.timeouts, logger),
    plex: new PlexClient(settings.plex, settings.timeouts.standardSeconds, logger),
  };
}

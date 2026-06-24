import { readRuntimeSettings } from "../domain/settings.js";
import type { SettingsStore } from "../storage/settings.js";
import { ArrClient } from "./arr-client.js";
import { PlexClient } from "./plex-client.js";

export function createMediaClients(store: SettingsStore) {
  const settings = readRuntimeSettings(store);

  return {
    sonarr: new ArrClient("sonarr", settings.sonarr),
    radarr: new ArrClient("radarr", settings.radarr),
    plex: new PlexClient(settings.plex),
  };
}

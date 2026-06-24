import pino from "pino";
import type { AppConfig } from "./config.js";

export function createLogger(config: AppConfig) {
  return pino({
    level: config.logLevel,
    redact: {
      paths: ["*.token", "*.apiKey", "*.password", "discord.token", "sonarr.apiKey", "radarr.apiKey", "plex.token"],
      censor: "[redacted]",
    },
  });
}

import pino from "pino";
import type { AppConfig } from "./config.js";

export function createLogger(config: AppConfig) {
  return pino({
    level: config.logLevel,
    redact: {
      paths: ["*.token", "*.apiKey", "*.password", "*.currentPassword", "*.newPassword", "req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']", "discord.token", "sonarr.apiKey", "radarr.apiKey", "plex.token"],
      censor: "[redacted]",
    },
  });
}

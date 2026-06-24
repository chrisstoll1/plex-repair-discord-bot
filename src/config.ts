import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  CONFIG_DIR: z.string().min(1).optional(),
  HTTP_HOST: z.string().min(1).default("0.0.0.0"),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().min(1).default("info"),
});

export type AppConfig = {
  configDir: string;
  httpHost: string;
  httpPort: number;
  logLevel: string;
  databasePath: string;
  secretsKeyPath: string;
  piAgentDir: string;
};

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);
  const configDir = path.resolve(parsed.CONFIG_DIR ?? path.join(process.cwd(), "config"));

  return {
    configDir,
    httpHost: parsed.HTTP_HOST,
    httpPort: parsed.HTTP_PORT,
    logLevel: parsed.LOG_LEVEL,
    databasePath: path.join(configDir, "plex-repairman.db"),
    secretsKeyPath: path.join(configDir, "secrets.key"),
    piAgentDir: path.join(configDir, "pi"),
  };
}

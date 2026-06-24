import fs from "node:fs";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AppConfig } from "../config.js";
import { readRuntimeSettings } from "../domain/settings.js";
import type { SettingsStore } from "../storage/settings.js";
import { createMediaClients } from "../services/service-factory.js";
import { REPAIRMAN_INSTRUCTIONS } from "./instructions.js";

export type AgentRequestContext = {
  guildId?: string;
  channelId: string;
  userId: string;
  roles: string[];
};

export class PiAgentService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: SettingsStore,
  ) {}

  async runDiscordRequest(message: string, context: AgentRequestContext): Promise<string> {
    fs.mkdirSync(this.config.piAgentDir, { recursive: true });

    const settings = readRuntimeSettings(this.store);
    const authStorage = AuthStorage.create(`${this.config.piAgentDir}/auth.json`);
    const modelRegistry = ModelRegistry.create(authStorage, `${this.config.piAgentDir}/models.json`);
    const model = settings.ai.modelId ? modelRegistry.find(settings.ai.modelProvider, settings.ai.modelId) : undefined;

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    });

    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: this.config.piAgentDir,
      settingsManager,
      systemPromptOverride: () => REPAIRMAN_INSTRUCTIONS,
    });
    await loader.reload();

    let output = "";
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir: this.config.piAgentDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: settings.ai.thinkingLevel,
      noTools: "builtin",
      customTools: this.createTools(),
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      resourceLoader: loader,
    });

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        output += event.assistantMessageEvent.delta;
      }
    });

    const prompt = [
      `Discord context: ${JSON.stringify(context)}`,
      `Repair policy: ${JSON.stringify(settings.repair)}`,
      `User request: ${message}`,
    ].join("\n\n");

    try {
      await session.prompt(prompt);
      return output.trim() || "I completed the request but did not produce a text response.";
    } finally {
      unsubscribe();
      session.dispose();
    }
  }

  private createTools() {
    const clients = () => createMediaClients(this.store);

    return [
      defineTool({
        name: "search_all_media",
        label: "Search Sonarr, Radarr, and Plex",
        description: "Search Sonarr, Radarr, and Plex for a media title. Use this before diagnosing where media is missing.",
        parameters: Type.Object({ query: Type.String({ description: "Movie or series title to search for" }) }),
        execute: async (_toolCallId, params: { query: string }) => {
          const media = clients();
          const results: Record<string, unknown> = {};

          for (const [name, search] of Object.entries({
            sonarr: () => media.sonarr.search(params.query),
            radarr: () => media.radarr.search(params.query),
            plex: () => media.plex.search(params.query),
          })) {
            try {
              results[name] = await search();
            } catch (error) {
              results[name] = { error: error instanceof Error ? error.message : String(error) };
            }
          }

          return {
            content: [{ type: "text", text: JSON.stringify(results).slice(0, 12000) }],
            details: results,
          };
        },
      }),
      defineTool({
        name: "get_service_health",
        label: "Get media service health",
        description: "Check whether Sonarr, Radarr, and Plex are reachable and return basic version/identity details.",
        parameters: Type.Object({}),
        execute: async () => {
          const media = clients();
          const results: Record<string, unknown> = {};

          for (const [name, health] of Object.entries({
            sonarr: () => media.sonarr.getSystemStatus(),
            radarr: () => media.radarr.getSystemStatus(),
            plex: () => media.plex.getIdentity(),
          })) {
            try {
              results[name] = await health();
            } catch (error) {
              results[name] = { error: error instanceof Error ? error.message : String(error) };
            }
          }

          return {
            content: [{ type: "text", text: JSON.stringify(results) }],
            details: results,
          };
        },
      }),
      defineTool({
        name: "request_confirmation",
        label: "Request repair confirmation",
        description: "Use this when a requested repair action needs explicit Discord confirmation before execution.",
        parameters: Type.Object({
          action: Type.String({ description: "The proposed repair action" }),
          reason: Type.String({ description: "Why this action is recommended" }),
        }),
        execute: async (_toolCallId, params: { action: string; reason: string }) => ({
          content: [
            {
              type: "text",
              text: `Confirmation required before running: ${params.action}\nReason: ${params.reason}`,
            },
          ],
          details: { confirmationRequired: true, ...params },
        }),
      }),
    ];
  }
}

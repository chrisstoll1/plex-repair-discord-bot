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
import { csvToSet, readRuntimeSettings } from "../domain/settings.js";
import type { RuntimeSettings } from "../domain/settings.js";
import type { ConversationMessage } from "../storage/conversation.js";
import type { SettingsStore } from "../storage/settings.js";
import { createMediaClients } from "../services/service-factory.js";
import { REPAIRMAN_INSTRUCTIONS } from "./instructions.js";

export type AgentRequestContext = {
  guildId?: string;
  channelId: string;
  userId: string;
  roles: string[];
  recentMessages?: ConversationMessage[];
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
      customTools: this.createTools(context),
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      resourceLoader: loader,
    });

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        output += event.assistantMessageEvent.delta;
      }
    });

    const { recentMessages, ...discordContext } = context;
    const prompt = [
      `Discord context: ${JSON.stringify(discordContext)}`,
      `Repair policy: ${JSON.stringify(settings.repair)}`,
      formatRecentMessages(recentMessages),
      `User request: ${message}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      await session.prompt(prompt);
      return output.trim() || "I completed the request but did not produce a text response.";
    } finally {
      unsubscribe();
      session.dispose();
    }
  }

  private createTools(context: AgentRequestContext) {
    const clients = () => createMediaClients(this.store);

    return [
      defineTool({
        name: "search_radarr_movies",
        label: "Search Radarr movies",
        description: "Search Radarr movie lookup for a movie title. Prefer this for movie, film, theatrical, and multi-language movie requests.",
        parameters: Type.Object({ query: Type.String({ description: "Movie title to search for" }) }),
        execute: async (_toolCallId, params: { query: string }) => {
          const results = await clients().radarr.search(params.query);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "search_sonarr_series",
        label: "Search Sonarr series",
        description: "Search Sonarr series lookup for a TV/anime series title. Prefer this for series, seasons, and episodes.",
        parameters: Type.Object({ query: Type.String({ description: "Series title to search for" }) }),
        execute: async (_toolCallId, params: { query: string }) => {
          const results = await clients().sonarr.search(params.query);
          return toolResponse(results);
        },
      }),
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

          return toolResponse(results);
        },
      }),
      defineTool({
        name: "list_plex_libraries",
        label: "List Plex libraries",
        description: "List Plex library sections and their IDs. Use this before refreshing a Plex library section.",
        parameters: Type.Object({}),
        execute: async () => {
          const results = await clients().plex.getLibrarySections();
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "get_radarr_movie_releases",
        label: "Get Radarr movie releases",
        description: "List available Radarr releases for an existing movie ID before selecting a release to grab.",
        parameters: Type.Object({ movieId: Type.Number({ description: "Radarr movie ID" }) }),
        execute: async (_toolCallId, params: { movieId: number }) => {
          const results = await clients().radarr.getMovieReleases(params.movieId);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "get_sonarr_episodes",
        label: "Get Sonarr episodes",
        description: "List Sonarr episodes for an existing series ID, optionally limited to a season. Use this to map SxxEyy requests to Sonarr episode IDs and episode file IDs.",
        parameters: Type.Object({
          seriesId: Type.Number({ description: "Sonarr series ID" }),
          seasonNumber: Type.Optional(Type.Number({ description: "Optional season number, use 0 for specials" })),
        }),
        execute: async (_toolCallId, params: { seriesId: number; seasonNumber?: number }) => {
          const results = await clients().sonarr.getEpisodes(params.seriesId, params.seasonNumber);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "get_sonarr_episode_file",
        label: "Get Sonarr episode file",
        description: "Inspect a Sonarr episode file by episodeFileId, including path, quality, media info, languages, and release details when Sonarr provides them.",
        parameters: Type.Object({ episodeFileId: Type.Number({ description: "Sonarr episode file ID" }) }),
        execute: async (_toolCallId, params: { episodeFileId: number }) => {
          const results = await clients().sonarr.getEpisodeFile(params.episodeFileId);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "get_sonarr_episode_releases",
        label: "Get Sonarr episode releases",
        description: "List available Sonarr releases for an existing episode ID before selecting a release to grab.",
        parameters: Type.Object({ episodeId: Type.Number({ description: "Sonarr episode ID" }) }),
        execute: async (_toolCallId, params: { episodeId: number }) => {
          const results = await clients().sonarr.getEpisodeReleases(params.episodeId);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "get_radarr_movie_files",
        label: "Get Radarr movie files",
        description: "List Radarr movie files for an existing movie ID. Use this before deleting/replacing a bad movie file.",
        parameters: Type.Object({ movieId: Type.Number({ description: "Radarr movie ID" }) }),
        execute: async (_toolCallId, params: { movieId: number }) => {
          const results = await clients().radarr.getMovieFiles(params.movieId);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "get_radarr_movie_file",
        label: "Get Radarr movie file",
        description: "Inspect a Radarr movie file by movieFileId, including path, quality, media info, languages, and release details when Radarr provides them.",
        parameters: Type.Object({ movieFileId: Type.Number({ description: "Radarr movie file ID" }) }),
        execute: async (_toolCallId, params: { movieFileId: number }) => {
          const results = await clients().radarr.getMovieFile(params.movieFileId);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "trigger_radarr_movie_search",
        label: "Trigger Radarr movie search",
        description: "Trigger Radarr to search indexers for an existing movie. Requires confirmation when the repair policy requires it.",
        parameters: Type.Object({
          movieId: Type.Number({ description: "Radarr movie ID" }),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: { movieId: number; confirmed?: boolean }) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Trigger Radarr search for movie ID ${params.movieId}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const results = await clients().radarr.triggerMovieSearch(params.movieId);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "refresh_plex_library_section",
        label: "Refresh Plex library section",
        description: "Trigger Plex to scan/refresh a specific library section by section ID. Requires confirmation when configured.",
        parameters: Type.Object({
          sectionId: Type.Number({ description: "Plex library section ID, from list_plex_libraries" }),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: { sectionId: number; confirmed?: boolean }) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Refresh Plex library section ID ${params.sectionId}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const results = await clients().plex.refreshLibrarySection(params.sectionId);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "trigger_sonarr_series_search",
        label: "Trigger Sonarr series search",
        description: "Trigger Sonarr to search indexers for an existing series. Requires confirmation when the repair policy requires it.",
        parameters: Type.Object({
          seriesId: Type.Number({ description: "Sonarr series ID" }),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: { seriesId: number; confirmed?: boolean }) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Trigger Sonarr search for series ID ${params.seriesId}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const results = await clients().sonarr.triggerSeriesSearch(params.seriesId);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "trigger_sonarr_season_search",
        label: "Trigger Sonarr season search",
        description: "Trigger Sonarr to search indexers for a specific season, including Season 0 specials. Requires confirmation when configured.",
        parameters: Type.Object({
          seriesId: Type.Number({ description: "Sonarr series ID" }),
          seasonNumber: Type.Number({ description: "Season number, use 0 for specials" }),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: { seriesId: number; seasonNumber: number; confirmed?: boolean }) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Trigger Sonarr search for series ID ${params.seriesId}, season ${params.seasonNumber}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const results = await clients().sonarr.triggerSeasonSearch(params.seriesId, params.seasonNumber);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "trigger_sonarr_episode_search",
        label: "Trigger Sonarr episode search",
        description: "Trigger Sonarr to search indexers for specific episode IDs. Requires confirmation when configured.",
        parameters: Type.Object({
          episodeIds: Type.Array(Type.Number(), { description: "Sonarr episode IDs" }),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: { episodeIds: number[]; confirmed?: boolean }) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Trigger Sonarr search for episode IDs ${params.episodeIds.join(", ")}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const results = await clients().sonarr.triggerEpisodeSearch(params.episodeIds);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "grab_radarr_release",
        label: "Grab Radarr release",
        description: "Tell Radarr to grab a specific release returned by get_radarr_movie_releases. Requires confirmation when configured.",
        parameters: Type.Object({
          guid: Type.String({ description: "Release guid from Radarr release results" }),
          indexerId: Type.Number({ description: "Indexer ID from Radarr release results" }),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: { guid: string; indexerId: number; confirmed?: boolean }) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Grab Radarr release ${params.guid} from indexer ${params.indexerId}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const results = await clients().radarr.grabRelease({ guid: params.guid, indexerId: params.indexerId });
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "grab_sonarr_release",
        label: "Grab Sonarr release",
        description: "Tell Sonarr to grab a specific release returned by get_sonarr_episode_releases. Requires confirmation when configured.",
        parameters: Type.Object({
          guid: Type.String({ description: "Release guid from Sonarr release results" }),
          indexerId: Type.Number({ description: "Indexer ID from Sonarr release results" }),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: { guid: string; indexerId: number; confirmed?: boolean }) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Grab Sonarr release ${params.guid} from indexer ${params.indexerId}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const results = await clients().sonarr.grabRelease({ guid: params.guid, indexerId: params.indexerId });
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "set_radarr_movie_monitored",
        label: "Set Radarr movie monitored",
        description: "Set an existing Radarr movie's monitored flag. Requires confirmation when configured.",
        parameters: Type.Object({
          movieId: Type.Number({ description: "Radarr movie ID" }),
          monitored: Type.Boolean({ description: "Desired monitored value" }),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: { movieId: number; monitored: boolean; confirmed?: boolean }) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Set Radarr movie ID ${params.movieId} monitored=${params.monitored}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const radarr = clients().radarr;
          const movie = withProperty(await radarr.getMovie(params.movieId), "monitored", params.monitored);
          const results = await radarr.updateMovie(movie);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "set_sonarr_series_monitored",
        label: "Set Sonarr series monitored",
        description: "Set an existing Sonarr series monitored flag. Requires confirmation when configured.",
        parameters: Type.Object({
          seriesId: Type.Number({ description: "Sonarr series ID" }),
          monitored: Type.Boolean({ description: "Desired monitored value" }),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: { seriesId: number; monitored: boolean; confirmed?: boolean }) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Set Sonarr series ID ${params.seriesId} monitored=${params.monitored}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const sonarr = clients().sonarr;
          const series = withProperty(await sonarr.getSeries(params.seriesId), "monitored", params.monitored);
          const results = await sonarr.updateSeries(series);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "set_sonarr_season_monitored",
        label: "Set Sonarr season monitored",
        description: "Set a specific Sonarr season monitored flag, including Season 0 specials. Requires confirmation when configured.",
        parameters: Type.Object({
          seriesId: Type.Number({ description: "Sonarr series ID" }),
          seasonNumber: Type.Number({ description: "Season number, use 0 for specials" }),
          monitored: Type.Boolean({ description: "Desired monitored value" }),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: { seriesId: number; seasonNumber: number; monitored: boolean; confirmed?: boolean }) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Set Sonarr series ID ${params.seriesId}, season ${params.seasonNumber} monitored=${params.monitored}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const sonarr = clients().sonarr;
          const series = setSeasonMonitored(await sonarr.getSeries(params.seriesId), params.seasonNumber, params.monitored);
          const results = await sonarr.updateSeries(series);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "delete_sonarr_episode_file",
        label: "Delete Sonarr episode file",
        description: "Delete only a specific Sonarr episode file from disk while keeping the series and episode in Sonarr. Use before searching for a replacement bad-audio episode. Requires confirmation when configured.",
        parameters: Type.Object({
          episodeFileId: Type.Number({ description: "Sonarr episode file ID to delete" }),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: { episodeFileId: number; confirmed?: boolean }) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Delete Sonarr episode file ID ${params.episodeFileId}`,
            confirmed: params.confirmed,
            destructive: true,
          });
          if (policy) return policy;

          const results = await clients().sonarr.removeEpisodeFile(params.episodeFileId);
          return toolResponse(results ?? { deleted: true });
        },
      }),
      defineTool({
        name: "delete_radarr_movie_file",
        label: "Delete Radarr movie file",
        description: "Delete only a specific Radarr movie file from disk while keeping the movie in Radarr. Use before searching for a replacement bad-audio movie. Requires confirmation when configured.",
        parameters: Type.Object({
          movieFileId: Type.Number({ description: "Radarr movie file ID to delete" }),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: { movieFileId: number; confirmed?: boolean }) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Delete Radarr movie file ID ${params.movieFileId}`,
            confirmed: params.confirmed,
            destructive: true,
          });
          if (policy) return policy;

          const results = await clients().radarr.removeMovieFile(params.movieFileId);
          return toolResponse(results ?? { deleted: true });
        },
      }),
      defineTool({
        name: "remove_radarr_movie",
        label: "Remove Radarr movie",
        description: "Remove a movie from Radarr. This is destructive when deleting files and requires destructive repairs to be enabled.",
        parameters: Type.Object({
          movieId: Type.Number({ description: "Radarr movie ID" }),
          deleteFiles: Type.Boolean({ description: "Whether Radarr should delete files from disk" }),
          addImportExclusion: Type.Optional(Type.Boolean({ description: "Whether to add a Radarr import exclusion" })),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: { movieId: number; deleteFiles: boolean; addImportExclusion?: boolean; confirmed?: boolean }) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Remove Radarr movie ID ${params.movieId}${params.deleteFiles ? " and delete files" : ""}`,
            confirmed: params.confirmed,
            destructive: true,
          });
          if (policy) return policy;

          const results = await clients().radarr.removeMovie(params.movieId, params.deleteFiles, params.addImportExclusion ?? false);
          return toolResponse(results ?? { removed: true });
        },
      }),
      defineTool({
        name: "remove_sonarr_series",
        label: "Remove Sonarr series",
        description: "Remove a series from Sonarr. This is destructive when deleting files and requires destructive repairs to be enabled.",
        parameters: Type.Object({
          seriesId: Type.Number({ description: "Sonarr series ID" }),
          deleteFiles: Type.Boolean({ description: "Whether Sonarr should delete files from disk" }),
          addImportListExclusion: Type.Optional(Type.Boolean({ description: "Whether to add a Sonarr import list exclusion" })),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: { seriesId: number; deleteFiles: boolean; addImportListExclusion?: boolean; confirmed?: boolean }) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Remove Sonarr series ID ${params.seriesId}${params.deleteFiles ? " and delete files" : ""}`,
            confirmed: params.confirmed,
            destructive: true,
          });
          if (policy) return policy;

          const results = await clients().sonarr.removeSeries(params.seriesId, params.deleteFiles, params.addImportListExclusion ?? false);
          return toolResponse(results ?? { removed: true });
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

          return toolResponse(results);
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

function formatRecentMessages(messages: ConversationMessage[] | undefined): string | undefined {
  if (!messages?.length) return undefined;

  const lines = messages.map((message) => {
    const speaker = message.role === "assistant" ? "Assistant" : `User${message.userId ? ` ${message.userId}` : ""}`;
    return `${speaker}: ${message.content.replace(/\s+/g, " ").slice(0, 1200)}`;
  });

  return `Recent conversation for context only. The newest user request is authoritative:\n${lines.join("\n")}`;
}

function toolResponse(results: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(results).slice(0, 12000) }],
    details: results,
  };
}

function authorizeRepair(
  settings: RuntimeSettings,
  context: AgentRequestContext,
  options: { action: string; confirmed?: boolean; destructive?: boolean },
) {
  const repairRoles = csvToSet(settings.discord.repairRoleIds);
  if (repairRoles.size > 0 && !context.roles.some((role) => repairRoles.has(role))) {
    return toolResponse({ blocked: true, reason: "User does not have an allowed repair role", action: options.action });
  }

  if (options.destructive && !settings.repair.allowDestructive) {
    return toolResponse({ blocked: true, reason: "Destructive repair actions are disabled by policy", action: options.action });
  }

  if (settings.repair.requireConfirmation && !options.confirmed) {
    return toolResponse({ confirmationRequired: true, action: options.action, reason: "Repair policy requires explicit confirmation" });
  }

  return undefined;
}

function withProperty(value: unknown, property: string, propertyValue: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Arr response was not an object");
  }

  return { ...value, [property]: propertyValue };
}

function setSeasonMonitored(value: unknown, seasonNumber: number, monitored: boolean): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Sonarr series response was not an object");
  }

  const seasons = value.seasons;
  if (!Array.isArray(seasons)) {
    throw new Error("Sonarr series response did not include seasons");
  }

  let found = false;
  const updatedSeasons = seasons.map((season) => {
    if (!isRecord(season) || season.seasonNumber !== seasonNumber) return season;
    found = true;
    return { ...season, monitored };
  });

  if (!found) {
    throw new Error(`Sonarr series does not include season ${seasonNumber}`);
  }

  return { ...value, seasons: updatedSeasons };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

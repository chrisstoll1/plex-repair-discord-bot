import fs from "node:fs";
import type { Logger } from "pino";
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

type RadarrMovieSettingsParams = {
  movieId: number;
  monitored?: boolean;
  qualityProfileId?: number;
  minimumAvailability?: string;
  rootFolderPath?: string;
  path?: string;
  moveFiles?: boolean;
  confirmed?: boolean;
};

type SonarrSeriesSettingsParams = {
  seriesId: number;
  monitored?: boolean;
  seriesType?: "standard" | "daily" | "anime";
  qualityProfileId?: number;
  languageProfileId?: number;
  metadataProfileId?: number;
  seasonFolder?: boolean;
  rootFolderPath?: string;
  path?: string;
  moveFiles?: boolean;
  confirmed?: boolean;
};

type QueueToolParams = {
  page?: number;
  pageSize?: number;
  itemId?: number;
  status?: string[];
};

type QueueDetailsToolParams = {
  itemId: number;
  episodeIds?: number[];
};

type QueueRemoveToolParams = {
  queueId: number;
  removeFromClient: boolean;
  blocklist: boolean;
  skipRedownload?: boolean;
  changeCategory?: boolean;
  confirmed?: boolean;
};

type HistoryToolParams = {
  page?: number;
  pageSize?: number;
  itemId?: number;
  episodeId?: number;
  downloadId?: string;
};

type BlocklistToolParams = {
  page?: number;
  pageSize?: number;
  itemIds?: number[];
};

type ManualImportToolParams = {
  folder?: string;
  downloadId?: string;
  itemId?: number;
  seasonNumber?: number;
  filterExistingFiles?: boolean;
};

type ManualImportExecuteToolParams = ManualImportToolParams & {
  importIds: number[];
  confirmed?: boolean;
};

export class PiAgentService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: SettingsStore,
    private readonly logger?: Logger,
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
    const clients = () => createMediaClients(this.store, this.logger);

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
        name: "get_radarr_movie",
        label: "Get Radarr movie",
        description: "Inspect an existing Radarr movie by ID, including monitored state, path, root folder, profile IDs, availability, and movie file metadata when Radarr provides it. Use before changing movie settings, moving location, renaming files, or triggering a search for an existing movie.",
        parameters: Type.Object({ movieId: Type.Number({ description: "Radarr movie ID" }) }),
        execute: async (_toolCallId, params: { movieId: number }) => {
          const results = await clients().radarr.getMovie(params.movieId);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "get_sonarr_series",
        label: "Get Sonarr series",
        description: "Inspect an existing Sonarr series by ID, including monitored state, path, root folder, seriesType, season folders, profile IDs, and seasons. Use before changing series settings, moving location, renaming files, or triggering a search for an existing series.",
        parameters: Type.Object({ seriesId: Type.Number({ description: "Sonarr series ID" }) }),
        execute: async (_toolCallId, params: { seriesId: number }) => {
          const results = await clients().sonarr.getSeries(params.seriesId);
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
        name: "list_radarr_root_folders",
        label: "List Radarr root folders",
        description: "List Radarr root folders and paths. Use before moving a movie or changing a movie's root folder/path.",
        parameters: Type.Object({}),
        execute: async () => {
          const results = await clients().radarr.getRootFolders();
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "list_sonarr_root_folders",
        label: "List Sonarr root folders",
        description: "List Sonarr root folders and paths. Use before moving a series or changing a series root folder/path.",
        parameters: Type.Object({}),
        execute: async () => {
          const results = await clients().sonarr.getRootFolders();
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "get_radarr_queue",
        label: "Get Radarr queue",
        description: "Inspect Radarr download/import queue items. Use before retrying or removing a Radarr queue item.",
        parameters: Type.Object({
          page: Type.Optional(Type.Number({ description: "Page number, default 1" })),
          pageSize: Type.Optional(Type.Number({ description: "Page size, default 10" })),
          itemId: Type.Optional(Type.Number({ description: "Optional Radarr movie ID filter" })),
          status: Type.Optional(Type.Array(Type.String(), { description: "Optional queue status filters" })),
        }),
        execute: async (_toolCallId, params: QueueToolParams) => {
          const results = await clients().radarr.getQueue({
            page: params.page,
            pageSize: params.pageSize,
            itemIds: params.itemId === undefined ? undefined : [params.itemId],
            status: params.status,
            includeItem: true,
          });
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "get_sonarr_queue",
        label: "Get Sonarr queue",
        description: "Inspect Sonarr download/import queue items. Use before retrying or removing a Sonarr queue item.",
        parameters: Type.Object({
          page: Type.Optional(Type.Number({ description: "Page number, default 1" })),
          pageSize: Type.Optional(Type.Number({ description: "Page size, default 10" })),
          itemId: Type.Optional(Type.Number({ description: "Optional Sonarr series ID filter" })),
          status: Type.Optional(Type.Array(Type.String(), { description: "Optional queue status filters" })),
        }),
        execute: async (_toolCallId, params: QueueToolParams) => {
          const results = await clients().sonarr.getQueue({
            page: params.page,
            pageSize: params.pageSize,
            itemIds: params.itemId === undefined ? undefined : [params.itemId],
            status: params.status,
            includeItem: true,
          });
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "get_radarr_queue_details",
        label: "Get Radarr queue details",
        description: "Inspect detailed Radarr queue entries for one movie. Use this for failed/stuck import diagnosis before retry/remove actions.",
        parameters: Type.Object({ itemId: Type.Number({ description: "Radarr movie ID" }) }),
        execute: async (_toolCallId, params: QueueDetailsToolParams) => {
          const results = await clients().radarr.getQueueDetails({ itemId: params.itemId, includeItem: true });
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "get_sonarr_queue_details",
        label: "Get Sonarr queue details",
        description: "Inspect detailed Sonarr queue entries for one series, optionally limited to episode IDs. Use this for failed/stuck import diagnosis before retry/remove actions.",
        parameters: Type.Object({
          itemId: Type.Number({ description: "Sonarr series ID" }),
          episodeIds: Type.Optional(Type.Array(Type.Number(), { description: "Optional Sonarr episode IDs" })),
        }),
        execute: async (_toolCallId, params: QueueDetailsToolParams) => {
          const results = await clients().sonarr.getQueueDetails({ itemId: params.itemId, episodeIds: params.episodeIds, includeItem: true });
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "get_radarr_history",
        label: "Get Radarr history",
        description: "Inspect Radarr history for grabs, imports, failures, and deletes. Use before queue removal, blocklist inspection, or manual import execution.",
        parameters: Type.Object({
          page: Type.Optional(Type.Number({ description: "Page number, default 1" })),
          pageSize: Type.Optional(Type.Number({ description: "Page size, default 10" })),
          itemId: Type.Optional(Type.Number({ description: "Optional Radarr movie ID filter" })),
          downloadId: Type.Optional(Type.String({ description: "Optional download ID filter" })),
        }),
        execute: async (_toolCallId, params: HistoryToolParams) => {
          const results = await clients().radarr.getHistory({ ...params, includeItem: true });
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "get_sonarr_history",
        label: "Get Sonarr history",
        description: "Inspect Sonarr history for grabs, imports, failures, and deletes. Use before queue removal, blocklist inspection, or manual import execution.",
        parameters: Type.Object({
          page: Type.Optional(Type.Number({ description: "Page number, default 1" })),
          pageSize: Type.Optional(Type.Number({ description: "Page size, default 10" })),
          itemId: Type.Optional(Type.Number({ description: "Optional Sonarr series ID filter" })),
          episodeId: Type.Optional(Type.Number({ description: "Optional Sonarr episode ID filter" })),
          downloadId: Type.Optional(Type.String({ description: "Optional download ID filter" })),
        }),
        execute: async (_toolCallId, params: HistoryToolParams) => {
          const results = await clients().sonarr.getHistory({ ...params, includeItem: true });
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "get_radarr_blocklist",
        label: "Get Radarr blocklist",
        description: "Inspect Radarr blocklist entries. Use when a release cannot be grabbed or a retry keeps being rejected.",
        parameters: Type.Object({
          page: Type.Optional(Type.Number({ description: "Page number, default 1" })),
          pageSize: Type.Optional(Type.Number({ description: "Page size, default 10" })),
          itemIds: Type.Optional(Type.Array(Type.Number(), { description: "Optional Radarr movie IDs" })),
        }),
        execute: async (_toolCallId, params: BlocklistToolParams) => {
          const results = await clients().radarr.getBlocklist(params);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "get_sonarr_blocklist",
        label: "Get Sonarr blocklist",
        description: "Inspect Sonarr blocklist entries. Use when a release cannot be grabbed or a retry keeps being rejected.",
        parameters: Type.Object({
          page: Type.Optional(Type.Number({ description: "Page number, default 1" })),
          pageSize: Type.Optional(Type.Number({ description: "Page size, default 10" })),
          itemIds: Type.Optional(Type.Array(Type.Number(), { description: "Optional Sonarr series IDs" })),
        }),
        execute: async (_toolCallId, params: BlocklistToolParams) => {
          const results = await clients().sonarr.getBlocklist(params);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "preview_radarr_manual_import",
        label: "Preview Radarr manual import",
        description: "Preview Radarr manual-import candidates from a folder or download ID. Use before execute_radarr_manual_import; do not execute imports without matching preview IDs.",
        parameters: Type.Object({
          folder: Type.Optional(Type.String({ description: "Folder path to scan" })),
          downloadId: Type.Optional(Type.String({ description: "Download ID to scan" })),
          itemId: Type.Optional(Type.Number({ description: "Optional Radarr movie ID" })),
          filterExistingFiles: Type.Optional(Type.Boolean({ description: "Whether to filter existing files, default true" })),
        }),
        execute: async (_toolCallId, params: ManualImportToolParams) => {
          const results = await clients().radarr.getManualImport(params);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "preview_sonarr_manual_import",
        label: "Preview Sonarr manual import",
        description: "Preview Sonarr manual-import candidates from a folder or download ID. Use before execute_sonarr_manual_import; do not execute imports without matching preview IDs.",
        parameters: Type.Object({
          folder: Type.Optional(Type.String({ description: "Folder path to scan" })),
          downloadId: Type.Optional(Type.String({ description: "Download ID to scan" })),
          itemId: Type.Optional(Type.Number({ description: "Optional Sonarr series ID" })),
          seasonNumber: Type.Optional(Type.Number({ description: "Optional season number" })),
          filterExistingFiles: Type.Optional(Type.Boolean({ description: "Whether to filter existing files, default true" })),
        }),
        execute: async (_toolCallId, params: ManualImportToolParams) => {
          const results = await clients().sonarr.getManualImport(params);
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
        name: "preview_sonarr_rename",
        label: "Preview Sonarr rename",
        description: "Preview Sonarr episode file rename/reorganize changes for a series, optionally limited to a season. Use before running rename_sonarr_episode_files.",
        parameters: Type.Object({
          seriesId: Type.Number({ description: "Sonarr series ID" }),
          seasonNumber: Type.Optional(Type.Number({ description: "Optional season number, use 0 for specials" })),
        }),
        execute: async (_toolCallId, params: { seriesId: number; seasonNumber?: number }) => {
          const results = await clients().sonarr.getEpisodeRenamePreviews(params.seriesId, params.seasonNumber);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "preview_radarr_rename",
        label: "Preview Radarr rename",
        description: "Preview Radarr movie file rename/reorganize changes for a movie. Use before running rename_radarr_movie_files.",
        parameters: Type.Object({ movieId: Type.Number({ description: "Radarr movie ID" }) }),
        execute: async (_toolCallId, params: { movieId: number }) => {
          const results = await clients().radarr.getMovieRenamePreviews(params.movieId);
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
        name: "remove_radarr_queue_item",
        label: "Remove Radarr queue item",
        description: "Remove a Radarr queue item after inspecting queue details/history. Explicitly set removeFromClient and blocklist based on the user's confirmed intent. Requires confirmation when configured.",
        parameters: Type.Object({
          queueId: Type.Number({ description: "Radarr queue item ID" }),
          removeFromClient: Type.Boolean({ description: "Whether to remove the download from the download client" }),
          blocklist: Type.Boolean({ description: "Whether to blocklist the release" }),
          skipRedownload: Type.Optional(Type.Boolean({ description: "Whether to skip redownload" })),
          changeCategory: Type.Optional(Type.Boolean({ description: "Whether to change download category instead of removal when supported" })),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: QueueRemoveToolParams) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Remove Radarr queue item ID ${params.queueId} removeFromClient=${params.removeFromClient} blocklist=${params.blocklist} skipRedownload=${params.skipRedownload ?? false} changeCategory=${params.changeCategory ?? false}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const results = await clients().radarr.removeQueueItem({ ...params, skipRedownload: params.skipRedownload ?? false, changeCategory: params.changeCategory ?? false });
          return toolResponse(results ?? { removed: true });
        },
      }),
      defineTool({
        name: "remove_sonarr_queue_item",
        label: "Remove Sonarr queue item",
        description: "Remove a Sonarr queue item after inspecting queue details/history. Explicitly set removeFromClient and blocklist based on the user's confirmed intent. Requires confirmation when configured.",
        parameters: Type.Object({
          queueId: Type.Number({ description: "Sonarr queue item ID" }),
          removeFromClient: Type.Boolean({ description: "Whether to remove the download from the download client" }),
          blocklist: Type.Boolean({ description: "Whether to blocklist the release" }),
          skipRedownload: Type.Optional(Type.Boolean({ description: "Whether to skip redownload" })),
          changeCategory: Type.Optional(Type.Boolean({ description: "Whether to change download category instead of removal when supported" })),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: QueueRemoveToolParams) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Remove Sonarr queue item ID ${params.queueId} removeFromClient=${params.removeFromClient} blocklist=${params.blocklist} skipRedownload=${params.skipRedownload ?? false} changeCategory=${params.changeCategory ?? false}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const results = await clients().sonarr.removeQueueItem({ ...params, skipRedownload: params.skipRedownload ?? false, changeCategory: params.changeCategory ?? false });
          return toolResponse(results ?? { removed: true });
        },
      }),
      defineTool({
        name: "execute_radarr_manual_import",
        label: "Execute Radarr manual import",
        description: "Execute Radarr manual import for IDs returned by preview_radarr_manual_import using the same folder/download/movie filters. Requires confirmation when configured.",
        parameters: Type.Object({
          importIds: Type.Array(Type.Number(), { description: "Manual import candidate IDs from preview_radarr_manual_import" }),
          folder: Type.Optional(Type.String({ description: "Same folder path used for preview" })),
          downloadId: Type.Optional(Type.String({ description: "Same download ID used for preview" })),
          itemId: Type.Optional(Type.Number({ description: "Same Radarr movie ID used for preview" })),
          filterExistingFiles: Type.Optional(Type.Boolean({ description: "Same filterExistingFiles value used for preview" })),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: ManualImportExecuteToolParams) => {
          const query = manualImportQuery(params);
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Execute Radarr manual import IDs ${params.importIds.join(", ")} with query ${JSON.stringify(query)}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const results = await clients().radarr.executeManualImport(query, params.importIds);
          return toolResponse(results ?? { imported: true });
        },
      }),
      defineTool({
        name: "execute_sonarr_manual_import",
        label: "Execute Sonarr manual import",
        description: "Execute Sonarr manual import for IDs returned by preview_sonarr_manual_import using the same folder/download/series/season filters. Requires confirmation when configured.",
        parameters: Type.Object({
          importIds: Type.Array(Type.Number(), { description: "Manual import candidate IDs from preview_sonarr_manual_import" }),
          folder: Type.Optional(Type.String({ description: "Same folder path used for preview" })),
          downloadId: Type.Optional(Type.String({ description: "Same download ID used for preview" })),
          itemId: Type.Optional(Type.Number({ description: "Same Sonarr series ID used for preview" })),
          seasonNumber: Type.Optional(Type.Number({ description: "Same season number used for preview" })),
          filterExistingFiles: Type.Optional(Type.Boolean({ description: "Same filterExistingFiles value used for preview" })),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: ManualImportExecuteToolParams) => {
          const query = manualImportQuery(params);
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Execute Sonarr manual import IDs ${params.importIds.join(", ")} with query ${JSON.stringify(query)}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const results = await clients().sonarr.executeManualImport(query, params.importIds);
          return toolResponse(results ?? { imported: true });
        },
      }),
      defineTool({
        name: "rename_radarr_movie_files",
        label: "Rename Radarr movie files",
        description: "Run Radarr rename/reorganize for selected movie file IDs returned by preview_radarr_rename. Requires confirmation when configured.",
        parameters: Type.Object({
          movieFileIds: Type.Array(Type.Number(), { description: "Radarr movie file IDs to rename/reorganize" }),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: { movieFileIds: number[]; confirmed?: boolean }) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Rename/reorganize Radarr movie file IDs ${params.movieFileIds.join(", ")}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const results = await clients().radarr.renameFiles({ fileIds: params.movieFileIds });
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "rename_sonarr_episode_files",
        label: "Rename Sonarr episode files",
        description: "Run Sonarr rename/reorganize for selected episode file IDs returned by preview_sonarr_rename. Requires confirmation when configured.",
        parameters: Type.Object({
          episodeFileIds: Type.Array(Type.Number(), { description: "Sonarr episode file IDs to rename/reorganize" }),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: { episodeFileIds: number[]; confirmed?: boolean }) => {
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Rename/reorganize Sonarr episode file IDs ${params.episodeFileIds.join(", ")}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const results = await clients().sonarr.renameFiles({ fileIds: params.episodeFileIds });
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "update_radarr_movie_settings",
        label: "Update Radarr movie settings",
        description: "Update selected settings for an existing Radarr movie. Use get_radarr_movie first; use list_radarr_root_folders before changing rootFolderPath/path. Can move files when moveFiles=true. Requires confirmation when configured.",
        parameters: Type.Object({
          movieId: Type.Number({ description: "Radarr movie ID" }),
          monitored: Type.Optional(Type.Boolean({ description: "Desired monitored value" })),
          qualityProfileId: Type.Optional(Type.Number({ description: "Radarr quality profile ID" })),
          minimumAvailability: Type.Optional(Type.String({ description: "Radarr minimum availability value, such as announced, inCinemas, released, or preDB" })),
          rootFolderPath: Type.Optional(Type.String({ description: "Target Radarr root folder path" })),
          path: Type.Optional(Type.String({ description: "Full target movie path" })),
          moveFiles: Type.Optional(Type.Boolean({ description: "Whether Radarr should move files to the new path/root folder" })),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: RadarrMovieSettingsParams) => {
          const requested = pickDefined(params, ["monitored", "qualityProfileId", "minimumAvailability", "rootFolderPath", "path"]);
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Update Radarr movie ID ${params.movieId} settings ${JSON.stringify(requested)} with moveFiles=${params.moveFiles ?? false}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const radarr = clients().radarr;
          const movie = withProperties(await radarr.getMovie(params.movieId), requested);
          const results = await radarr.updateMovieById(params.movieId, movie, params.moveFiles ?? false);
          return toolResponse(results);
        },
      }),
      defineTool({
        name: "update_sonarr_series_settings",
        label: "Update Sonarr series settings",
        description: "Update selected settings for an existing Sonarr series, including seriesType for standard/anime/daily numbering behavior. Use get_sonarr_series first; use list_sonarr_root_folders before changing rootFolderPath/path. Can move files when moveFiles=true. Requires confirmation when configured.",
        parameters: Type.Object({
          seriesId: Type.Number({ description: "Sonarr series ID" }),
          monitored: Type.Optional(Type.Boolean({ description: "Desired monitored value" })),
          seriesType: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("daily"), Type.Literal("anime")], { description: "Sonarr series type; anime enables anime/absolute-numbering behavior" })),
          qualityProfileId: Type.Optional(Type.Number({ description: "Sonarr quality profile ID" })),
          languageProfileId: Type.Optional(Type.Number({ description: "Sonarr language profile ID, if used by this Sonarr version" })),
          metadataProfileId: Type.Optional(Type.Number({ description: "Sonarr metadata profile ID, if used by this Sonarr version" })),
          seasonFolder: Type.Optional(Type.Boolean({ description: "Whether Sonarr should use season folders" })),
          rootFolderPath: Type.Optional(Type.String({ description: "Target Sonarr root folder path" })),
          path: Type.Optional(Type.String({ description: "Full target series path" })),
          moveFiles: Type.Optional(Type.Boolean({ description: "Whether Sonarr should move files to the new path/root folder" })),
          confirmed: Type.Optional(Type.Boolean({ description: "True only when the user explicitly confirmed this exact action" })),
        }),
        execute: async (_toolCallId, params: SonarrSeriesSettingsParams) => {
          const requested = pickDefined(params, [
            "monitored",
            "seriesType",
            "qualityProfileId",
            "languageProfileId",
            "metadataProfileId",
            "seasonFolder",
            "rootFolderPath",
            "path",
          ]);
          const policy = authorizeRepair(readRuntimeSettings(this.store), context, {
            action: `Update Sonarr series ID ${params.seriesId} settings ${JSON.stringify(requested)} with moveFiles=${params.moveFiles ?? false}`,
            confirmed: params.confirmed,
          });
          if (policy) return policy;

          const sonarr = clients().sonarr;
          const series = withProperties(await sonarr.getSeries(params.seriesId), requested);
          const results = await sonarr.updateSeriesById(params.seriesId, series, params.moveFiles ?? false);
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
          const results = await radarr.updateMovieById(params.movieId, movie, false);
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
          const results = await sonarr.updateSeriesById(params.seriesId, series, false);
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
          const results = await sonarr.updateSeriesById(params.seriesId, series, false);
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

function withProperties(value: unknown, properties: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Arr response was not an object");
  }

  return { ...value, ...properties };
}

function pickDefined(value: object, keys: string[]): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const key of keys) {
    if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }

  if (Object.keys(result).length === 0) {
    throw new Error("At least one setting field must be provided");
  }

  return result;
}

function manualImportQuery(params: ManualImportToolParams): ManualImportToolParams {
  const query = pickDefined(params, ["folder", "downloadId", "itemId", "seasonNumber", "filterExistingFiles"]);
  return query as ManualImportToolParams;
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

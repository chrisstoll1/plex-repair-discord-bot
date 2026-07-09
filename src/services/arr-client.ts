import type { Logger } from "pino";
import { buildQueryPath, requestMedia, type QueryValue } from "./http.js";

export type ArrConnectionSettings = {
  url?: string;
  apiKey?: string;
};

export type ArrTimeoutSettings = {
  standardSeconds: number;
  releaseLookupSeconds: number;
};

export type ArrSystemStatus = {
  appName?: string;
  version?: string;
  instanceName?: string;
};

export type ReleaseGrabParams = {
  guid: string;
  indexerId: number;
};

export type RenameFilesParams = {
  fileIds: number[];
};

export type QueueQueryParams = {
  page?: number;
  pageSize?: number;
  includeItem?: boolean;
  itemIds?: number[];
  status?: string[];
};

export type QueueDetailsParams = {
  itemId: number;
  episodeIds?: number[];
  includeItem?: boolean;
};

export type QueueRemoveParams = {
  queueId: number;
  removeFromClient: boolean;
  blocklist: boolean;
  skipRedownload: boolean;
  changeCategory: boolean;
};

export type HistoryQueryParams = {
  page?: number;
  pageSize?: number;
  itemId?: number;
  episodeId?: number;
  downloadId?: string;
  includeItem?: boolean;
};

export type BlocklistQueryParams = {
  page?: number;
  pageSize?: number;
  itemIds?: number[];
};

export type ManualImportQueryParams = {
  folder?: string;
  downloadId?: string;
  itemId?: number;
  seasonNumber?: number;
  filterExistingFiles?: boolean;
};

export class ArrClient {
  constructor(
    private readonly name: "sonarr" | "radarr",
    private readonly settings: ArrConnectionSettings,
    private readonly timeouts: ArrTimeoutSettings = { standardSeconds: 60, releaseLookupSeconds: 300 },
    private readonly logger?: Logger,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.settings.url && this.settings.apiKey);
  }

  async getSystemStatus(): Promise<ArrSystemStatus> {
    return this.request<ArrSystemStatus>("/api/v3/system/status");
  }

  async getRootFolders(): Promise<unknown> {
    return this.request<unknown>("/api/v3/rootfolder");
  }

  async search(query: string): Promise<unknown> {
    const path = this.name === "sonarr" ? "/api/v3/series/lookup" : "/api/v3/movie/lookup";
    return this.request<unknown>(buildQueryPath(path, { term: query }));
  }

  async getMovie(movieId: number): Promise<unknown> {
    this.assertService("radarr");
    return this.request<unknown>(`/api/v3/movie/${movieId}`);
  }

  async getSeries(seriesId: number): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>(`/api/v3/series/${seriesId}`);
  }

  async getEpisodes(seriesId: number, seasonNumber?: number): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>(buildQueryPath("/api/v3/episode", { seriesId, seasonNumber }));
  }

  async getEpisodeRenamePreviews(seriesId: number, seasonNumber?: number): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>(buildQueryPath("/api/v3/rename", { seriesId, seasonNumber }));
  }

  async getMovieRenamePreviews(movieId: number): Promise<unknown> {
    this.assertService("radarr");
    return this.request<unknown>(buildQueryPath("/api/v3/rename", { movieId }));
  }

  async getQueue(params: QueueQueryParams = {}): Promise<unknown> {
    return this.request<unknown>(buildQueryPath("/api/v3/queue", this.mediaQueryParams(params)));
  }

  async getQueueDetails(params: QueueDetailsParams): Promise<unknown> {
    const query = this.name === "sonarr"
      ? { seriesId: params.itemId, episodeIds: params.episodeIds, includeSeries: params.includeItem, includeEpisode: params.includeItem }
      : { movieId: params.itemId, includeMovie: params.includeItem };
    return this.request<unknown>(buildQueryPath("/api/v3/queue/details", query));
  }

  async removeQueueItem(params: QueueRemoveParams): Promise<unknown> {
    return this.request<unknown>(
      buildQueryPath(`/api/v3/queue/${params.queueId}`, {
        removeFromClient: params.removeFromClient,
        blocklist: params.blocklist,
        skipRedownload: params.skipRedownload,
        changeCategory: params.changeCategory,
      }),
      { method: "DELETE" },
    );
  }

  async getHistory(params: HistoryQueryParams = {}): Promise<unknown> {
    const itemKey = this.name === "sonarr" ? "seriesIds" : "movieIds";
    return this.request<unknown>(
      buildQueryPath("/api/v3/history", {
        page: params.page,
        pageSize: params.pageSize,
        [itemKey]: params.itemId === undefined ? undefined : [params.itemId],
        episodeId: this.name === "sonarr" ? params.episodeId : undefined,
        downloadId: params.downloadId,
        includeSeries: this.name === "sonarr" ? params.includeItem : undefined,
        includeEpisode: this.name === "sonarr" ? params.includeItem : undefined,
        includeMovie: this.name === "radarr" ? params.includeItem : undefined,
      }),
    );
  }

  async getBlocklist(params: BlocklistQueryParams = {}): Promise<unknown> {
    const itemKey = this.name === "sonarr" ? "seriesIds" : "movieIds";
    return this.request<unknown>(
      buildQueryPath("/api/v3/blocklist", {
        page: params.page,
        pageSize: params.pageSize,
        [itemKey]: params.itemIds,
      }),
    );
  }

  async getManualImport(params: ManualImportQueryParams): Promise<unknown> {
    return this.request<unknown>(buildQueryPath("/api/v3/manualimport", this.manualImportQueryParams(params)));
  }

  async executeManualImport(params: ManualImportQueryParams, importIds: number[]): Promise<unknown> {
    const preview = await this.getManualImport(params);
    if (!Array.isArray(preview)) {
      throw new Error("Manual import preview response was not an array");
    }

    const selected = preview.filter((item) => isRecord(item) && typeof item.id === "number" && importIds.includes(item.id));
    if (selected.length !== importIds.length) {
      const foundIds = new Set(selected.map((item) => item.id));
      const missing = importIds.filter((id) => !foundIds.has(id));
      throw new Error(`Manual import preview did not include import IDs: ${missing.join(", ")}`);
    }

    return this.request<unknown>("/api/v3/manualimport", { method: "POST", body: selected });
  }

  async getEpisodeFile(episodeFileId: number): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>(`/api/v3/episodefile/${episodeFileId}`);
  }

  async removeEpisodeFile(episodeFileId: number): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>(`/api/v3/episodefile/${episodeFileId}`, { method: "DELETE" });
  }

  async getMovieFiles(movieId: number): Promise<unknown> {
    this.assertService("radarr");
    return this.request<unknown>(buildQueryPath("/api/v3/moviefile", { movieId }));
  }

  async getMovieFile(movieFileId: number): Promise<unknown> {
    this.assertService("radarr");
    return this.request<unknown>(`/api/v3/moviefile/${movieFileId}`);
  }

  async removeMovieFile(movieFileId: number): Promise<unknown> {
    this.assertService("radarr");
    return this.request<unknown>(`/api/v3/moviefile/${movieFileId}`, { method: "DELETE" });
  }

  async getMovieReleases(movieId: number): Promise<unknown> {
    this.assertService("radarr");
    return this.request<unknown>(buildQueryPath("/api/v3/release", { movieId }), { timeoutSeconds: this.timeouts.releaseLookupSeconds });
  }

  async getEpisodeReleases(episodeId: number): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>(buildQueryPath("/api/v3/release", { episodeId }), { timeoutSeconds: this.timeouts.releaseLookupSeconds });
  }

  async triggerMovieSearch(movieId: number): Promise<unknown> {
    this.assertService("radarr");
    return this.request<unknown>("/api/v3/command", {
      method: "POST",
      body: { name: "MoviesSearch", movieIds: [movieId] },
    });
  }

  async triggerSeriesSearch(seriesId: number): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>("/api/v3/command", {
      method: "POST",
      body: { name: "SeriesSearch", seriesId },
    });
  }

  async triggerSeasonSearch(seriesId: number, seasonNumber: number): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>("/api/v3/command", {
      method: "POST",
      body: { name: "SeasonSearch", seriesId, seasonNumber },
    });
  }

  async triggerEpisodeSearch(episodeIds: number[]): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>("/api/v3/command", {
      method: "POST",
      body: { name: "EpisodeSearch", episodeIds },
    });
  }

  async grabRelease(params: ReleaseGrabParams): Promise<unknown> {
    return this.request<unknown>("/api/v3/release", {
      method: "POST",
      body: params,
    });
  }

  async renameFiles(params: RenameFilesParams): Promise<unknown> {
    return this.request<unknown>("/api/v3/command", {
      method: "POST",
      body: { name: "RenameFiles", files: params.fileIds },
    });
  }

  async updateMovie(movie: unknown): Promise<unknown> {
    this.assertService("radarr");
    return this.request<unknown>("/api/v3/movie", { method: "PUT", body: movie });
  }

  async updateMovieById(movieId: number, movie: unknown, moveFiles: boolean): Promise<unknown> {
    this.assertService("radarr");
    return this.request<unknown>(buildQueryPath(`/api/v3/movie/${movieId}`, { moveFiles }), { method: "PUT", body: movie });
  }

  async updateSeries(series: unknown): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>("/api/v3/series", { method: "PUT", body: series });
  }

  async updateSeriesById(seriesId: number, series: unknown, moveFiles: boolean): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>(buildQueryPath(`/api/v3/series/${seriesId}`, { moveFiles }), { method: "PUT", body: series });
  }

  async removeMovie(movieId: number, deleteFiles: boolean, addImportExclusion: boolean): Promise<unknown> {
    this.assertService("radarr");
    return this.request<unknown>(
      buildQueryPath(`/api/v3/movie/${movieId}`, { deleteFiles, addImportExclusion }),
      { method: "DELETE" },
    );
  }

  async removeSeries(seriesId: number, deleteFiles: boolean, addImportListExclusion: boolean): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>(
      buildQueryPath(`/api/v3/series/${seriesId}`, { deleteFiles, addImportListExclusion }),
      { method: "DELETE" },
    );
  }

  private async request<T>(path: string, options: { method?: string; body?: unknown; timeoutSeconds?: number } = {}): Promise<T> {
    if (!this.settings.url || !this.settings.apiKey) {
      throw new Error(`${this.name} is not configured`);
    }

    const timeoutSeconds = options.timeoutSeconds ?? this.timeouts.standardSeconds;
    return requestMedia<T>({
      service: this.name,
      baseUrl: this.settings.url,
      path,
      method: options.method,
      timeoutSeconds,
      headers: {
        "X-Api-Key": this.settings.apiKey,
        Accept: "application/json",
      },
      body: options.body,
      responseType: "json",
      logger: this.logger,
    });
  }

  private assertService(expected: "sonarr" | "radarr"): void {
    if (this.name !== expected) {
      throw new Error(`This operation is only available for ${expected}`);
    }
  }

  private mediaQueryParams(params: QueueQueryParams): Record<string, QueryValue> {
    return this.name === "sonarr"
      ? {
          page: params.page,
          pageSize: params.pageSize,
          includeUnknownSeriesItems: true,
          includeSeries: params.includeItem,
          includeEpisode: params.includeItem,
          seriesIds: params.itemIds,
          status: params.status,
        }
      : {
          page: params.page,
          pageSize: params.pageSize,
          includeUnknownMovieItems: true,
          includeMovie: params.includeItem,
          movieIds: params.itemIds,
          status: params.status,
        };
  }

  private manualImportQueryParams(params: ManualImportQueryParams): Record<string, QueryValue> {
    return this.name === "sonarr"
      ? {
          folder: params.folder,
          downloadId: params.downloadId,
          seriesId: params.itemId,
          seasonNumber: params.seasonNumber,
          filterExistingFiles: params.filterExistingFiles,
        }
      : {
          folder: params.folder,
          downloadId: params.downloadId,
          movieId: params.itemId,
          filterExistingFiles: params.filterExistingFiles,
        };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

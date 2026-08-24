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

export type TargetedReleaseGrabParams = ReleaseGrabParams & {
  title: string;
  allowRejected: boolean;
};

export type ReleasePageParams = {
  offset?: number;
  limit?: number;
  refresh?: boolean;
};

export type ArrReleaseCandidate = {
  title: string;
  guid: string;
  indexerId: number;
  indexer?: string;
  protocol?: string;
  quality?: string;
  languages: string[];
  customFormats: string[];
  customFormatScore?: number;
  size?: number;
  ageHours?: number;
  seeders?: number;
  leechers?: number;
  fullSeason?: boolean;
  downloadAllowed?: boolean;
  rejected: boolean;
  blocklisted: boolean;
  cutoffOnly: boolean;
  requiresTargetOverride: boolean;
  manualGrabEligible: boolean;
  rejections: string[];
};

export type ArrReleasePage = {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  counts: {
    manualGrabEligible: number;
    cutoffOnly: number;
    blocklisted: number;
  };
  candidates: ArrReleaseCandidate[];
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

export type ManualImportMode = "auto" | "copy" | "move";
export type ManualImportOverride = {
  importId: number;
  itemId?: number;
  episodeIds?: number[];
  releaseGroup?: string;
  quality?: unknown;
  languages?: unknown[];
  indexerFlags?: number;
  releaseType?: unknown;
};
type ManualImportCandidate = {
  id: number;
  path: string;
  folderName?: string;
  series?: { id?: number };
  movie?: { id?: number };
  episodes?: Array<{ id?: number }>;
  episodeFileId?: number;
  movieFileId?: number;
  releaseGroup?: string;
  quality?: unknown;
  languages?: unknown[];
  downloadId?: string;
  indexerFlags?: number;
  releaseType?: unknown;
};

export class ArrClient {
  private readonly releaseCache = new Map<string, unknown[]>();

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

  async executeManualImport(
    params: ManualImportQueryParams,
    importIds: number[],
    options: { importMode?: ManualImportMode; overrides?: ManualImportOverride[] } = {},
  ): Promise<unknown> {
    if (importIds.length === 0 || importIds.some((id) => !Number.isInteger(id) || id <= 0)) throw new Error("Manual import IDs must be positive integers");
    if (new Set(importIds).size !== importIds.length) throw new Error("Manual import IDs must be unique");
    const overrideIds = (options.overrides ?? []).map((item) => item.importId);
    if (overrideIds.some((id) => !Number.isInteger(id) || id <= 0) || new Set(overrideIds).size !== overrideIds.length) {
      throw new Error("Manual import override IDs must be unique positive integers");
    }
    const unknownOverrideIds = overrideIds.filter((id) => !importIds.includes(id));
    if (unknownOverrideIds.length) throw new Error(`Manual import overrides do not match selected IDs: ${unknownOverrideIds.join(", ")}`);
    const preview = await this.getManualImport(params);
    if (!Array.isArray(preview)) {
      throw new Error("Manual import preview response was not an array");
    }

    const selected = preview.filter(isManualImportCandidate).filter((item) => importIds.includes(item.id));
    if (selected.length !== importIds.length) {
      const foundIds = new Set(selected.map((item) => item.id));
      const missing = importIds.filter((id) => !foundIds.has(id));
      throw new Error(`Manual import preview did not include import IDs: ${missing.join(", ")}`);
    }

    const overrides = new Map((options.overrides ?? []).map((item) => [item.importId, item]));
    const files = selected.map((candidate) => {
      const override = overrides.get(candidate.id);
      const itemId = override?.itemId ?? (this.name === "sonarr" ? candidate.series?.id : candidate.movie?.id);
      if (!itemId) throw new Error(`Manual import candidate ${candidate.id} has no ${this.name === "sonarr" ? "series" : "movie"} mapping`);
      const common = {
        path: candidate.path,
        folderName: candidate.folderName,
        releaseGroup: override?.releaseGroup ?? candidate.releaseGroup,
        quality: override?.quality ?? candidate.quality,
        languages: override?.languages ?? candidate.languages,
        indexerFlags: override?.indexerFlags ?? candidate.indexerFlags,
        releaseType: override?.releaseType ?? candidate.releaseType,
        downloadId: candidate.downloadId ?? params.downloadId,
      };
      if (this.name === "radarr") return { ...common, movieId: itemId, movieFileId: candidate.movieFileId };
      const episodeIds = override?.episodeIds ?? candidate.episodes?.map((episode) => episode.id).filter((id): id is number => typeof id === "number");
      if (!episodeIds?.length) throw new Error(`Manual import candidate ${candidate.id} has no episode mapping`);
      return { ...common, seriesId: itemId, episodeIds, episodeFileId: candidate.episodeFileId };
    });

    return this.request<unknown>("/api/v3/command", {
      method: "POST",
      body: { name: "ManualImport", files, importMode: options.importMode ?? "auto" },
    });
  }

  async getCommand(commandId: number): Promise<unknown> {
    return this.request<unknown>(`/api/v3/command/${commandId}`);
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

  async getMovieReleases(movieId: number, page: ReleasePageParams = {}): Promise<ArrReleasePage> {
    this.assertService("radarr");
    return this.releasePage(await this.getRawReleases({ movieId }, page.refresh === true || (page.offset ?? 0) === 0), page);
  }

  async getEpisodeReleases(episodeId: number, page: ReleasePageParams = {}): Promise<ArrReleasePage> {
    this.assertService("sonarr");
    return this.releasePage(await this.getRawReleases({ episodeId }, page.refresh === true || (page.offset ?? 0) === 0), page);
  }

  async grabMovieRelease(movieId: number, params: TargetedReleaseGrabParams): Promise<unknown> {
    this.assertService("radarr");
    return this.grabValidatedRelease(await this.getRawReleases({ movieId }, true), { label: `movie ID ${movieId}`, field: "movieId", id: movieId }, params);
  }

  async grabEpisodeRelease(episodeId: number, params: TargetedReleaseGrabParams): Promise<unknown> {
    this.assertService("sonarr");
    return this.grabValidatedRelease(await this.getRawReleases({ episodeId }, true), { label: `episode ID ${episodeId}`, field: "episodeId", id: episodeId }, params);
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

  async refreshSeries(seriesId: number): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>("/api/v3/command", { method: "POST", body: { name: "RefreshSeries", seriesId } });
  }

  async rescanSeries(seriesId: number): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>("/api/v3/command", { method: "POST", body: { name: "RescanSeries", seriesId } });
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

  private async getRawReleases(target: { episodeId?: number; movieId?: number }, refresh = false): Promise<unknown[]> {
    const cacheKey = target.episodeId === undefined ? `movie:${target.movieId}` : `episode:${target.episodeId}`;
    const cached = this.releaseCache.get(cacheKey);
    if (!refresh && cached) return cached;
    const response = await this.request<unknown>(buildQueryPath("/api/v3/release", target), { timeoutSeconds: this.timeouts.releaseLookupSeconds });
    if (!Array.isArray(response)) throw new Error(`${this.name} release response was not an array`);
    this.releaseCache.set(cacheKey, response);
    return response;
  }

  private releasePage(rawReleases: unknown[], page: ReleasePageParams): ArrReleasePage {
    const candidates = rawReleases.map(compactRelease).filter((release): release is ArrReleaseCandidate => Boolean(release));
    const offset = Math.max(0, Math.floor(page.offset ?? 0));
    const limit = Math.max(1, Math.min(50, Math.floor(page.limit ?? 20)));
    return {
      total: candidates.length,
      offset,
      limit,
      hasMore: offset + limit < candidates.length,
      counts: {
        manualGrabEligible: candidates.filter((release) => release.manualGrabEligible).length,
        cutoffOnly: candidates.filter((release) => release.cutoffOnly).length,
        blocklisted: candidates.filter((release) => release.blocklisted).length,
      },
      candidates: candidates.slice(offset, offset + limit),
    };
  }

  private async grabValidatedRelease(
    rawReleases: unknown[],
    target: { label: string; field: "episodeId" | "movieId"; id: number },
    params: TargetedReleaseGrabParams,
  ): Promise<unknown> {
    const release = rawReleases.map(compactRelease).find((candidate) => candidate?.guid === params.guid && candidate.indexerId === params.indexerId);
    if (!release) throw new Error(`Selected release was not returned by a fresh search for ${target.label}`);
    if (release.title !== params.title) throw new Error(`Selected release title changed for ${target.label}`);
    if (release.blocklisted) throw new Error(`Selected release is blocklisted for ${target.label}`);
    if ((release.rejected || release.downloadAllowed === false) && !params.allowRejected) {
      throw new Error(`Selected release is rejected for ${target.label}; allowRejected must be true for an intentional manual grab`);
    }
    const result = await this.request<unknown>("/api/v3/release", {
      method: "POST",
      body: { guid: params.guid, indexerId: params.indexerId, [target.field]: target.id },
    });
    return { target: target.label, selectedRelease: release, result };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManualImportCandidate(value: unknown): value is ManualImportCandidate {
  return isRecord(value) && typeof value.id === "number" && typeof value.path === "string";
}

function compactRelease(value: unknown): ArrReleaseCandidate | undefined {
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.guid !== "string" || typeof value.indexerId !== "number") return undefined;
  const rejections = stringList(value.rejections);
  const blocklisted = rejections.some((reason) => /blocklist/i.test(reason));
  const downloadAllowed = typeof value.downloadAllowed === "boolean" ? value.downloadAllowed : undefined;
  const rejected = value.rejected === true || rejections.length > 0;
  return {
    title: value.title,
    guid: value.guid,
    indexerId: value.indexerId,
    indexer: stringProperty(value, "indexer"),
    protocol: stringProperty(value, "protocol"),
    quality: qualityName(value.quality),
    languages: namedValues(value.languages),
    customFormats: namedValues(value.customFormats),
    customFormatScore: numberProperty(value, "customFormatScore"),
    size: numberProperty(value, "size"),
    ageHours: numberProperty(value, "ageHours"),
    seeders: numberProperty(value, "seeders"),
    leechers: numberProperty(value, "leechers"),
    fullSeason: typeof value.fullSeason === "boolean" ? value.fullSeason : undefined,
    downloadAllowed,
    rejected,
    blocklisted,
    cutoffOnly: rejections.length > 0 && rejections.every(isExistingFilePreferenceRejection),
    requiresTargetOverride: downloadAllowed === false,
    manualGrabEligible: !blocklisted,
    rejections,
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [item.trim()] : [];
    if (!isRecord(item)) return [];
    const message = [item.message, item.reason].find((candidate): candidate is string => typeof candidate === "string");
    return message?.trim() ? [message.trim()] : [];
  });
}

function namedValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => typeof item === "string" ? [item] : isRecord(item) && typeof item.name === "string" ? [item.name] : []);
}

function qualityName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.name === "string") return value.name;
  return isRecord(value.quality) && typeof value.quality.name === "string" ? value.quality.name : undefined;
}

function stringProperty(value: Record<string, unknown>, property: string): string | undefined {
  return typeof value[property] === "string" ? value[property] : undefined;
}

function numberProperty(value: Record<string, unknown>, property: string): number | undefined {
  return typeof value[property] === "number" ? value[property] : undefined;
}

function isExistingFilePreferenceRejection(reason: string): boolean {
  return /existing file.*(?:meets cutoff|equal|higher|same|better)|not an upgrade/i.test(reason);
}

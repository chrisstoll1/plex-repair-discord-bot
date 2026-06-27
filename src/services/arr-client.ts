import type { Logger } from "pino";

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
    return this.request<unknown>(`${path}?term=${encodeURIComponent(query)}`);
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
    const seasonQuery = seasonNumber === undefined ? "" : `&seasonNumber=${seasonNumber}`;
    return this.request<unknown>(`/api/v3/episode?seriesId=${seriesId}${seasonQuery}`);
  }

  async getEpisodeRenamePreviews(seriesId: number, seasonNumber?: number): Promise<unknown> {
    this.assertService("sonarr");
    const seasonQuery = seasonNumber === undefined ? "" : `&seasonNumber=${seasonNumber}`;
    return this.request<unknown>(`/api/v3/rename?seriesId=${seriesId}${seasonQuery}`);
  }

  async getMovieRenamePreviews(movieId: number): Promise<unknown> {
    this.assertService("radarr");
    return this.request<unknown>(`/api/v3/rename?movieId=${movieId}`);
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
    return this.request<unknown>(`/api/v3/moviefile?movieId=${movieId}`);
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
    return this.request<unknown>(`/api/v3/release?movieId=${movieId}`, { timeoutSeconds: this.timeouts.releaseLookupSeconds });
  }

  async getEpisodeReleases(episodeId: number): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>(`/api/v3/release?episodeId=${episodeId}`, { timeoutSeconds: this.timeouts.releaseLookupSeconds });
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
    return this.request<unknown>(`/api/v3/movie/${movieId}?moveFiles=${moveFiles}`, { method: "PUT", body: movie });
  }

  async updateSeries(series: unknown): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>("/api/v3/series", { method: "PUT", body: series });
  }

  async updateSeriesById(seriesId: number, series: unknown, moveFiles: boolean): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>(`/api/v3/series/${seriesId}?moveFiles=${moveFiles}`, { method: "PUT", body: series });
  }

  async removeMovie(movieId: number, deleteFiles: boolean, addImportExclusion: boolean): Promise<unknown> {
    this.assertService("radarr");
    return this.request<unknown>(
      `/api/v3/movie/${movieId}?deleteFiles=${deleteFiles}&addImportExclusion=${addImportExclusion}`,
      { method: "DELETE" },
    );
  }

  async removeSeries(seriesId: number, deleteFiles: boolean, addImportListExclusion: boolean): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>(
      `/api/v3/series/${seriesId}?deleteFiles=${deleteFiles}&addImportListExclusion=${addImportListExclusion}`,
      { method: "DELETE" },
    );
  }

  private async request<T>(path: string, options: { method?: string; body?: unknown; timeoutSeconds?: number } = {}): Promise<T> {
    if (!this.settings.url || !this.settings.apiKey) {
      throw new Error(`${this.name} is not configured`);
    }

    const url = new URL(path, ensureTrailingSlash(this.settings.url));
    const timeoutSeconds = options.timeoutSeconds ?? this.timeouts.standardSeconds;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    const startedAt = Date.now();
    let response: Response;

    this.logger?.info(
      {
        service: this.name,
        method: options.method ?? "GET",
        path,
        timeoutSeconds,
      },
      "Media service request started",
    );

    try {
      response = await fetch(url, {
        method: options.method ?? "GET",
        headers: {
          "X-Api-Key": this.settings.apiKey,
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      if (controller.signal.aborted) {
        this.logger?.warn(
          {
            service: this.name,
            method: options.method ?? "GET",
            path,
            timeoutSeconds,
            elapsedMs,
          },
          "Media service request timed out",
        );
        throw new Error(`${this.name} request timed out after ${timeoutSeconds} seconds: ${path}`);
      }

      this.logger?.warn(
        {
          service: this.name,
          method: options.method ?? "GET",
          path,
          timeoutSeconds,
          elapsedMs,
          error: error instanceof Error ? error.message : String(error),
        },
        "Media service request failed before response",
      );
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const elapsedMs = Date.now() - startedAt;

    if (!response.ok) {
      const body = await response.text();
      this.logger?.warn(
        {
          service: this.name,
          method: options.method ?? "GET",
          path,
          timeoutSeconds,
          elapsedMs,
          status: response.status,
          statusText: response.statusText,
          server: response.headers.get("server") ?? undefined,
          via: response.headers.get("via") ?? undefined,
          bodyPreview: body.slice(0, 500) || undefined,
        },
        "Media service request returned non-OK response",
      );
      throw new Error(`${this.name} request failed: ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`);
    }

    this.logger?.info(
      {
        service: this.name,
        method: options.method ?? "GET",
        path,
        timeoutSeconds,
        elapsedMs,
        status: response.status,
      },
      "Media service request completed",
    );

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private assertService(expected: "sonarr" | "radarr"): void {
    if (this.name !== expected) {
      throw new Error(`This operation is only available for ${expected}`);
    }
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

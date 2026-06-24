export type ArrConnectionSettings = {
  url?: string;
  apiKey?: string;
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

export class ArrClient {
  constructor(
    private readonly name: "sonarr" | "radarr",
    private readonly settings: ArrConnectionSettings,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.settings.url && this.settings.apiKey);
  }

  async getSystemStatus(): Promise<ArrSystemStatus> {
    return this.request<ArrSystemStatus>("/api/v3/system/status");
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
    return this.request<unknown>(`/api/v3/release?movieId=${movieId}`);
  }

  async getEpisodeReleases(episodeId: number): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>(`/api/v3/release?episodeId=${episodeId}`);
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

  async updateMovie(movie: unknown): Promise<unknown> {
    this.assertService("radarr");
    return this.request<unknown>("/api/v3/movie", { method: "PUT", body: movie });
  }

  async updateSeries(series: unknown): Promise<unknown> {
    this.assertService("sonarr");
    return this.request<unknown>("/api/v3/series", { method: "PUT", body: series });
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

  private async request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    if (!this.settings.url || !this.settings.apiKey) {
      throw new Error(`${this.name} is not configured`);
    }

    const url = new URL(path, ensureTrailingSlash(this.settings.url));
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        "X-Api-Key": this.settings.apiKey,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${this.name} request failed: ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`);
    }

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

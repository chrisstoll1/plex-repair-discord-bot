export type ArrConnectionSettings = {
  url?: string;
  apiKey?: string;
};

export type ArrSystemStatus = {
  appName?: string;
  version?: string;
  instanceName?: string;
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

  private async request<T>(path: string): Promise<T> {
    if (!this.settings.url || !this.settings.apiKey) {
      throw new Error(`${this.name} is not configured`);
    }

    const url = new URL(path, ensureTrailingSlash(this.settings.url));
    const response = await fetch(url, {
      headers: {
        "X-Api-Key": this.settings.apiKey,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`${this.name} request failed: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as T;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

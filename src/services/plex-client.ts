import type { Logger } from "pino";

export type PlexConnectionSettings = {
  url?: string;
  token?: string;
};

export type PlexServerIdentity = {
  friendlyName?: string;
  machineIdentifier?: string;
  version?: string;
};

export class PlexClient {
  constructor(
    private readonly settings: PlexConnectionSettings,
    private readonly timeoutSeconds = 60,
    private readonly logger?: Logger,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.settings.url && this.settings.token);
  }

  async getIdentity(): Promise<PlexServerIdentity> {
    const xml = await this.requestText("/");
    return {
      friendlyName: readXmlAttribute(xml, "friendlyName"),
      machineIdentifier: readXmlAttribute(xml, "machineIdentifier"),
      version: readXmlAttribute(xml, "version"),
    };
  }

  async search(query: string): Promise<string> {
    return this.requestText(`/search?query=${encodeURIComponent(query)}`);
  }

  async getLibrarySections(): Promise<string> {
    return this.requestText("/library/sections");
  }

  async refreshLibrarySection(sectionId: number): Promise<{ refreshTriggered: true; sectionId: number; response?: string }> {
    const response = await this.requestText(`/library/sections/${sectionId}/refresh`);
    return { refreshTriggered: true, sectionId, ...(response ? { response } : {}) };
  }

  private async requestText(path: string): Promise<string> {
    if (!this.settings.url || !this.settings.token) {
      throw new Error("Plex is not configured");
    }

    const url = new URL(path, ensureTrailingSlash(this.settings.url));
    url.searchParams.set("X-Plex-Token", this.settings.token);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutSeconds * 1000);
    const startedAt = Date.now();
    let response: Response;

    this.logger?.info(
      {
        service: "plex",
        method: "GET",
        path,
        timeoutSeconds: this.timeoutSeconds,
      },
      "Media service request started",
    );

    try {
      response = await fetch(url, { headers: { Accept: "application/xml,text/xml" }, signal: controller.signal });
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      if (controller.signal.aborted) {
        this.logger?.warn(
          {
            service: "plex",
            method: "GET",
            path,
            timeoutSeconds: this.timeoutSeconds,
            elapsedMs,
          },
          "Media service request timed out",
        );
        throw new Error(`Plex request timed out after ${this.timeoutSeconds} seconds: ${path}`);
      }

      this.logger?.warn(
        {
          service: "plex",
          method: "GET",
          path,
          timeoutSeconds: this.timeoutSeconds,
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
      this.logger?.warn(
        {
          service: "plex",
          method: "GET",
          path,
          timeoutSeconds: this.timeoutSeconds,
          elapsedMs,
          status: response.status,
          statusText: response.statusText,
          server: response.headers.get("server") ?? undefined,
          via: response.headers.get("via") ?? undefined,
        },
        "Media service request returned non-OK response",
      );
      throw new Error(`Plex request failed: ${response.status} ${response.statusText}`);
    }

    this.logger?.info(
      {
        service: "plex",
        method: "GET",
        path,
        timeoutSeconds: this.timeoutSeconds,
        elapsedMs,
        status: response.status,
      },
      "Media service request completed",
    );

    return response.text();
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function readXmlAttribute(xml: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(xml);
  return match?.[1];
}

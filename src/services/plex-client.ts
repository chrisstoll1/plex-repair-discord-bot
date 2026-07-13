import type { Logger } from "pino";
import { buildQueryPath, requestMedia } from "./http.js";

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
    return this.requestText(buildQueryPath("/search", { query }));
  }

  async getLibrarySections(): Promise<string> {
    return this.requestText("/library/sections");
  }

  async searchLibrarySection(sectionId: number, title: string): Promise<string> {
    return this.requestText(buildQueryPath(`/library/sections/${sectionId}/all`, { title }));
  }

  async getMetadataChildren(ratingKey: string): Promise<string> {
    return this.requestText(`/library/metadata/${encodeURIComponent(ratingKey)}/children`);
  }

  async refreshLibrarySection(sectionId: number, mediaPath?: string): Promise<{ refreshTriggered: true; sectionId: number; path?: string; response?: string }> {
    const response = await this.requestText(buildQueryPath(`/library/sections/${sectionId}/refresh`, { path: mediaPath }));
    return { refreshTriggered: true, sectionId, ...(mediaPath ? { path: mediaPath } : {}), ...(response ? { response } : {}) };
  }

  private async requestText(path: string): Promise<string> {
    if (!this.settings.url || !this.settings.token) {
      throw new Error("Plex is not configured");
    }

    return requestMedia<string>({
      service: "Plex",
      logService: "plex",
      baseUrl: this.settings.url,
      path: buildQueryPath(path, { "X-Plex-Token": this.settings.token }),
      logPath: path,
      timeoutSeconds: this.timeoutSeconds,
      headers: { Accept: "application/xml,text/xml" },
      responseType: "text",
      logger: this.logger,
    });
  }
}

function readXmlAttribute(xml: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(xml);
  return match?.[1];
}

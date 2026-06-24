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
  constructor(private readonly settings: PlexConnectionSettings) {}

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

    const response = await fetch(url, { headers: { Accept: "application/xml,text/xml" } });
    if (!response.ok) {
      throw new Error(`Plex request failed: ${response.status} ${response.statusText}`);
    }

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

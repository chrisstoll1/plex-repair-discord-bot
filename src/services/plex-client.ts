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

export type PlexTvSeason = {
  showRatingKey: string;
  seasonNumber: number;
  found: boolean;
  seasonRatingKey?: string;
  episodes: Array<{
    ratingKey?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    title?: string;
    files: string[];
  }>;
};

export type PlexLibrarySectionStatus = {
  sectionId: number;
  title?: string;
  type?: string;
  refreshing: boolean;
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

  async getLibrarySectionStatus(sectionId: number): Promise<PlexLibrarySectionStatus> {
    const xml = await this.getLibrarySections();
    const section = xmlElements(xml, "Directory")
      .map(readXmlAttributes)
      .find((attributes) => Number(attributes.key) === sectionId);
    if (!section) throw new Error(`Plex library section ${sectionId} was not found`);
    return {
      sectionId,
      ...(section.title ? { title: section.title } : {}),
      ...(section.type ? { type: section.type } : {}),
      refreshing: section.refreshing === "1" || section.refreshing === "true",
    };
  }

  async searchLibrarySection(sectionId: number, title: string): Promise<string> {
    return this.requestText(buildQueryPath(`/library/sections/${sectionId}/all`, { title }));
  }

  async getMetadataChildren(ratingKey: string): Promise<string> {
    return this.requestText(`/library/metadata/${encodeURIComponent(ratingKey)}/children`);
  }

  async getTvSeasonEpisodes(showRatingKey: string, seasonNumber: number): Promise<PlexTvSeason> {
    const seasonsXml = await this.getMetadataChildren(showRatingKey);
    const season = xmlElements(seasonsXml, "Directory")
      .map(readXmlAttributes)
      .find((attributes) => Number(attributes.index) === seasonNumber);
    if (!season?.ratingKey) return { showRatingKey, seasonNumber, found: false, episodes: [] };

    const episodesXml = await this.getMetadataChildren(season.ratingKey);
    const episodes = xmlBlocks(episodesXml, "Video").map(({ attributes, content }) => {
      const video = readXmlAttributes(attributes);
      const seasonIndex = numberAttribute(video.parentIndex);
      const episodeIndex = numberAttribute(video.index);
      const files = xmlElements(content, "Part")
        .map(readXmlAttributes)
        .map((part) => part.file)
        .filter((file): file is string => Boolean(file));
      return {
        ...(video.ratingKey ? { ratingKey: video.ratingKey } : {}),
        ...(seasonIndex !== undefined ? { seasonNumber: seasonIndex } : {}),
        ...(episodeIndex !== undefined ? { episodeNumber: episodeIndex } : {}),
        ...(video.title ? { title: video.title } : {}),
        files,
      };
    });
    return { showRatingKey, seasonNumber, found: true, seasonRatingKey: season.ratingKey, episodes };
  }

  async refreshLibrarySection(sectionId: number, directoryPath?: string): Promise<{ refreshRequested: true; sectionId: number; directoryPath?: string; response?: string }> {
    if (directoryPath && MEDIA_FILE_EXTENSION.test(directoryPath)) {
      throw new Error(`Plex refresh path must be a directory, not a media file: ${directoryPath}`);
    }
    const response = await this.requestText(buildQueryPath(`/library/sections/${sectionId}/refresh`, { path: directoryPath }));
    return { refreshRequested: true, sectionId, ...(directoryPath ? { directoryPath } : {}), ...(response ? { response } : {}) };
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

const MEDIA_FILE_EXTENSION = /\.(?:avi|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|ts|webm|wmv)$/i;

function readXmlAttribute(xml: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(xml);
  return match?.[1];
}

function xmlElements(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "g"))].map((match) => match[1] ?? "");
}

function xmlBlocks(xml: string, name: string): Array<{ attributes: string; content: string }> {
  return [...xml.matchAll(new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)<\\/${name}>`, "g"))]
    .map((match) => ({ attributes: match[1] ?? "", content: match[2] ?? "" }));
}

function readXmlAttributes(attributes: string): Record<string, string> {
  return Object.fromEntries([...attributes.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1]!, decodeXml(match[2] ?? "")]));
}

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!;
    const hexadecimal = entity.toLowerCase().startsWith("&#x");
    const codePoint = Number.parseInt(entity.slice(hexadecimal ? 3 : 2, -1), hexadecimal ? 16 : 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
  });
}

function numberAttribute(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

import { parseSeerrUserMappings, type SeerrSettings } from "../domain/settings.js";
import { buildQueryPath } from "./http.js";

export type SeerrMediaType = "movie" | "tv";
export type SeerrRequestParams = { mediaType: SeerrMediaType; tmdbId: number; title: string; year: number; is4k?: boolean; seasons?: number[]; allSeasons?: boolean };
type Data = Record<string, unknown>;
const REQUEST_STATUS = ["unknown", "pending_approval", "approved", "declined", "failed", "completed"];
const MEDIA_STATUS = ["unknown", "unknown", "pending", "processing", "partially_available", "available", "blocklisted", "deleted"];
class SeerrHttpError extends Error { constructor(public status: number) { super(`Seerr returned HTTP ${status}. Check Seerr permissions, quotas, and request status.`); } }

export class SeerrClient {
  private userPromise?: Promise<number>;
  constructor(private readonly settings: SeerrSettings, private readonly timeoutSeconds = 60, private readonly discordUserId?: string) {}
  isConfigured() { return Boolean(this.settings.url && this.settings.apiKey); }

  async getStatus() {
    const [status, user] = await Promise.all([this.http("/status"), this.http("/auth/me")]);
    if (!positive(user.id)) throw new Error("Seerr authentication did not return a valid account");
    return { version: string(status.version), authenticated: true };
  }

  async search(query: string, page = 1) {
    if (!query.trim() || query.length > 200 || !positive(page)) throw new Error("A title and positive search page are required");
    const userId = await this.userId();
    // Seerr's query validator requires percent-encoded spaces, not form-style '+'.
    const response = await this.http(buildQueryPath("/search", { query, page }).replace(/\+/g, "%20"), userId);
    const results = list(response.results).filter((item) => item.mediaType === "movie" || item.mediaType === "tv");
    const compact = results.map((item) => ({ tmdbId: item.id, mediaType: item.mediaType, title: item.title ?? item.name,
      year: dateYear(item.releaseDate ?? item.firstAirDate), overview: string(item.overview)?.slice(0, 350),
      availability: MEDIA_STATUS[num(object(item.mediaInfo).status)] ?? "unknown" }));
    const result = { page: response.page, totalPages: response.totalPages, totalResults: response.totalResults, results: compact };
    bounded(result);
    return result;
  }

  async getMedia(mediaType: SeerrMediaType, tmdbId: number) {
    const userId = await this.userId();
    return this.compactMedia(await this.details(mediaType, tmdbId, userId), mediaType);
  }

  async getRequest(requestId: number) {
    if (!positive(requestId)) throw new Error("A positive Seerr request ID is required");
    const data = await this.http(`/request/${requestId}`, await this.userId());
    if (data.id !== requestId) throw new Error("Seerr returned a different request ID");
    const result = this.compactRequest(data);
    bounded(result);
    return result;
  }

  async requestMedia(params: SeerrRequestParams) {
    this.validateMedia(params.mediaType, params.tmdbId);
    if (!params.title.trim() || !Number.isInteger(params.year) || params.year < 1800 || params.year > 2200
      || (params.is4k !== undefined && typeof params.is4k !== "boolean") || (params.allSeasons !== undefined && typeof params.allSeasons !== "boolean")) throw new Error("Exact title/year and valid request scope are required");
    if (params.mediaType === "movie" && (params.seasons !== undefined || params.allSeasons)) throw new Error("Movie requests cannot include TV seasons");
    if (params.mediaType === "tv" && (params.allSeasons ? params.seasons !== undefined : !params.seasons?.length)) throw new Error("Choose explicit TV seasons or allSeasons=true, not both");
    const userId = await this.userId();
    const data = await this.details(params.mediaType, params.tmdbId, userId);
    if ((data.title ?? data.name) !== params.title || dateYear(data.releaseDate ?? data.firstAirDate) !== params.year) throw new Error("Seerr details do not match the expected external ID, title and year");
    const info = object(data.mediaInfo);
    const is4k = params.is4k === true;
    const active = list(info.requests).filter((request) => [1, 2].includes(num(request.status)) && Boolean(request.is4k) === is4k);
    let seasons: number[] | undefined;
    if (params.mediaType === "tv") {
      const availableSeasons = list(data.seasons).map((season) => num(season.seasonNumber));
      const requested = params.allSeasons ? availableSeasons.filter((season) => season > 0) : params.seasons!;
      if (!requested.length || requested.some((season) => !Number.isInteger(season) || season < 0 || !availableSeasons.includes(season))) throw new Error("Requested seasons must exist in the exact TV details");
      const completed = list(info.seasons).filter((season) => season[is4k ? "status4k" : "status"] === 5).map((season) => num(season.seasonNumber));
      const pending = active.flatMap((request) => list(request.seasons).map((season) => num(season.seasonNumber)));
      seasons = [...new Set(requested)].filter((season) => !completed.includes(season) && !pending.includes(season)).sort((a, b) => a - b);
      if (!seasons.length) return { created: false, alreadyRequestedOrAvailable: true, media: this.compactMedia(data, params.mediaType), note: "Selected seasons are already available or requested. No duplicate request was submitted." };
    } else if (info[is4k ? "status4k" : "status"] === 5 || active.length) {
      return { created: false, alreadyRequestedOrAvailable: true, media: this.compactMedia(data, params.mediaType), note: "This movie is already available or has an active request. No duplicate request was submitted." };
    }
    try {
      // Act as the resolved Discord user. No userId, approval, quota, server or
      // profile overrides are accepted from the model; Seerr controls those.
      const response = await this.http("/request", userId, {
        method: "POST", body: { mediaType: params.mediaType, mediaId: params.tmdbId, is4k, ...(seasons ? { seasons } : {}) },
      });
      if (!positive(response.id) || object(response.media).tmdbId !== params.tmdbId || response.type !== params.mediaType) {
        throw new Error("Seerr response did not confirm the exact request. Check media/request status before retrying; it may have been accepted.");
      }
      const result = { created: true, request: this.compactRequest(response),
        note: "Request recorded in Seerr. Pending approval is not a download, and approval is not Plex availability. Keep request ID/link in the repair checkpoint and continue status verification." };
      bounded(result);
      return result;
    } catch (error) {
      if (error instanceof SeerrHttpError && error.status === 409) return { created: false, duplicate: true, media: this.compactMedia(await this.details(params.mediaType, params.tmdbId, userId), params.mediaType), note: "Seerr reported an existing request; inspect its current status instead of resubmitting." };
      throw error;
    }
  }

  private async details(mediaType: SeerrMediaType, tmdbId: number, userId: number) {
    this.validateMedia(mediaType, tmdbId);
    const data = await this.http(`/${mediaType}/${tmdbId}`, userId);
    if (data.id !== tmdbId) throw new Error("Seerr returned different media than requested");
    return data;
  }

  private compactMedia(data: Data, mediaType: SeerrMediaType) {
    const info = object(data.mediaInfo);
    const result = { tmdbId: data.id, mediaType, title: string(data.title ?? data.name), year: dateYear(data.releaseDate ?? data.firstAirDate),
      tvdbId: optionalNumber(object(data.externalIds).tvdbId ?? info.tvdbId),
      mediaUrl: this.mediaUrl(mediaType, num(data.id)), availability: MEDIA_STATUS[num(info.status)] ?? "unknown", availability4k: MEDIA_STATUS[num(info.status4k)] ?? "unknown",
      arrId: optionalNumber(info.externalServiceId), arrId4k: optionalNumber(info.externalServiceId4k),
      seasons: list(data.seasons).map((season) => ({ seasonNumber: optionalNumber(season.seasonNumber), episodeCount: optionalNumber(season.episodeCount) })),
      requests: list(info.requests).map((request) => this.compactRequest({ ...request, media: { ...info, tmdbId: data.id, mediaType } })),
    };
    bounded(result);
    return result;
  }

  private compactRequest(data: Data) {
    const media = object(data.media);
    const type = data.type ?? media.mediaType;
    const mediaType = type === "movie" || type === "tv" ? type : undefined;
    return { id: optionalNumber(data.id), status: REQUEST_STATUS[num(data.status)] ?? "unknown", statusCode: optionalNumber(data.status), mediaType,
      tmdbId: optionalNumber(media.tmdbId), tvdbId: optionalNumber(media.tvdbId), is4k: Boolean(data.is4k), requestedById: optionalNumber(object(data.requestedBy).id),
      seasons: list(data.seasons).map((season) => ({ seasonNumber: optionalNumber(season.seasonNumber), status: REQUEST_STATUS[num(season.status)] ?? "unknown" })),
      availability: MEDIA_STATUS[num(data.is4k ? media.status4k : media.status)] ?? "unknown",
      arrId: optionalNumber(data.is4k ? media.externalServiceId4k : media.externalServiceId),
      mediaUrl: (mediaType === "movie" || mediaType === "tv") && positive(media.tmdbId) ? this.mediaUrl(mediaType, Number(media.tmdbId)) : undefined };
  }

  private mediaUrl(type: SeerrMediaType, id: number) { return `${this.settings.url.replace(/\/$/, "")}/${type}/${id}`; }
  private validateMedia(type: string, id: number) { if (!["movie", "tv"].includes(type) || !positive(id)) throw new Error("A movie/TV type and positive TMDB ID are required"); }

  private userId(): Promise<number> { return this.userPromise ??= this.resolveUser(); }
  private async resolveUser(): Promise<number> {
    if (!this.discordUserId) throw new Error("A Discord requester is required for Seerr operations");
    const explicit = parseSeerrUserMappings(this.settings.userMappings).get(this.discordUserId);
    let mapped = explicit;
    if (!mapped) {
      const users: Data[] = [];
      for (let skip = 0; skip < 200; skip += 100) {
        const page = await this.http(buildQueryPath("/user", { take: 100, skip }));
        const current = list(page.results);
        users.push(...current);
        const total = num(object(page.pageInfo).results);
        if (current.length < 100 || users.length >= total && total > 0) break;
        if (skip === 100) throw new Error("Seerr has too many users for automatic linking; configure an explicit Discord user mapping");
      }
      const matches: number[] = [];
      for (let offset = 0; offset < users.length; offset += 5) {
        const batch = await Promise.all(users.slice(offset, offset + 5).map(async (user) => {
          if (!positive(user.id)) return undefined;
          const preferences = await this.http(`/user/${user.id}/settings/notifications`);
          const linked = Array.isArray(preferences.discordIds) ? preferences.discordIds : [preferences.discordId];
          return linked.includes(this.discordUserId) ? Number(user.id) : undefined;
        }));
        matches.push(...batch.filter((value): value is number => value !== undefined));
      }
      if (matches.length > 1) throw new Error("Discord account is linked to multiple Seerr users; configure an explicit mapping");
      mapped = matches[0] ?? (positive(this.settings.defaultUserId) ? this.settings.defaultUserId : undefined);
      if (!mapped) throw new Error("Discord account is not linked to Seerr. Add its Discord ID in Seerr notification settings or configure a Discord user mapping in Connections.");
    }
    const acting = await this.http("/auth/me", mapped);
    if (acting.id !== mapped) throw new Error("Seerr did not confirm the mapped requester; refusing administrator fallback");
    return mapped;
  }

  private async http(path: string, userId?: number, options: { method?: string; body?: unknown } = {}): Promise<Data> {
    if (!this.isConfigured()) throw new Error("Seerr is not configured in Connections");
    const base = new URL(this.settings.url);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Seerr URL must be an HTTP(S) address without embedded credentials, query or fragment");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutSeconds * 1000);
    try {
      const response = await fetch(`${this.settings.url.replace(/\/$/, "")}/api/v1${path}`, {
        method: options.method ?? "GET", redirect: "error", signal: controller.signal,
        headers: { "X-Api-Key": this.settings.apiKey, Accept: "application/json", ...(userId ? { "X-Api-User": String(userId) } : {}), ...(options.body ? { "Content-Type": "application/json" } : {}) },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      if (!response.ok) { await response.body?.cancel(); throw new SeerrHttpError(response.status); }
      if (!response.body) throw new Error("Empty Seerr response");
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error("Seerr response too large"); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid Seerr response");
      return data as Data;
    } catch (error) {
      if (error instanceof SeerrHttpError) throw error;
      throw new Error(controller.signal.aborted
        ? "Seerr request timed out. Inspect request status before retrying a submission."
        : "Seerr request failed or returned invalid data. Inspect request status before retrying a submission.");
    } finally { clearTimeout(timer); }
  }
}

function object(value: unknown): Data { return value && typeof value === "object" && !Array.isArray(value) ? value as Data : {}; }
function list(value: unknown): Data[] { return Array.isArray(value) ? value.map(object) : []; }
function num(value: unknown) { return typeof value === "number" ? value : 0; }
function optionalNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function positive(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function dateYear(value: unknown) { return typeof value === "string" ? Number(value.slice(0, 4)) : undefined; }
function bounded(value: unknown) { if (JSON.stringify(value).length > 10000) throw new Error("Seerr results exceed the compact output limit; use a more specific lookup"); }

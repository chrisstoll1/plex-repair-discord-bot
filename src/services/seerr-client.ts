import { parseSeerrUserMappings, type SeerrSettings } from "../domain/settings.js";
import { buildQueryPath } from "./http.js";

export type SeerrMediaType = "movie" | "tv";
export type SeerrDestination = { serverId: number; profileId: number; rootFolder: string };
export type SeerrRequestParams = { mediaType: SeerrMediaType; tmdbId: number; title: string; year: number; is4k?: boolean; seasons?: number[]; allSeasons?: boolean; destination?: SeerrDestination };
export type SeerrRequestTarget = { requestId: number; mediaType: SeerrMediaType; tmdbId: number; expectedIs4k: boolean };
export type SeerrRequestUpdate = SeerrRequestTarget & { destination: SeerrDestination };
export type SeerrRequestReplacement = SeerrRequestUpdate & { title: string; year: number; is4k: boolean };
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
    const data = await this.requestDetails(requestId);
    const result = this.compactRequest(data);
    bounded(result);
    return result;
  }

  async getRequestOptions(mediaType: SeerrMediaType, serverId?: number) {
    this.validateMedia(mediaType, 1);
    const provider = mediaType === "movie" ? "radarr" : "sonarr";
    const userId = await this.userId();
    if (serverId === undefined) {
      const data = await this.http(`/service/${provider}`, userId, { array: true });
      const result = { servers: list(data.results).map(compactServer) };
      bounded(result);
      return result;
    }
    if (!nonnegative(serverId)) throw new Error("A non-negative Seerr server ID is required");
    const data = await this.http(`/service/${provider}/${serverId}`, userId);
    if (object(data.server).id !== serverId) throw new Error("Seerr returned a different destination server");
    const result = { server: compactServer(object(data.server)),
      profiles: list(data.profiles).map((profile) => ({ id: optionalNumber(profile.id), name: string(profile.name) })),
      rootFolders: list(data.rootFolders).map((folder) => ({ id: optionalNumber(folder.id), path: string(folder.path), freeSpace: optionalNumber(folder.freeSpace) })),
    };
    bounded(result);
    return result;
  }

  async updateRequest(params: SeerrRequestUpdate) {
    const data = await this.targetRequest(params);
    if (data.status !== 1) throw new Error("Seerr only edits pending requests. Approved requests cannot be converted in place; inspect the linked Arr item or use an explicitly authorized replacement.");
    await this.validateDestination(params.mediaType, params.expectedIs4k, params.destination);
    const seasons = params.mediaType === "tv" ? requestSeasons(data) : [];
    // PUT replaces these fields, so retain tags, language and the exact TV scope.
    const body = { ...destinationBody(params.destination), tags: Array.isArray(data.tags) ? data.tags.filter(positive) : [],
      ...(params.mediaType === "tv" ? { seasons, languageProfileId: optionalNumber(data.languageProfileId) } : {}) };
    await this.http(`/request/${params.requestId}`, await this.userId(), { method: "PUT", body });
    const current = await this.targetRequest(params);
    const scopePreserved = object(current.requestedBy).id === object(data.requestedBy).id
      && (params.mediaType !== "tv" || sameSeasons(current, data));
    const updated = scopePreserved && destinationMatches(current, params.destination);
    return { updated, request: this.compactRequest(current), note: updated
      ? "Pending request destination updated and verified. Approval requirements remain in Seerr."
      : "Seerr accepted the edit but did not confirm the requested destination and original scope. Inspect current state before another write." };
  }

  async retryRequest(params: SeerrRequestTarget) {
    const data = await this.targetRequest(params);
    if (data.status !== 4) throw new Error("Seerr only retries failed requests. Do not approve or change a request's status to force a retry; inspect its linked Arr destination instead.");
    await this.http(`/request/${params.requestId}/retry`, await this.userId(), { method: "POST" });
    return { retryTriggered: true, request: this.compactRequest(await this.targetRequest(params)),
      note: "Seerr accepted the retry. This is not proof of downloading, import or Plex availability; inspect the resulting destination and media state." };
  }

  async deleteRequest(params: SeerrRequestTarget) {
    await this.targetRequest(params);
    await this.http(`/request/${params.requestId}`, await this.userId(), { method: "DELETE" });
    let deleted = false;
    try { await this.requestDetails(params.requestId); }
    catch (error) { if (error instanceof SeerrHttpError && error.status === 404) deleted = true; else throw error; }
    return { deleted, requestId: params.requestId, note: deleted
      ? "Only the Seerr request record was removed. No Arr removal or file deletion was requested."
      : "Seerr accepted deletion but the request is still readable; inspect before retrying." };
  }

  async replaceRequest(params: SeerrRequestReplacement) {
    const source = await this.targetRequest(params);
    const userId = await this.userId();
    if (object(source.requestedBy).id !== userId) throw new Error("Replacement must preserve the requester. This request belongs to a different Seerr account; no administrator fallback or reassignment is allowed.");
    if (typeof params.is4k !== "boolean" || params.is4k === params.expectedIs4k) throw new Error("Safe replacement requires a different 4K scope so the new request can be verified before removing the original. Use a pending-request edit or existing Arr repair for the same scope.");
    if (![1, 2, 4].includes(num(source.status))) throw new Error("Only pending, approved or failed requests can be replaced");
    const seasons = params.mediaType === "tv" ? requestSeasons(source) : [];
    const creation = await this.requestMedia({ mediaType: params.mediaType, tmdbId: params.tmdbId, title: params.title, year: params.year,
      is4k: params.is4k, destination: params.destination, ...(params.mediaType === "tv" ? { seasons } : {}) });
    if (!("request" in creation) || !creation.request?.id) return { replaced: false, originalRetained: true, creation,
      note: "No new replacement was created. The original request was retained; inspect the existing destination scope before taking another action." };
    const replacementTarget = { ...params, requestId: creation.request.id, expectedIs4k: params.is4k };
    let replacement: Data;
    try { replacement = await this.targetRequest(replacementTarget); }
    catch { return { replaced: false, originalRetained: true, request: creation.request,
      note: "Replacement creation returned this request ID, but its current state could not be verified. The original was retained; inspect both IDs before retrying." }; }
    const replacementVerified = object(replacement.requestedBy).id === userId && destinationMatches(replacement, params.destination)
      && (params.mediaType !== "tv" || sameSeasons(source, replacement));
    if (!replacementVerified || replacement.status !== 2) return { replaced: false, originalRetained: true, request: this.compactRequest(replacement),
      note: "Replacement recorded, but approval or exact destination/scope verification is incomplete. The original was retained. Do not resubmit or bypass approval." };
    // Recheck the source after creation; never remove a request that changed meanwhile.
    let current: Data;
    try { current = await this.targetRequest(params); }
    catch { return { replaced: false, originalRetained: true, request: this.compactRequest(replacement),
      note: "Replacement verified, but the original could not be rechecked. No removal attempted; inspect both IDs before retrying." }; }
    if (!sameRequestSnapshot(current, source)) return { replaced: false, originalRetained: true, request: this.compactRequest(replacement),
      note: "Replacement verified, but the original request changed during replacement. Retained both records for inspection." };
    try {
      const removal = await this.deleteRequest(params);
      return { replaced: removal.deleted, originalRetained: !removal.deleted, originalRequestId: params.requestId,
        request: this.compactRequest(replacement), removal, note: "Replacement recorded and verified before original request removal. Verify download/import and Plex availability separately." };
    } catch {
      return { replaced: false, originalRemovalUnverified: true, originalRequestId: params.requestId, request: this.compactRequest(replacement),
        note: "Replacement was created and verified, but original request removal failed or could not be verified. Inspect both IDs; do not create another replacement." };
    }
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
    if (params.destination) await this.validateDestination(params.mediaType, is4k, params.destination);
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
      // Act as the resolved Discord user; Seerr enforces advanced destination
      // permissions, approval and quotas. Never send user or quota overrides.
      const response = await this.http("/request", userId, {
        method: "POST", body: { mediaType: params.mediaType, mediaId: params.tmdbId, is4k, ...(seasons ? { seasons } : {}), ...(params.destination ? destinationBody(params.destination) : {}) },
      });
      if (!positive(response.id) || object(response.media).tmdbId !== params.tmdbId || response.type !== params.mediaType || response.is4k !== is4k || object(response.requestedBy).id !== userId) {
        throw new Error("Seerr response did not confirm the exact request. Check media/request status before retrying; it may have been accepted.");
      }
      const result = { created: true, request: this.compactRequest(response),
        ...(params.destination ? { destinationVerified: destinationMatches(response, params.destination) } : {}),
        note: "Request recorded in Seerr. Pending approval is not a download, and approval is not Plex availability. Keep request ID/link in the repair checkpoint and continue status verification." };
      bounded(result);
      return result;
    } catch (error) {
      if (error instanceof SeerrHttpError && error.status === 409) return { created: false, duplicate: true, media: this.compactMedia(await this.details(params.mediaType, params.tmdbId, userId), params.mediaType), note: "Seerr reported an existing request; inspect its current status instead of resubmitting." };
      throw error;
    }
  }

  private async requestDetails(requestId: number) {
    if (!positive(requestId)) throw new Error("A positive Seerr request ID is required");
    const data = await this.http(`/request/${requestId}`, await this.userId());
    if (data.id !== requestId) throw new Error("Seerr returned a different request ID");
    return data;
  }

  private async targetRequest(params: SeerrRequestTarget) {
    this.validateMedia(params.mediaType, params.tmdbId);
    if (typeof params.expectedIs4k !== "boolean") throw new Error("The existing request's 4K scope is required");
    const data = await this.requestDetails(params.requestId);
    if (data.type !== params.mediaType || object(data.media).tmdbId !== params.tmdbId || data.is4k !== params.expectedIs4k) throw new Error("Seerr request does not match the expected media identity and 4K scope; no action was taken");
    return data;
  }

  private async validateDestination(mediaType: SeerrMediaType, is4k: boolean, destination: SeerrDestination) {
    if (!destination || !nonnegative(destination.serverId) || !positive(destination.profileId) || typeof destination.rootFolder !== "string" || !destination.rootFolder.trim()) throw new Error("An existing Seerr server, quality profile and root folder are required");
    const options = await this.getRequestOptions(mediaType, destination.serverId);
    if (!("server" in options) || options.server.is4k !== is4k || !options.profiles.some((profile) => profile.id === destination.profileId)
      || !options.rootFolders.some((folder) => folder.path === destination.rootFolder)) throw new Error("Destination must match the requested 4K scope and an existing Seerr server profile/root folder");
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
      serviceId: optionalNumber(info.serviceId), serviceId4k: optionalNumber(info.serviceId4k),
      serviceUrl: safeUrl(info.serviceUrl), serviceUrl4k: safeUrl(info.serviceUrl4k),
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
      serviceId: optionalNumber(data.is4k ? media.serviceId4k : media.serviceId), serviceUrl: safeUrl(data.is4k ? media.serviceUrl4k : media.serviceUrl),
      serverId: optionalNumber(data.serverId), profileId: optionalNumber(data.profileId), rootFolder: string(data.rootFolder),
      createdAt: string(data.createdAt), updatedAt: string(data.updatedAt),
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

  private async http(path: string, userId?: number, options: { method?: string; body?: unknown; array?: boolean } = {}): Promise<Data> {
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
      if (response.status === 204 && options.method === "DELETE") { await response.body?.cancel(); return {}; }
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
      if (options.array) {
        if (!Array.isArray(data)) throw new Error("Invalid Seerr server list");
        return { results: data };
      }
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
function nonnegative(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function compactServer(data: Data) { return { id: optionalNumber(data.id), name: string(data.name), is4k: typeof data.is4k === "boolean" ? data.is4k : undefined,
  isDefault: typeof data.isDefault === "boolean" ? data.isDefault : undefined, activeProfileId: optionalNumber(data.activeProfileId), activeDirectory: string(data.activeDirectory) }; }
function destinationBody(destination: SeerrDestination) { return { serverId: destination.serverId, profileId: destination.profileId, rootFolder: destination.rootFolder }; }
function destinationMatches(data: Data, destination: SeerrDestination) { return data.serverId === destination.serverId && data.profileId === destination.profileId && data.rootFolder === destination.rootFolder; }
function sameSeasons(left: Data, right: Data) { const numbers = (data: Data) => list(data.seasons).map((season) => season.seasonNumber).sort((a, b) => num(a) - num(b)); return JSON.stringify(numbers(left)) === JSON.stringify(numbers(right)); }
function requestSeasons(data: Data): number[] { const seasons = list(data.seasons).map((season) => season.seasonNumber); if (!seasons.length || seasons.some((season) => !nonnegative(season))) throw new Error("Cannot preserve the existing TV request season scope"); return seasons as number[]; }
function sameRequestSnapshot(left: Data, right: Data) { return left.status === right.status && left.updatedAt === right.updatedAt && object(left.requestedBy).id === object(right.requestedBy).id
  && left.serverId === right.serverId && left.profileId === right.profileId && left.rootFolder === right.rootFolder && sameSeasons(left, right); }
function safeUrl(value: unknown): string | undefined { if (typeof value !== "string") return undefined; try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? url.toString() : undefined; } catch { return undefined; } }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function dateYear(value: unknown) { return typeof value === "string" ? Number(value.slice(0, 4)) : undefined; }
function bounded(value: unknown) { if (JSON.stringify(value).length > 10000) throw new Error("Seerr results exceed the compact output limit; use a more specific lookup"); }

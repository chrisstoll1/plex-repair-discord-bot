import { buildQueryPath } from "./http.js";

export type DirectAddParams = { title: string; year: number; rootFolderPath: string; qualityProfileId: number; search?: boolean };
export type AddMovieParams = DirectAddParams & { tmdbId: number };
export type AddSeriesParams = DirectAddParams & { tvdbId: number; seriesType: "standard" | "anime" | "daily"; seasonFolder: boolean; seasonNumbers?: number[] };
type RecordValue = Record<string, unknown>;
type Request = (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>;

export class ArrAddClient {
  constructor(private readonly service: "sonarr" | "radarr", private readonly request: Request) {}

  async getOptions(seriesType?: "standard" | "anime" | "daily") {
    const [roots, profiles, library] = await this.configuration();
    const counts = new Map<string, { rootFolderPath: string; qualityProfileId: number; seriesType?: string; seasonFolder?: boolean; count: number }>();
    for (const item of library) {
      if (seriesType && item.seriesType !== seriesType) continue;
      const root = roots.find((root) => typeof root.path === "string" && (item.rootFolderPath === root.path || isInside(item.path, root.path)));
      if (!root || root.accessible === false || !profiles.some((profile) => profile.id === item.qualityProfileId)) continue;
      const choice = { rootFolderPath: String(root.path), qualityProfileId: Number(item.qualityProfileId),
        ...(this.service === "sonarr" ? { seriesType: String(item.seriesType ?? "standard"), seasonFolder: item.seasonFolder !== false } : {}) };
      const key = JSON.stringify(choice);
      const previous = counts.get(key);
      counts.set(key, { ...choice, count: (previous?.count ?? 0) + 1 });
    }
    const usage = [...counts.values()].sort((a, b) => b.count - a.count);
    const recommended = usage[0] && (!usage[1] || usage[0].count > usage[1].count) ? usage[0] : undefined;
    const result = { roots: roots.map((root) => pick(root, ["id", "path", "accessible", "freeSpace"])),
      qualityProfiles: profiles.map((profile) => pick(profile, ["id", "name", "upgradeAllowed", "cutoff"])),
      existingItemCount: library.length, usage: usage.slice(0, 12), recommended,
      note: "Recommendations reflect existing library usage, not a configured service default. Select an accessible root and an existing quality profile appropriate to the requested content." };
    bounded(result);
    return result;
  }

  async addMovie(params: AddMovieParams) {
    if (this.service !== "radarr") throw new Error("Movie addition is only available for Radarr");
    return this.add(params, params.tmdbId);
  }

  async addSeries(params: AddSeriesParams) {
    if (this.service !== "sonarr") throw new Error("Series addition is only available for Sonarr");
    if (!["standard", "anime", "daily"].includes(params.seriesType) || typeof params.seasonFolder !== "boolean") throw new Error("A valid series type and season-folder choice are required");
    return this.add(params, params.tvdbId);
  }

  private async add(params: AddMovieParams | AddSeriesParams, externalId: number) {
    if (!Number.isSafeInteger(externalId) || externalId <= 0 || !Number.isSafeInteger(params.qualityProfileId) || params.qualityProfileId <= 0
      || !params.title.trim() || !Number.isInteger(params.year) || params.year < 1800 || params.year > 2200
      || typeof params.rootFolderPath !== "string" || !params.rootFolderPath || (params.search !== undefined && typeof params.search !== "boolean")) {
      throw new Error("Exact external ID, title/year, root folder, quality profile and valid search option are required");
    }
    const idKey = this.service === "radarr" ? "tmdbId" : "tvdbId";
    const base = this.service === "radarr" ? "/api/v3/movie" : "/api/v3/series";
    const [roots, profiles, library] = await this.configuration();
    const duplicate = unique(library.filter((item) => item[idKey] === externalId));
    if (duplicate) return { added: false, alreadyExists: true, searchRequested: false, media: compact(duplicate), note: "Existing item was preserved. Use its ID for any requested monitoring/search repair; no add or search was repeated." };
    if (!roots.some((root) => root.path === params.rootFolderPath && root.accessible !== false)) throw new Error("Selected root folder is not configured or is inaccessible");
    if (!profiles.some((profile) => profile.id === params.qualityProfileId)) throw new Error("Selected quality profile is not configured");
    const term = `${this.service === "radarr" ? "tmdb" : "tvdb"}:${externalId}`;
    const lookups = records(await this.request(buildQueryPath(`${base}/lookup`, { term })));
    const metadata = unique(lookups.filter((item) => item[idKey] === externalId));
    if (!metadata || metadata.title !== params.title || metadata.year !== params.year) throw new Error("Exact lookup identity/title/year does not match the requested addition");
    if (Number(metadata.id) > 0) return { added: false, alreadyExists: true, searchRequested: false, media: compact(metadata) };
    const body: RecordValue = { ...pick(metadata, ["title", "titleSlug", "year", "images", "originalTitle", "originalLanguage", "imdbId", "tmdbId", "tvdbId", "tvMazeId"]),
      [idKey]: externalId, rootFolderPath: params.rootFolderPath, qualityProfileId: params.qualityProfileId, monitored: true };
    let selectedSeasons: number[] | undefined;
    if (this.service === "radarr") {
      body.minimumAvailability = "released";
      body.addOptions = { monitor: "movieOnly", searchForMovie: params.search !== false };
    } else {
      const series = params as AddSeriesParams;
      const seasons = records(metadata.seasons);
      if (!seasons.every((season) => Number.isInteger(season.seasonNumber) && Number(season.seasonNumber) >= 0)) throw new Error("Sonarr lookup returned invalid season metadata");
      selectedSeasons = series.seasonNumbers ?? seasons.map((season) => Number(season.seasonNumber)).filter((season) => season > 0);
      if ((series.seasonNumbers && !series.seasonNumbers.length) || selectedSeasons.some((season) => !Number.isInteger(season) || season < 0 || !seasons.some((item) => item.seasonNumber === season))) throw new Error("Selected seasons must exist in the exact series lookup");
      selectedSeasons = [...new Set(selectedSeasons)].sort((a, b) => a - b);
      body.seriesType = series.seriesType;
      body.seasonFolder = series.seasonFolder;
      body.monitorNewItems = series.seasonNumbers ? "none" : "all";
      body.seasons = seasons.map((season) => ({ seasonNumber: season.seasonNumber, monitored: selectedSeasons!.includes(Number(season.seasonNumber)) }));
      // Sonarr's Skip monitor mode preserves the submitted season selection.
      body.addOptions = { monitor: "skip", searchForMissingEpisodes: params.search !== false, searchForCutoffUnmetEpisodes: false };
    }
    // Recheck for another task having added the same external ID during lookup.
    const existing = unique(records(await this.request(base)).filter((item) => item[idKey] === externalId));
    if (existing) return { added: false, alreadyExists: true, searchRequested: false, media: compact(existing) };
    const response = await this.request(base, { method: "POST", body });
    if (!isRecord(response) || !Number.isSafeInteger(response.id) || Number(response.id) <= 0 || response[idKey] !== externalId) {
      throw new Error("Add response did not confirm the exact media ID. Inspect the library before retrying; the add may have succeeded.");
    }
    return { added: true, alreadyExists: false, searchRequested: params.search !== false, selectedSeasons,
      media: compact(response), note: "Added to the manager; this does not prove a download started or Plex availability. Inspect queue/history/file state, then verify Plex or wait for an import event." };
  }

  private async configuration() {
    const results = await Promise.all([
      this.request("/api/v3/rootfolder"), this.request("/api/v3/qualityprofile"),
      this.request(this.service === "radarr" ? "/api/v3/movie" : "/api/v3/series"),
    ]);
    return results.map(records) as [RecordValue[], RecordValue[], RecordValue[]];
  }
}

function isRecord(value: unknown): value is RecordValue { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function records(value: unknown): RecordValue[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("Expected a complete Arr record list");
  return value;
}
function unique(values: RecordValue[]) { if (values.length > 1) throw new Error("Multiple existing items match the external ID; inspect before changing anything"); return values[0]; }
function pick(value: RecordValue, keys: string[]): RecordValue { return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])); }
function compact(value: RecordValue) {
  const result = pick(value, ["id", "title", "year", "tmdbId", "tvdbId", "imdbId", "path", "rootFolderPath", "qualityProfileId", "monitored", "hasFile", "movieFileId", "seriesType", "seasonFolder"]);
  if (Array.isArray(value.seasons)) result.seasons = records(value.seasons).map((season) => pick(season, ["seasonNumber", "monitored"]));
  bounded(result);
  return result;
}
function bounded(value: unknown) { if (JSON.stringify(value).length > 10000) throw new Error("Arr options exceed the compact output limit"); }
function isInside(value: unknown, root: string): boolean { return typeof value === "string" && (value.startsWith(`${root.replace(/[\\/]+$/, "")}/`) || value.startsWith(`${root.replace(/[\\/]+$/, "")}\\`)); }

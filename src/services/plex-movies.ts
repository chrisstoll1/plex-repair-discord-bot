import { buildQueryPath } from "./http.js";

export type PlexMoviePart = { id: string; file: string; size?: number; exists?: boolean; accessible?: boolean };
export type PlexMovie = {
  ratingKey: string; sectionId?: number; title: string; year?: number; guid: string; guids: string[];
  media: Array<{ id: string; duration?: number; parts: PlexMoviePart[] }>;
};
export type PlexMovieMatch = { guid: string; title: string; year?: number; score?: number; guids?: string[]; identityVerified?: boolean };
export type PlexMovieSearch = { sectionId: number; title: string; year?: number; offset?: number; limit?: number };
export type PlexMovieMatchQuery = { ratingKey: string; externalId: string };
export type PlexMovieSplit = { ratingKey: string; expectedParts: Array<{ id: string; file: string }> };
export type PlexMovieFixMatch = PlexMovieMatchQuery & {
  expectedPart: { id: string; file: string }; expectedCurrentGuid: string;
  matchGuid: string; title: string; year: number;
};

type Request = (path: string, method?: string) => Promise<string>;

export class PlexMovieClient {
  constructor(private readonly request: Request, private readonly requestProvider: (movieId: string) => Promise<string>) {}

  async getMovie(ratingKey: string): Promise<PlexMovie> {
    id(ratingKey);
    const xml = await this.request(buildQueryPath(`/library/metadata/${ratingKey}`, { includeGuids: 1 }));
    const movies = parseMovies(xml);
    if (movies.length !== 1 || movies[0]!.ratingKey !== ratingKey) throw new Error("Plex did not return the exact requested movie");
    const movie = movies[0]!;
    ensureOutputFits(movie);
    return movie;
  }

  async findMovies(query: PlexMovieSearch) {
    id(String(query.sectionId));
    if (!query.title.trim() || query.title.length > 200) throw new Error("A specific Plex movie title is required");
    if (query.year !== undefined) year(query.year);
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 5;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid Plex movie page");
    const xml = await this.request(buildQueryPath(`/library/sections/${query.sectionId}/all`, {
      type: 1, title: query.title, year: query.year, includeGuids: 1,
      "X-Plex-Container-Start": offset, "X-Plex-Container-Size": limit,
    }));
    const all = parseMovies(xml);
    const container = attributes(/<MediaContainer\b([^>]*)>/.exec(xml)?.[1] ?? "");
    const returnedOffset = number(container.offset) ?? 0;
    if (returnedOffset !== offset) throw new Error("Plex did not honor movie pagination; cannot claim complete results");
    const total = number(container.totalSize) ?? offset + all.length;
    if (!all.length && total > offset) throw new Error("Plex returned an incomplete empty movie page");
    const movies: PlexMovie[] = [];
    for (const movie of all.slice(0, limit)) {
      if (JSON.stringify([...movies, movie]).length > 9000) break;
      movies.push(movie);
    }
    if (all.length && !movies.length) throw new Error("Plex movie details exceed output limit; inspect the individual movie");
    const hasMore = offset + movies.length < total;
    return { movies, offset, total, hasMore, nextOffset: hasMore ? offset + movies.length : undefined };
  }

  async getMovieMatches(query: PlexMovieMatchQuery) {
    id(query.ratingKey);
    const title = externalSearch(query.externalId);
    const xml = await this.request(buildQueryPath(`/library/metadata/${query.ratingKey}/matches`, {
      manual: 1, title, agent: "tv.plex.agents.movie", language: "en-US",
    }));
    const matches = [...xml.matchAll(/<SearchResult\b([^>]*)\/?\s*>/g)].map((match): PlexMovieMatch => {
      const value = attributes(match[1]!);
      return { guid: value.guid ?? "", title: value.name ?? value.title ?? "", year: number(value.year), score: number(value.score) };
    }).filter((match) => match.guid && match.title);
    // Only one exact-ID result can be safe. Independently bind its Plex GUID to
    // the external ID via Plex's fixed metadata provider, never a supplied URL.
    if (matches.length === 1) {
      const candidate = matches[0]!;
      const movieId = /^plex:\/\/movie\/([a-f\d]{24})$/.exec(candidate.guid)?.[1];
      if (movieId) {
        const metadata = parseMovies(await this.requestProvider(movieId));
        if (metadata.length === 1) {
          candidate.guids = metadata[0]!.guids;
          candidate.identityVerified = metadata[0]!.guid === candidate.guid
            && metadata[0]!.guids.includes(query.externalId)
            && metadata[0]!.title === candidate.title && metadata[0]!.year === candidate.year;
        }
      }
    }
    const result = { externalId: query.externalId, matches, exactLookup: true };
    ensureOutputFits(result);
    return result;
  }

  async splitMovie(query: PlexMovieSplit) {
    const before = await this.getMovie(query.ratingKey);
    const parts = before.media.flatMap((media) => media.parts);
    if (before.media.length < 2 || parts.length < 2) throw new Error("Split requires a movie containing at least two media versions");
    if (!query.expectedParts.length || query.expectedParts.some((part) => !part.id || !part.file)) throw new Error("Expected part IDs and exact paths are required before splitting");
    if (partSnapshot(parts) !== partSnapshot(query.expectedParts)) throw new Error("Plex movie parts changed; inspect again before splitting");
    await this.request(`/library/metadata/${query.ratingKey}/split`, "PUT");
    return {
      splitRequested: true, sectionId: before.sectionId, previousRatingKey: before.ratingKey,
      previousTitle: before.title, preservedParts: query.expectedParts,
      verificationRequired: "Search compact movie results and reidentify every separated item by exact part ID and file path. Split-generated rating keys must not be assumed. Do not repeat a split after a timeout without inspecting current state.",
    };
  }

  async fixMovieMatch(query: PlexMovieFixMatch) {
    year(query.year);
    const before = await this.getMovie(query.ratingKey);
    requireSinglePart(before, query.expectedPart);
    if (before.guid !== query.expectedCurrentGuid) throw new Error("Plex identity changed; inspect again before matching");
    const lookup = await this.getMovieMatches(query);
    const matches = lookup.matches.filter((match) => match.guid === query.matchGuid
      && match.title === query.title && match.year === query.year);
    if (lookup.matches.length !== 1 || matches.length !== 1 || !matches[0]!.identityVerified) throw new Error("Selected Plex match is not uniquely verified against the external ID, title and year");
    // Recheck parts after the lookup, immediately before the mutation.
    const current = await this.getMovie(query.ratingKey);
    requireSinglePart(current, query.expectedPart);
    if (current.guid !== before.guid) throw new Error("Plex identity changed while resolving the match; inspect again");
    await this.request(buildQueryPath(`/library/metadata/${query.ratingKey}/match`, {
      guid: matches[0]!.guid, name: matches[0]!.title, year: matches[0]!.year,
    }), "PUT");
    const after = await this.getMovie(query.ratingKey);
    const partsPreserved = partSnapshot(after.media.flatMap((media) => media.parts)) === partSnapshot([query.expectedPart]);
    return {
      matchRequested: true, externalId: query.externalId, movie: after, partsPreserved,
      verified: partsPreserved && after.guids.includes(query.externalId) && after.title === query.title && after.year === query.year,
      note: "A submitted match is not proof of completion. If verified=false, inspect metadata again; do not repeat writes blindly. Also verify all other split items retain their original files and identities.",
    };
  }
}

function requireSinglePart(movie: PlexMovie, expected: { id: string; file: string }) {
  if (!expected.id || !expected.file || movie.media.length !== 1 || movie.media[0]!.parts.length !== 1
    || partSnapshot(movie.media[0]!.parts) !== partSnapshot([expected])) {
    throw new Error("Fix Match requires one isolated media version with the exact expected part ID and path; split merged versions first");
  }
}

function partSnapshot(parts: Array<{ id: string; file: string }>): string {
  return JSON.stringify(parts.map(({ id, file }) => [id, file]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

function externalSearch(value: string): string {
  if (/^tmdb:\/\/[1-9]\d*$/.test(value)) return value.replace("tmdb://", "tmdb-");
  if (/^imdb:\/\/tt\d+$/.test(value)) return value.slice("imdb://".length);
  throw new Error("An exact tmdb://movieID or imdb://ttID is required");
}

function id(value: string): void {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("A single positive numeric Plex ID is required");
}

function year(value: number): void {
  if (!Number.isInteger(value) || value < 1800 || value > 2200) throw new Error("A valid movie year is required");
}

function ensureOutputFits(value: unknown): void {
  if (JSON.stringify(value).length > 10_000) throw new Error("Plex movie metadata exceeds the compact output limit");
}

function number(value: string | undefined): number | undefined {
  return value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined;
}

function blocks(xml: string, tag: string) {
  return [...xml.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "g"))]
    .map((match) => ({ attributes: attributes(match[1]!), content: match[2]! }));
}

function tags(xml: string, tag: string) {
  return [...xml.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "g"))].map((match) => attributes(match[1]!));
}

function attributes(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1]!, decode(match[2]!)]));
}

function decode(text: string): string {
  return text.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!;
    const hex = entity.toLowerCase().startsWith("&#x");
    const point = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

function parseMovies(xml: string): PlexMovie[] {
  return blocks(xml, "Video").map(({ attributes: value, content }) => {
    if (value.type !== "movie") throw new Error("Plex returned non-movie metadata; movie repair is not allowed");
    return {
      ratingKey: value.ratingKey ?? "", sectionId: number(value.librarySectionID), title: value.title ?? "",
      year: number(value.year), guid: value.guid ?? "", guids: tags(content, "Guid").map((guid) => guid.id!).filter(Boolean),
      media: blocks(content, "Media").map(({ attributes: media, content: mediaContent }) => ({
        id: media.id ?? "", duration: number(media.duration),
        parts: tags(mediaContent, "Part").map((part) => ({
          id: part.id ?? "", file: part.file ?? "", size: number(part.size),
          ...(part.exists === undefined ? {} : { exists: part.exists === "1" }),
          ...(part.accessible === undefined ? {} : { accessible: part.accessible === "1" }),
        })),
      })),
    };
  });
}

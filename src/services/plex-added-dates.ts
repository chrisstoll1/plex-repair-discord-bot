import { buildQueryPath } from "./http.js";

export type PlexFutureAddedQuery = { sectionId: number; title?: string };
export type PlexAddedDateFix = { ratingKey: string; expectedFutureCount: number; addedAt?: string };

type Request = (path: string, method?: string) => Promise<string>;
type DatedItem = {
  ratingKey: string; type: string; title: string; addedAt: number; originallyAvailableAt?: string;
  sectionId?: number; showRatingKey?: string; showTitle?: string; seasonNumber?: number; episodeNumber?: number;
};

const FUTURE_TOLERANCE_SECONDS = 86_400;
const PAGE_SIZE = 200;
const MAX_SCANNED = 10_000;
const MAX_FIX_ITEMS = 2_000;
const MAX_GROUPS = 25;
const WRITE_CONCURRENCY = 4;
const TYPE_IDS: Record<string, number> = { movie: 1, show: 2, season: 3, episode: 4 };

export class PlexAddedDateClient {
  constructor(private readonly request: Request, private readonly now: () => number = () => Date.now()) {}

  async findFutureAdded(query: PlexFutureAddedQuery) {
    positiveId(String(query.sectionId));
    const sectionType = await this.sectionType(query.sectionId);
    const leafType = sectionType === "show" ? "episode" : sectionType === "movie" ? "movie" : undefined;
    if (!leafType) throw new Error(`Plex library section ${query.sectionId} is a ${sectionType ?? "unknown"} library; only TV and movie libraries are supported`);
    const threshold = this.threshold();
    const future: DatedItem[] = [];
    let offset = 0;
    let scanned = 0;
    let previous = Number.POSITIVE_INFINITY;
    let complete = false;
    while (scanned < MAX_SCANNED) {
      const xml = await this.request(buildQueryPath(`/library/sections/${query.sectionId}/all`, {
        type: TYPE_IDS[leafType], sort: "addedAt:desc", "X-Plex-Container-Start": offset, "X-Plex-Container-Size": PAGE_SIZE,
      }));
      const returnedOffset = number(container(xml).offset) ?? 0;
      if (returnedOffset !== offset) throw new Error("Plex did not honor pagination; cannot claim complete results");
      const page = parseItems(xml);
      scanned += page.length;
      for (const item of page) {
        if (item.addedAt > previous) throw new Error("Plex did not honor addedAt sorting; cannot claim complete results");
        previous = item.addedAt;
        if (item.addedAt <= threshold) { complete = true; break; }
        future.push(item);
      }
      if (complete || page.length < PAGE_SIZE) { complete = true; break; }
      offset += page.length;
    }
    const filter = query.title?.trim().toLowerCase();
    const groups = new Map<string, { ratingKey: string; title: string; type: string; items: DatedItem[] }>();
    for (const item of future) {
      const key = item.showRatingKey ?? item.ratingKey;
      const title = item.showTitle ?? item.title;
      if (filter && !title.toLowerCase().includes(filter)) continue;
      const group = groups.get(key) ?? { ratingKey: key, title, type: item.showRatingKey ? "show" : item.type, items: [] };
      group.items.push(item);
      groups.set(key, group);
    }
    const summaries = [...groups.values()].sort((a, b) => b.items.length - a.items.length).map((group) => ({
      ratingKey: group.ratingKey, title: group.title, type: group.type, futureLeafCount: group.items.length,
      earliestAddedAt: iso(Math.min(...group.items.map((item) => item.addedAt))),
      latestAddedAt: iso(Math.max(...group.items.map((item) => item.addedAt))),
      examples: group.items.slice(0, 3).map(compact),
    }));
    return {
      sectionId: query.sectionId, sectionType, now: iso(this.now() / 1000), futureThreshold: iso(threshold),
      complete, scanned, futureLeafCount: future.length, totalGroups: summaries.length,
      groups: summaries.slice(0, MAX_GROUPS), groupsTruncated: summaries.length > MAX_GROUPS,
      note: "Pass a group's ratingKey to fix_plex_future_added_dates. Its expectedFutureCount must come from inspect, because the fix also counts future-dated seasons and the show itself.",
    };
  }

  async inspectFutureAdded(ratingKey: string) {
    const snapshot = await this.collect(ratingKey);
    const future = snapshot.items.filter((item) => item.addedAt > this.threshold());
    return {
      ratingKey, title: snapshot.root.title, type: snapshot.root.type, sectionId: snapshot.sectionId,
      itemCount: snapshot.items.length, futureCount: future.length,
      missingAirDates: future.filter((item) => airDate(item.originallyAvailableAt, this.now()) === undefined).length,
      examples: future.slice(0, 8).map(compact),
    };
  }

  async fixFutureAdded(query: PlexAddedDateFix) {
    if (!Number.isInteger(query.expectedFutureCount) || query.expectedFutureCount < 1) throw new Error("expectedFutureCount must be a positive integer from a fresh inspection");
    const explicit = query.addedAt === undefined ? undefined : explicitTimestamp(query.addedAt, this.now());
    const before = await this.collect(query.ratingKey);
    const threshold = this.threshold();
    const future = before.items.filter((item) => item.addedAt > threshold);
    if (future.length !== query.expectedFutureCount) throw new Error(`Plex reports ${future.length} future-dated items, not ${query.expectedFutureCount}; inspect again before changing dates`);
    if (future.length > MAX_FIX_ITEMS) throw new Error(`Too many future-dated items (${future.length}); fix a season at a time`);
    const targets = new Map<string, number>();
    for (const item of future) {
      const target = explicit ?? airDate(item.originallyAvailableAt, this.now());
      if (target !== undefined) targets.set(item.ratingKey, target);
    }
    const fallback = targets.size ? Math.max(...targets.values()) : undefined;
    const undated = future.filter((item) => !targets.has(item.ratingKey));
    if (undated.length && fallback === undefined) throw new Error("No past air dates are available; supply an explicit past addedAt timestamp");
    for (const item of undated) targets.set(item.ratingKey, fallback!);

    const failures: Array<{ ratingKey: string; error: string }> = [];
    for (let index = 0; index < future.length; index += WRITE_CONCURRENCY) {
      await Promise.all(future.slice(index, index + WRITE_CONCURRENCY).map(async (item) => {
        try {
          await this.request(buildQueryPath(`/library/sections/${before.sectionId}/all`, {
            type: TYPE_IDS[item.type], id: item.ratingKey, "addedAt.value": targets.get(item.ratingKey), "addedAt.locked": 1,
          }), "PUT");
        } catch (error) {
          failures.push({ ratingKey: item.ratingKey, error: error instanceof Error ? error.message : String(error) });
        }
      }));
    }
    const after = await this.collect(query.ratingKey);
    const remaining = after.items.filter((item) => item.addedAt > this.threshold());
    return {
      ratingKey: query.ratingKey, title: before.root.title, type: before.root.type, sectionId: before.sectionId,
      strategy: explicit !== undefined ? "explicit" : "originallyAvailableAt",
      undatedItemsUsingLatestAirDate: explicit === undefined ? undated.length : 0,
      requested: future.length, failed: failures.length, failures: failures.slice(0, 10),
      remainingFutureCount: remaining.length, remainingExamples: remaining.slice(0, 5).map(compact),
      changes: future.slice(0, 5).map((item) => ({ ...compact(item), newAddedAt: iso(targets.get(item.ratingKey)!) })),
      verified: failures.length === 0 && remaining.length === 0,
      note: "Only added dates changed; no media, files or metadata matches were removed. If verified=false, inspect again before any retry.",
    };
  }

  private threshold(): number {
    return Math.floor(this.now() / 1000) + FUTURE_TOLERANCE_SECONDS;
  }

  private async sectionType(sectionId: number): Promise<string | undefined> {
    const xml = await this.request("/library/sections");
    const section = [...xml.matchAll(/<Directory\b([^>]*)>/g)].map((match) => attributes(match[1]!)).find((value) => Number(value.key) === sectionId);
    if (!section) throw new Error(`Plex library section ${sectionId} was not found`);
    return section.type;
  }

  private async collect(ratingKey: string) {
    positiveId(ratingKey);
    const rootXml = await this.request(`/library/metadata/${ratingKey}`);
    const root = parseItems(rootXml)[0];
    if (!root || root.ratingKey !== ratingKey) throw new Error("Plex did not return the exact requested item");
    if (!(root.type in TYPE_IDS)) throw new Error(`Plex item type ${root.type} is not supported; use a show, season, episode or movie`);
    const sectionId = root.sectionId ?? number(container(rootXml).librarySectionID);
    if (!sectionId) throw new Error("Plex did not report the library section for this item");
    const items = new Map([[root.ratingKey, root]]);
    if (root.type === "show" || root.type === "season") {
      for (const path of [`/library/metadata/${ratingKey}/children`, `/library/metadata/${ratingKey}/allLeaves`]) {
        for (const item of parseItems(await this.request(path))) {
          if (item.type in TYPE_IDS) items.set(item.ratingKey, item);
        }
      }
    }
    return { root, sectionId, items: [...items.values()] };
  }
}

function parseItems(xml: string): DatedItem[] {
  return [...xml.matchAll(/<(?:Video|Directory)\b([^>]*)>/g)].map((match) => attributes(match[1]!))
    .filter((value) => value.ratingKey && value.type && value.addedAt !== undefined)
    .map((value) => ({
      ratingKey: value.ratingKey!, type: value.type!, title: value.title ?? "", addedAt: Number(value.addedAt),
      ...(value.originallyAvailableAt ? { originallyAvailableAt: value.originallyAvailableAt } : {}),
      ...(number(value.librarySectionID) !== undefined ? { sectionId: number(value.librarySectionID) } : {}),
      ...(value.type === "episode" && value.grandparentRatingKey ? { showRatingKey: value.grandparentRatingKey, showTitle: value.grandparentTitle ?? "" } : {}),
      ...(value.type === "season" && value.parentRatingKey ? { showRatingKey: value.parentRatingKey, showTitle: value.parentTitle ?? "" } : {}),
      ...(number(value.parentIndex) !== undefined && value.type === "episode" ? { seasonNumber: number(value.parentIndex) } : {}),
      ...(number(value.index) !== undefined && value.type === "episode" ? { episodeNumber: number(value.index) } : {}),
    }))
    .filter((item) => Number.isFinite(item.addedAt));
}

function compact(item: DatedItem) {
  return {
    ratingKey: item.ratingKey, type: item.type, title: item.title, addedAt: iso(item.addedAt),
    ...(item.seasonNumber !== undefined ? { seasonNumber: item.seasonNumber } : {}),
    ...(item.episodeNumber !== undefined ? { episodeNumber: item.episodeNumber } : {}),
    ...(item.originallyAvailableAt ? { originallyAvailableAt: item.originallyAvailableAt } : {}),
  };
}

function airDate(value: string | undefined, now: number): number | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const seconds = Date.parse(`${value}T00:00:00Z`) / 1000;
  return Number.isFinite(seconds) && seconds > 0 && seconds * 1000 <= now ? seconds : undefined;
}

function explicitTimestamp(value: string, now: number): number {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) throw new Error("addedAt must be an ISO 8601 date or timestamp with a timezone");
  const milliseconds = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > now) throw new Error("addedAt must be a valid past timestamp");
  return Math.floor(milliseconds / 1000);
}

function container(xml: string): Record<string, string> {
  return attributes(/<MediaContainer\b([^>]*)>/.exec(xml)?.[1] ?? "");
}

function positiveId(value: string): void {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("A single positive numeric Plex ID is required");
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function number(value: string | undefined): number | undefined {
  return value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined;
}

function attributes(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/([\w:.-]+)="([^"]*)"/g)].map((match) => [match[1]!, decode(match[2]!)]));
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

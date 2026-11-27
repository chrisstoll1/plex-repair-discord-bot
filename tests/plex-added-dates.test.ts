import assert from "node:assert/strict";
import test from "node:test";
import { PlexAddedDateClient } from "../src/services/plex-added-dates.js";

const NOW = Date.parse("2026-11-27T12:00:00Z");
const FUTURE = Date.parse("2098-03-01T00:00:00Z") / 1000;
const PAST = Date.parse("2024-01-01T00:00:00Z") / 1000;
const sections = '<MediaContainer><Directory key="2" type="show" title="TV Shows" /><Directory key="1" type="movie" title="Movies" /></MediaContainer>';

function episode(key: string, addedAt: number, show = "Cheers", showKey = "500", aired = "1985-02-07") {
  return `<Video ratingKey="${key}" type="episode" title="Episode ${key}" grandparentRatingKey="${showKey}" grandparentTitle="${show}" parentIndex="3" index="${key}" addedAt="${addedAt}" originallyAvailableAt="${aired}" librarySectionID="2"><Media><Part file="/tv/${key}.mkv" /></Media></Video>`;
}

function showLibrary(addedAt: Record<string, number>) {
  const writes: URLSearchParams[] = [];
  const request = async (path: string, method?: string) => {
    const url = new URL(path, "http://plex");
    if (method === "PUT") {
      writes.push(url.searchParams);
      addedAt[url.searchParams.get("id")!] = Number(url.searchParams.get("addedAt.value"));
      return "";
    }
    if (url.pathname === "/library/sections") return sections;
    if (url.pathname === "/library/metadata/500") return `<MediaContainer librarySectionID="2"><Directory ratingKey="500" type="show" title="Cheers" addedAt="${addedAt["500"]}" originallyAvailableAt="1982-09-30" /></MediaContainer>`;
    if (url.pathname === "/library/metadata/500/children") return `<MediaContainer><Directory key="/library/metadata/500/allLeaves" title="All episodes" /><Directory ratingKey="501" type="season" title="Season 3" parentRatingKey="500" parentTitle="Cheers" addedAt="${addedAt["501"]}" /></MediaContainer>`;
    if (url.pathname === "/library/metadata/500/allLeaves") return `<MediaContainer>${episode("1", addedAt["1"]!)}${episode("2", addedAt["2"]!, "Cheers", "500", "1985-02-14")}${episode("3", addedAt["3"]!)}</MediaContainer>`;
    throw new Error(`unexpected ${path}`);
  };
  return { client: new PlexAddedDateClient(request, () => NOW), writes };
}

test("finds future-dated leaves sorted by addedAt and groups them by show", async () => {
  const requests: URLSearchParams[] = [];
  const client = new PlexAddedDateClient(async (path) => {
    const url = new URL(path, "http://plex");
    if (url.pathname === "/library/sections") return sections;
    requests.push(url.searchParams);
    return `<MediaContainer offset="0">${episode("1", FUTURE + 10)}${episode("2", FUTURE)}${episode("9", FUTURE - 5, "The Boys", "700")}${episode("4", PAST)}</MediaContainer>`;
  }, () => NOW);
  const result = await client.findFutureAdded({ sectionId: 2 });
  assert.equal(requests[0]?.get("type"), "4");
  assert.equal(requests[0]?.get("sort"), "addedAt:desc");
  assert.equal(result.complete, true);
  assert.equal(result.futureLeafCount, 3);
  assert.deepEqual(result.groups.map((group) => [group.ratingKey, group.title, group.futureLeafCount]), [["500", "Cheers", 2], ["700", "The Boys", 1]]);
  assert.equal((await client.findFutureAdded({ sectionId: 2, title: "boys" })).groups.length, 1);
});

test("refuses unsorted results and unsupported libraries", async () => {
  const unsorted = new PlexAddedDateClient(async (path) => path === "/library/sections" ? sections
    : `<MediaContainer offset="0">${episode("1", FUTURE)}${episode("2", FUTURE + 10)}</MediaContainer>`, () => NOW);
  await assert.rejects(unsorted.findFutureAdded({ sectionId: 2 }), /sorting/);
  const music = new PlexAddedDateClient(async () => '<MediaContainer><Directory key="3" type="artist" /></MediaContainer>', () => NOW);
  await assert.rejects(music.findFutureAdded({ sectionId: 3 }), /only TV and movie/);
});

test("resets only future-dated items under a show to their air dates and verifies", async () => {
  const dates: Record<string, number> = { "500": FUTURE, "501": FUTURE, "1": FUTURE, "2": FUTURE, "3": PAST };
  const { client, writes } = showLibrary(dates);
  const inspection = await client.inspectFutureAdded("500");
  assert.equal(inspection.futureCount, 4);
  await assert.rejects(client.fixFutureAdded({ ratingKey: "500", expectedFutureCount: 3 }), /inspect again/);
  assert.equal(writes.length, 0);
  const result = await client.fixFutureAdded({ ratingKey: "500", expectedFutureCount: 4 });
  assert.equal(result.verified, true);
  assert.equal(result.remainingFutureCount, 0);
  assert.equal(writes.length, 4);
  assert.ok(writes.every((params) => params.get("addedAt.locked") === "1"));
  assert.deepEqual(Object.fromEntries(writes.map((params) => [params.get("id"), params.get("type")])), { "500": "2", "501": "3", "1": "4", "2": "4" });
  assert.equal(dates["500"], Date.parse("1982-09-30T00:00:00Z") / 1000);
  assert.equal(dates["501"], Date.parse("1985-02-14T00:00:00Z") / 1000);
  assert.equal(dates["2"], Date.parse("1985-02-14T00:00:00Z") / 1000);
  assert.equal(dates["3"], PAST);
});

test("explicit dates must be in the past and apply to every future-dated item", async () => {
  const dates: Record<string, number> = { "500": PAST, "501": PAST, "1": FUTURE, "2": PAST, "3": PAST };
  const { client, writes } = showLibrary(dates);
  await assert.rejects(client.fixFutureAdded({ ratingKey: "500", expectedFutureCount: 1, addedAt: "2099-01-01" }), /past/);
  await assert.rejects(client.fixFutureAdded({ ratingKey: "500", expectedFutureCount: 1, addedAt: "yesterday" }), /ISO 8601/);
  const result = await client.fixFutureAdded({ ratingKey: "500", expectedFutureCount: 1, addedAt: "2025-06-01T00:00:00Z" });
  assert.equal(result.verified, true);
  assert.equal(writes.length, 1);
  assert.equal(dates["1"], Date.parse("2025-06-01T00:00:00Z") / 1000);
});

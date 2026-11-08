import assert from "node:assert/strict";
import test from "node:test";
import { ArrAddClient } from "../src/services/arr-add.js";
import { ArrClient } from "../src/services/arr-client.js";
import { PiAgentService, contentRequestRouting } from "../src/agent/pi-agent.js";

const movie = { tmdbId: 699102, title: "A Week Away", year: 2021, titleSlug: "a-week-away-699102", images: [], id: 0, path: "/untrusted/lookup/path" };
const series = { tvdbId: 123, title: "Example Show", year: 2020, titleSlug: "example-show", seasons: [0, 1, 2, 3].map((seasonNumber) => ({ seasonNumber, monitored: true, statistics: { ignored: true } })) };
const params = { tmdbId: 699102, title: "A Week Away", year: 2021, rootFolderPath: "/movies", qualityProfileId: 2 };
const seriesParams = { tvdbId: 123, title: "Example Show", year: 2020, rootFolderPath: "/tv", qualityProfileId: 2, seriesType: "standard" as const, seasonFolder: true };

function fixture(service: "radarr" | "sonarr" = "radarr") {
  const base = service === "radarr" ? "/api/v3/movie" : "/api/v3/series";
  const state = { roots: [{ id: 1, path: service === "radarr" ? "/movies" : "/tv", accessible: true }], profiles: [{ id: 2, name: "HD", items: [{ quality: { name: "HDTV" } }] }], library: [] as Record<string, unknown>[], lookup: [{ ...(service === "radarr" ? movie : series) }], writes: [] as Record<string, unknown>[], libraryReads: 0 };
  const client = new ArrAddClient(service, async (path, options) => {
    if (path === "/api/v3/rootfolder") return state.roots;
    if (path === "/api/v3/qualityprofile") return state.profiles;
    if (path.startsWith(base + "/lookup?")) {
      assert.equal(new URL(path, "http://arr").searchParams.get("term"), service === "radarr" ? "tmdb:699102" : "tvdb:123");
      return state.lookup;
    }
    assert.equal(path, base);
    if (!options?.method) { state.libraryReads++; return state.library; }
    assert.equal(options.method, "POST");
    const body = options.body as Record<string, unknown>;
    state.writes.push(body);
    const added = { ...body, id: 42, path: (service === "radarr" ? "/movies" : "/tv") + "/new item" };
    state.library.push(added);
    return added;
  });
  return { state, client };
}

test("addition discovery returns compact existing roots/profiles and relevant library conventions", async () => {
  const { client, state } = fixture("sonarr");
  state.library = [
    { path: "/tv/One", qualityProfileId: 2, seriesType: "standard", seasonFolder: true },
    { path: "/tv/Two", qualityProfileId: 2, seriesType: "standard", seasonFolder: true },
    { path: "/tv/Anime", qualityProfileId: 2, seriesType: "anime", seasonFolder: false },
  ];
  const options = await client.getOptions("standard");
  assert.equal(options.existingItemCount, 3);
  assert.equal(options.recommended?.count, 2);
  assert.equal(options.recommended?.seriesType, "standard");
  assert.equal(options.recommended?.rootFolderPath, "/tv");
  assert.equal(JSON.stringify(options).includes("items"), false);
});

test("movie addition binds fresh TMDB identity, existing root/profile and movie-only search", async () => {
  const { client, state } = fixture();
  const result = await client.addMovie(params);
  assert.equal(result.added, true);
  assert.equal(result.searchRequested, true);
  assert.equal(result.media.id, 42);
  const body = state.writes[0]!;
  assert.equal(body.id, undefined);
  assert.equal(body.path, undefined);
  assert.equal(body.monitored, true);
  assert.equal(body.minimumAvailability, "released");
  assert.deepEqual(body.addOptions, { monitor: "movieOnly", searchForMovie: true });
  assert.match(result.note ?? "", /does not prove/);
  const duplicate = await client.addMovie(params);
  assert.equal(duplicate.alreadyExists, true);
  assert.equal(duplicate.searchRequested, false);
  assert.equal(state.writes.length, 1);
});

test("movie additions reject mismatched identities, inaccessible roots and missing profiles", async () => {
  for (const mode of ["wrongTitle", "wrongYear", "wrongId", "badRoot", "badProfile"] as const) {
    const { client, state } = fixture();
    if (mode === "wrongTitle") state.lookup[0]!.title = "Other Movie";
    if (mode === "wrongYear") state.lookup[0]!.year = 1990;
    if (mode === "wrongId") state.lookup[0]!.tmdbId = 1;
    if (mode === "badRoot") state.roots[0]!.accessible = false;
    if (mode === "badProfile") state.profiles[0]!.id = 3;
    await assert.rejects(client.addMovie(params));
    assert.equal(state.writes.length, 0);
  }
});

test("explicit TV season requests monitor/search only that scope and disable new-season monitoring", async () => {
  const { client, state } = fixture("sonarr");
  const added = await client.addSeries({ ...seriesParams, seasonNumbers: [2] });
  assert.equal(added.added, true);
  assert.deepEqual(added.selectedSeasons, [2]);
  const body = state.writes[0]!;
  assert.deepEqual(body.seasons, [0, 1, 2, 3].map((seasonNumber) => ({ seasonNumber, monitored: seasonNumber === 2 })));
  assert.equal(body.monitorNewItems, "none");
  assert.deepEqual(body.addOptions, { monitor: "skip", searchForMissingEpisodes: true, searchForCutoffUnmetEpisodes: false });
});

test("whole-show requests exclude specials by default and support explicit specials with no search", async () => {
  const all = fixture("sonarr");
  await all.client.addSeries(seriesParams);
  assert.equal(all.state.writes[0]!.monitorNewItems, "all");
  assert.deepEqual(all.state.writes[0]!.seasons, [0, 1, 2, 3].map((seasonNumber) => ({ seasonNumber, monitored: seasonNumber > 0 })));
  const specials = fixture("sonarr");
  await specials.client.addSeries({ ...seriesParams, seasonNumbers: [0], search: false });
  assert.deepEqual(specials.state.writes[0]!.addOptions, { monitor: "skip", searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false });
  assert.deepEqual((specials.state.writes[0]!.seasons as { seasonNumber: number; monitored: boolean }[]).filter((season) => season.monitored).map((season) => season.seasonNumber), [0]);
  for (const seasonNumbers of [[], [99], [-1]]) {
    const value = fixture("sonarr");
    await assert.rejects(value.client.addSeries({ ...seriesParams, seasonNumbers }));
    assert.equal(value.state.writes.length, 0);
  }
});

test("an item appearing during exact lookup is reused without another POST", async () => {
  let reads = 0;
  let writes = 0;
  const existing = { ...movie, id: 77 };
  const client = new ArrAddClient("radarr", async (path, options) => {
    if (options?.method) { writes++; return existing; }
    if (path.endsWith("rootfolder")) return [{ path: "/movies", accessible: true }];
    if (path.endsWith("qualityprofile")) return [{ id: 2 }];
    if (path.includes("lookup?")) return [movie];
    return ++reads > 1 ? [existing] : [];
  });
  assert.equal((await client.addMovie(params)).alreadyExists, true);
  assert.equal(writes, 0);
});

test("direct add tools honor default-off toggle, preferred Seerr, roles and confirmation before any HTTP", async () => {
  const values = new Map<string, string>();
  const repair = { requireConfirmation: false, allowDestructive: false, allowDirectAdd: false };
  const store = { getString: (key: string) => values.get(key), getJson: (key: string, fallback: unknown) => key === "repair" ? repair : fallback };
  const service = new PiAgentService({} as never, store as never) as any;
  const tools = service.createTools({ roles: [], userId: "107286271453356032", channelId: "channel" });
  const add = tools.find((tool: { name: string }) => tool.name === "add_radarr_movie");
  assert.match((await add.execute("id", params)).details.reason, /disabled/);
  repair.allowDirectAdd = true;
  values.set("seerr.url", "http://seerr"); values.set("seerr.apiKey", "secret");
  assert.match((await add.execute("id", params)).details.reason, /routed through Seerr/);
  values.set("seerr.preferForRequests", "false");
  repair.requireConfirmation = true;
  assert.equal((await add.execute("id", params)).details.confirmationRequired, true);
  values.set("discord.repairRoleIds", "allowed");
  assert.match((await add.execute("id", params)).details.reason, /role/);
  const routing = contentRequestRouting({ repair, seerr: { url: "http://seerr", apiKey: "secret", preferForRequests: true } } as never);
  assert.equal(routing.defaultProvider, "seerr");
});

test("Arr HTTP adapter sends only exact creation payload and existing API-key header", async (t) => {
  const requests: Array<{ url: URL; method?: string; body?: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (input: URL, options: RequestInit) => {
    const url = new URL(String(input));
    assert.equal((options.headers as Record<string, string>)["X-Api-Key"], "test");
    const body = options.body ? JSON.parse(String(options.body)) : undefined;
    requests.push({ url, method: options.method, body });
    let value: unknown = [];
    if (url.pathname.endsWith("rootfolder")) value = [{ path: "/movies", accessible: true }];
    else if (url.pathname.endsWith("qualityprofile")) value = [{ id: 2 }];
    else if (url.pathname.endsWith("lookup")) value = [movie];
    else if (options.method === "POST") value = { ...body, id: 42 };
    return Response.json(value);
  });
  const client = new ArrClient("radarr", { url: "http://radarr:7878", apiKey: "test" });
  assert.equal((await client.additions.addMovie({ ...params, search: false })).added, true);
  const writes = requests.filter((item) => item.method === "POST");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.url.pathname, "/api/v3/movie");
  assert.deepEqual(writes[0]!.body!.addOptions, { monitor: "movieOnly", searchForMovie: false });
});

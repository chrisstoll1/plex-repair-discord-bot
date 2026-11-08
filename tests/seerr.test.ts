import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { SeerrClient, type SeerrRequestParams } from "../src/services/seerr-client.js";
import { parseSeerrUserMappings } from "../src/domain/settings.js";
import { PiAgentService } from "../src/agent/pi-agent.js";

const discordId = "107286271453356032";
const settings = { url: "http://seerr:5055", apiKey: "secret-api-key", preferForRequests: true, userMappings: `${discordId}:7`, defaultUserId: 0 };
const movieParams: SeerrRequestParams = { mediaType: "movie", tmdbId: 699102, title: "A Week Away", year: 2021 };
const tvParams: SeerrRequestParams = { mediaType: "tv", tmdbId: 100, title: "Example Show", year: 2020, seasons: [2] };
function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const state = {
    media: { id: 699102, title: "A Week Away", releaseDate: "2021-03-26", mediaInfo: null as any } as any,
    requests: [] as { path: string; method: string; user?: string; body?: any }[],
    users: [{ id: 7 }], links: new Map<number, string[]>(), failure: 0,
    responseStatus: 1,
  };
  t.mock.method(globalThis, "fetch", async (input: string, options: RequestInit) => {
    const url = new URL(String(input));
    const headers = options.headers as Record<string, string>;
    assert.equal(headers["X-Api-Key"], "secret-api-key");
    assert.equal(url.toString().includes("secret-api-key"), false);
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(String(options.body)) : undefined;
    state.requests.push({ path: url.pathname, method, user: headers["X-Api-User"], body });
    if (url.pathname.endsWith("/auth/me")) return Response.json({ id: Number(headers["X-Api-User"] ?? 1), plexToken: "private-plex-token" });
    if (url.pathname.endsWith("/status")) return Response.json({ version: "3.5.0" });
    if (url.pathname.endsWith("/user")) return Response.json({ pageInfo: { results: state.users.length }, results: state.users });
    const userId = /\/user\/(\d+)\/settings\/notifications/.exec(url.pathname)?.[1];
    if (userId) return Response.json({ discordIds: state.links.get(Number(userId)) ?? [], pushoverApplicationToken: "private-notification-token" });
    if (url.pathname.endsWith("/request") && method === "POST") {
      if (state.failure) return new Response("private-error-secret", { status: state.failure });
      return Response.json({ id: 42, type: body.mediaType, status: state.responseStatus, is4k: body.is4k, media: { tmdbId: body.mediaId, status: 2 }, requestedBy: { id: Number(headers["X-Api-User"]), email: "private-email", plexToken: "private-plex-token" }, seasons: (body.seasons ?? []).map((seasonNumber: number) => ({ seasonNumber, status: state.responseStatus })) }, { status: 201 });
    }
    if (url.pathname.endsWith("/request/42")) return Response.json({ id: 42, type: "movie", status: 2, media: { tmdbId: 699102, status: 3, externalServiceId: 2731 }, requestedBy: { id: 7, jellyfinAuthToken: "private-jellyfin-token" } });
    if (url.pathname.endsWith("/search")) return Response.json({ page: 1, totalPages: 1, totalResults: 1, results: [{ ...state.media, mediaType: state.media.name ? "tv" : "movie", overview: "Movie description" }] });
    return Response.json(state.media);
  });
  return { state, client: new SeerrClient(settings, 1, discordId) };
}

test("Seerr submits exact tracked movie as trusted Discord-mapped user without override fields", async (t) => {
  const { client, state } = fixture(t);
  const result = await client.requestMedia({ ...movieParams, userId: 1, ignoreQuota: true, serverId: 99 } as any);
  assert.equal(result.created, true);
  assert.equal("request" in result && result.request.status, "pending_approval");
  assert.equal("request" in result && result.request.id, 42);
  assert.equal("request" in result && result.request.mediaUrl, "http://seerr:5055/movie/699102");
  const writes = state.requests.filter((request) => request.method !== "GET");
  assert.deepEqual(writes, [{ path: "/api/v1/request", method: "POST", user: "7", body: { mediaType: "movie", mediaId: 699102, is4k: false } }]);
  assert.doesNotMatch(JSON.stringify(result), /private-|secret-api-key/);
});

test("Seerr TV request scope excludes already requested/available seasons without adding extras", async (t) => {
  const { client, state } = fixture(t);
  state.media = { id: 100, name: "Example Show", firstAirDate: "2020-01-01", externalIds: { tvdbId: 123 }, seasons: [0, 1, 2, 3].map((seasonNumber) => ({ seasonNumber, episodeCount: 10 })),
    mediaInfo: { status: 4, seasons: [{ seasonNumber: 3, status: 5 }], requests: [{ id: 11, type: "tv", status: 1, is4k: false, seasons: [{ seasonNumber: 1, status: 1 }] }] } };
  await client.requestMedia({ ...tvParams, seasons: [1, 2, 3] });
  assert.deepEqual(state.requests.find((item) => item.method === "POST")!.body.seasons, [2]);
  const repeated = await client.requestMedia({ ...tvParams, seasons: [1, 3] });
  assert.equal(repeated.created, false);
  assert.equal(state.requests.filter((item) => item.method === "POST").length, 1);
});

test("whole-show scope excludes specials and invalid or ambiguous scopes do not POST", async (t) => {
  const { client, state } = fixture(t);
  state.media = { id: 100, name: "Example Show", firstAirDate: "2020-01-01", seasons: [0, 1, 2].map((seasonNumber) => ({ seasonNumber })) };
  await client.requestMedia({ ...tvParams, seasons: undefined, allSeasons: true });
  assert.deepEqual(state.requests.find((item) => item.method === "POST")!.body.seasons, [1, 2]);
  for (const input of [{ ...tvParams, seasons: undefined }, { ...tvParams, seasons: [99] }, { ...tvParams, allSeasons: true }, { ...movieParams, seasons: [1] }]) await assert.rejects(client.requestMedia(input));
  assert.equal(state.requests.filter((item) => item.method === "POST").length, 1);
});

test("available and active movies are reused without duplicate submissions", async (t) => {
  const { client, state } = fixture(t);
  state.media.mediaInfo = { status: 5, requests: [] };
  assert.equal((await client.requestMedia(movieParams)).created, false);
  state.media.mediaInfo = { status: 2, requests: [{ id: 40, type: "movie", status: 1, is4k: false }] };
  assert.equal((await client.requestMedia(movieParams)).created, false);
  assert.equal(state.requests.some((request) => request.method === "POST"), false);
});

test("4K is a distinct request scope and defaults remain with Seerr", async (t) => {
  const { client, state } = fixture(t);
  state.media.mediaInfo = { status: 5, status4k: 1, requests: [{ id: 40, type: "movie", status: 2, is4k: false }] };
  await client.requestMedia({ ...movieParams, is4k: true });
  assert.deepEqual(state.requests.find((item) => item.method === "POST")!.body, { mediaType: "movie", mediaId: 699102, is4k: true });
});

test("Seerr denials do not expose error bodies or fall back to other services", async (t) => {
  const { client, state } = fixture(t);
  state.failure = 403;
  await assert.rejects(client.requestMedia(movieParams), (error: Error) => /HTTP 403/.test(error.message) && !error.message.includes("private-error-secret"));
  assert.equal(state.requests.filter((item) => item.method === "POST").length, 1);
  assert.ok(state.requests.every((request) => request.path.startsWith("/api/v1/")));
  state.failure = 409;
  const duplicate = await client.requestMedia(movieParams);
  assert.equal(duplicate.created, false);
  assert.equal("duplicate" in duplicate && duplicate.duplicate, true);
});

test("identity mismatch does not create a request, and request status is distinct from availability", async (t) => {
  const { client, state } = fixture(t);
  await assert.rejects(client.requestMedia({ ...movieParams, year: 1999 }), /do not match/);
  assert.equal(state.requests.some((item) => item.method === "POST"), false);
  const status = await client.getRequest(42);
  assert.equal(status.status, "approved");
  assert.equal(status.availability, "processing");
  assert.equal(status.arrId, 2731);
  assert.doesNotMatch(JSON.stringify(status), /private-|Token/);
});

test("automatic Discord linking overrides shared account and unlinked users fail closed by default", async (t) => {
  const { state } = fixture(t);
  state.links.set(7, [discordId]);
  const linked = new SeerrClient({ ...settings, userMappings: "", defaultUserId: 1 }, 1, discordId);
  await linked.getMedia("movie", 699102);
  assert.equal(state.requests.find((request) => request.path === "/api/v1/movie/699102")!.user, "7");
  state.links.clear();
  await assert.rejects(new SeerrClient({ ...settings, userMappings: "" }, 1, discordId).requestMedia(movieParams), /not linked/);
  const shared = new SeerrClient({ ...settings, userMappings: "", defaultUserId: 1 }, 1, discordId);
  const result = await shared.requestMedia(movieParams);
  assert.equal(result.created, true);
  assert.equal(state.requests.filter((request) => request.method === "POST").at(-1)!.user, "1");
});

test("ambiguous Discord links fail closed even when a shared account is configured", async (t) => {
  const { state } = fixture(t);
  state.users = [{ id: 7 }, { id: 8 }];
  state.links.set(7, [discordId]); state.links.set(8, [discordId]);
  await assert.rejects(new SeerrClient({ ...settings, userMappings: "", defaultUserId: 1 }, 1, discordId).requestMedia(movieParams), /multiple Seerr/);
  assert.equal(state.requests.some((item) => item.method === "POST"), false);
});

test("compact lookup/search/status never return user credentials or notification secrets", async (t) => {
  const { state } = fixture(t);
  state.links.set(7, [discordId]);
  state.media.mediaInfo = { status: 2, requests: [{ id: 42, type: "movie", status: 1, requestedBy: { id: 7, email: "private-email", plexToken: "private-plex-token", settings: { apiKey: "secret-api-key" } } }] };
  const client = new SeerrClient({ ...settings, userMappings: "" }, 1, discordId);
  const result = [await client.search("A Week Away"), await client.getMedia("movie", 699102), await client.getStatus()];
  assert.doesNotMatch(JSON.stringify(result), /private-|secret-api-key|plexToken|settings/);
});

test("mapping parsing rejects duplicate, malformed, and imprecise numeric IDs", () => {
  assert.equal(parseSeerrUserMappings(`${discordId}:7`).get(discordId), 7);
  for (const value of [`${discordId}:7,${discordId}:8`, "someone:1", `${discordId}:9007199254740993`]) assert.throws(() => parseSeerrUserMappings(value));
});

test("request tool requires bot roles/confirmation and binds the server user rather than model overrides", async (t) => {
  const { state } = fixture(t);
  const values = new Map(Object.entries({ "seerr.url": settings.url, "seerr.apiKey": settings.apiKey, "seerr.userMappings": settings.userMappings }));
  const repair = { requireConfirmation: true, allowDestructive: false, allowDirectAdd: false };
  const store = { getString: (key: string) => values.get(key), getJson: (key: string, fallback: unknown) => key === "repair" ? repair : fallback };
  const service = new PiAgentService({} as never, store as never) as any;
  const tools = service.createTools({ roles: [], userId: discordId, channelId: "channel" });
  const tool = tools.find((item: { name: string }) => item.name === "request_seerr_media");
  assert.equal((await tool.execute("id", movieParams)).details.confirmationRequired, true);
  assert.equal(state.requests.length, 0);
  values.set("discord.repairRoleIds", "allowed");
  assert.equal((await tool.execute("id", movieParams)).details.blocked, true);
  assert.equal(state.requests.length, 0);
  values.delete("discord.repairRoleIds"); repair.requireConfirmation = false;
  assert.equal((await tool.execute("id", { ...movieParams, userId: "evil" })).details.created, true);
  assert.equal(state.requests.find((request) => request.method === "POST")!.user, "7");
});

test("Seerr download timeout also covers a stalled response body", async (t) => {
  const server = http.createServer((_request, response) => { response.writeHead(200); response.write('{"id":'); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const client = new SeerrClient({ ...settings, url: `http://127.0.0.1:${address.port}` }, 0.05, discordId);
  await assert.rejects(client.getMedia("movie", 699102), /timed out/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { SeerrClient, type SeerrRequestTarget } from "../src/services/seerr-client.js";
import { PiAgentService } from "../src/agent/pi-agent.js";

const discordId = "107286271453356032";
const settings = { url: "http://seerr:5055", apiKey: "secret-api-key", preferForRequests: true, userMappings: `${discordId}:7`, defaultUserId: 0 };
const target: SeerrRequestTarget = { requestId: 242, mediaType: "movie", tmdbId: 4614, expectedIs4k: true };
const destination = { serverId: 0, profileId: 3, rootFolder: "/movies" };
const replacement = { ...target, title: "The Sum of All Fears", year: 2002, is4k: false, destination };

function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const state = {
    records: new Map<number, any>([[242, { id: 242, type: "movie", status: 2, is4k: true,
      serverId: 1, profileId: 8, rootFolder: "/4k", tags: [5], createdAt: "2026-11-16T21:00:00Z", updatedAt: "2026-11-16T21:00:00Z",
      media: { tmdbId: 4614, status: 1, status4k: 3, serviceId4k: 1, externalServiceId4k: 99, serviceUrl4k: "http://radarr:7878/movie/sum-of-all-fears" },
      requestedBy: { id: 7, email: "private-email", apiKey: "secret-api-key" } }]]),
    requests: [] as { path: string; method: string; user?: string; body?: any }[],
    servers: [{ id: 0, name: "Movies", is4k: false, isDefault: true, activeProfileId: 3, activeDirectory: "/movies", apiKey: "secret-api-key" },
      { id: 1, name: "4K", is4k: true, isDefault: true, activeProfileId: 8, activeDirectory: "/4k", apiKey: "secret-api-key" }],
    newStatus: 2, failure: 0, deleteFailure: 0, ignoreDestination: false, retainDeleted: false, changeSource: false, failReplacementRead: false,
  };
  t.mock.method(globalThis, "fetch", async (input: string, options: RequestInit) => {
    const url = new URL(String(input));
    const headers = options.headers as Record<string, string>;
    assert.equal(headers["X-Api-Key"], settings.apiKey);
    assert.equal(headers["X-Api-User"], "7");
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(String(options.body)) : undefined;
    state.requests.push({ path: url.pathname, method, user: headers["X-Api-User"], body });
    if (url.pathname === "/api/v1/auth/me") return Response.json({ id: 7 });
    if (/^\/api\/v1\/service\/(radarr|sonarr)$/.test(url.pathname)) return Response.json(state.servers);
    const serverMatch = /^\/api\/v1\/service\/(radarr|sonarr)\/(\d+)$/.exec(url.pathname);
    if (serverMatch) {
      const server = state.servers.find((item) => item.id === Number(serverMatch[2]));
      if (!server) return new Response("private-error", { status: 404 });
      return Response.json({ server, profiles: [{ id: server.activeProfileId, name: server.is4k ? "4K" : "1080p", apiKey: "secret-api-key" }],
        rootFolders: [{ id: 2, path: server.activeDirectory, freeSpace: 1000, privateToken: "private-token" }] });
    }
    if (url.pathname === "/api/v1/request" && method === "POST") {
      if (state.failure) return new Response("private-error", { status: state.failure });
      assert.equal(body.userId, undefined);
      assert.equal(body.ignoreQuota, undefined);
      const record = { id: 300, type: body.mediaType, status: state.newStatus, is4k: body.is4k,
        ...(state.ignoreDestination ? { serverId: 4, profileId: 9, rootFolder: "/different" } : { serverId: body.serverId, profileId: body.profileId, rootFolder: body.rootFolder }),
        media: { tmdbId: body.mediaId, status: 3, status4k: 3 }, requestedBy: { id: 7, email: "private-email" },
        seasons: (body.seasons ?? []).map((seasonNumber: number) => ({ seasonNumber, status: state.newStatus })) };
      state.records.set(300, record);
      if (state.changeSource) state.records.get(242).updatedAt = "2026-11-16T22:00:00Z";
      return Response.json(record, { status: 201 });
    }
    const requestMatch = /^\/api\/v1\/request\/(\d+)(\/retry)?$/.exec(url.pathname);
    if (requestMatch) {
      const id = Number(requestMatch[1]);
      const record = state.records.get(id);
      if (!record) return new Response("private-error", { status: 404 });
      if (method === "DELETE") {
        if (state.deleteFailure) return new Response("private-error", { status: state.deleteFailure });
        if (!state.retainDeleted) state.records.delete(id);
        return new Response(null, { status: 204 });
      }
      if (method === "PUT") {
        if (state.failure) return new Response("private-error", { status: state.failure });
        assert.equal(record.status, 1);
        assert.equal(body.is4k, undefined);
        assert.equal(body.userId, undefined);
        if (!state.ignoreDestination) Object.assign(record, body, { seasons: body.seasons?.map((seasonNumber: number) => ({ seasonNumber, status: 1 })) });
        return Response.json(record);
      }
      if (method === "POST" && requestMatch[2]) {
        if (state.failure) return new Response("private-error", { status: state.failure });
        assert.equal(record.status, 4);
        record.status = 2;
        return Response.json(record);
      }
      assert.equal(method, "GET");
      if (id === 300 && state.failReplacementRead) return new Response("private-error", { status: 503 });
      return Response.json(record);
    }
    if (/^\/api\/v1\/(movie|tv)\/4614$/.test(url.pathname)) return Response.json({ id: 4614, title: "The Sum of All Fears", releaseDate: "2002-05-31",
      name: "The Sum of All Fears", firstAirDate: "2002-05-31", seasons: [0, 1, 2, 3].map((seasonNumber) => ({ seasonNumber })),
      mediaInfo: { ...state.records.get(242)?.media, requests: [...state.records.values()] } });
    assert.fail(`Unexpected Seerr endpoint ${method} ${url.pathname}`);
  });
  return { state, client: new SeerrClient(settings, 1, discordId) };
}

test("Seerr discovery supports server zero and exposes destination details without credentials", async (t) => {
  const { client } = fixture(t);
  const servers = await client.getRequestOptions("movie");
  assert.equal("servers" in servers && servers.servers[0]?.id, 0);
  const options = await client.getRequestOptions("movie", 0);
  assert.equal("profiles" in options && options.profiles[0]?.name, "1080p");
  const request = await client.getRequest(242);
  assert.equal(request.serverId, 1);
  assert.equal(request.profileId, 8);
  assert.equal(request.serviceId, 1);
  assert.equal(request.arrId, 99);
  assert.equal(request.serviceUrl, "http://radarr:7878/movie/sum-of-all-fears");
  assert.doesNotMatch(JSON.stringify([servers, options, request]), /private-|secret-api-key|apiKey|email/);
});

test("Seerr compact media retains standard and 4K links, excluding credential-bearing URLs", async (t) => {
  const { client, state } = fixture(t);
  Object.assign(state.records.get(242).media, { serviceId: 0, externalServiceId: 70, serviceUrl: "http://radarr/movie/standard?token=private-token" });
  const media = await client.getMedia("movie", 4614);
  assert.equal(media.serviceId, 0);
  assert.equal(media.arrId, 70);
  assert.equal(media.serviceUrl, undefined);
  assert.equal(media.serviceUrl4k, "http://radarr:7878/movie/sum-of-all-fears");
  assert.doesNotMatch(JSON.stringify(media), /private-|secret-api-key/);
});

test("explicit request destinations are freshly validated and never accept account or quota overrides", async (t) => {
  const { client, state } = fixture(t);
  const result = await client.requestMedia({ mediaType: "movie", tmdbId: 4614, title: replacement.title, year: 2002,
    destination: { ...destination, userId: 1, ignoreQuota: true } as any, userId: 1, ignoreQuota: true } as any);
  assert.equal("destinationVerified" in result && result.destinationVerified, true);
  assert.deepEqual(state.requests.find((item) => item.method === "POST")?.body, { mediaType: "movie", mediaId: 4614, is4k: false, ...destination });
});

test("missing profiles, roots and mismatched 4K destinations are rejected before any write", async (t) => {
  const { client, state } = fixture(t);
  for (const invalid of [{ ...destination, profileId: 999 }, { ...destination, rootFolder: "/unconfigured" }, { ...destination, serverId: 1 }, { ...destination, serverId: -1 }]) {
    await assert.rejects(client.requestMedia({ mediaType: "movie", tmdbId: 4614, title: replacement.title, year: 2002, destination: invalid }));
  }
  assert.equal(state.requests.some((item) => item.method !== "GET"), false);
});

test("pending TV destination edit preserves requester, seasons, tags, language and approval", async (t) => {
  const { client, state } = fixture(t);
  Object.assign(state.records.get(242), { type: "tv", status: 1, is4k: false, languageProfileId: 6, seasons: [{ seasonNumber: 2, status: 1 }] });
  const result = await client.updateRequest({ ...target, mediaType: "tv", expectedIs4k: false, destination: { ...destination, userId: 1 } as any });
  assert.equal(result.updated, true);
  assert.equal(result.request.status, "pending_approval");
  assert.deepEqual(state.requests.find((item) => item.method === "PUT")?.body, { ...destination, tags: [5], seasons: [2], languageProfileId: 6 });
  assert.equal(state.records.get(242).requestedBy.id, 7);
});

test("approved request edits and invalid TV scope fail without destructive workarounds", async (t) => {
  const { client, state } = fixture(t);
  await assert.rejects(client.updateRequest({ ...target, destination }), /only edits pending/);
  Object.assign(state.records.get(242), { type: "tv", status: 1, is4k: false, seasons: [{}] });
  await assert.rejects(client.updateRequest({ ...target, mediaType: "tv", expectedIs4k: false, destination }), /preserve.*season/);
  assert.equal(state.requests.some((item) => item.method !== "GET"), false);
});

test("Seerr edits and submissions report ignored destination choices instead of claiming success", async (t) => {
  const { client, state } = fixture(t);
  state.ignoreDestination = true;
  Object.assign(state.records.get(242), { status: 1, is4k: false });
  const updated = await client.updateRequest({ ...target, expectedIs4k: false, destination });
  assert.equal(updated.updated, false);
  state.records.get(242).is4k = true;
  const result = await client.requestMedia({ mediaType: "movie", tmdbId: 4614, title: replacement.title, year: 2002, destination });
  assert.equal("destinationVerified" in result && result.destinationVerified, false);
});

test("retry only resends a failed exact request as the mapped account", async (t) => {
  const { client, state } = fixture(t);
  for (const status of [1, 2, 3, 5]) {
    state.records.get(242).status = status;
    await assert.rejects(client.retryRequest(target), /only retries failed/);
  }
  state.records.get(242).status = 4;
  const result = await client.retryRequest(target);
  assert.equal(result.retryTriggered, true);
  assert.equal(result.request.status, "approved");
  assert.deepEqual(state.requests.filter((item) => item.method !== "GET"), [{ path: "/api/v1/request/242/retry", method: "POST", user: "7", body: undefined }]);
});

test("request mutations reject wrong media ID, type or 4K scope before writes", async (t) => {
  const { client, state } = fixture(t);
  for (const wrong of [{ ...target, tmdbId: 100 }, { ...target, mediaType: "tv" as const }, { ...target, expectedIs4k: false }]) {
    await assert.rejects(client.retryRequest(wrong), /does not match/);
    await assert.rejects(client.deleteRequest(wrong), /does not match/);
    await assert.rejects(client.updateRequest({ ...wrong, destination }), /does not match/);
  }
  assert.equal(state.requests.some((item) => item.method !== "GET"), false);
});

test("request-only deletion handles empty 204 and verifies absence", async (t) => {
  const { client, state } = fixture(t);
  assert.equal((await client.deleteRequest(target)).deleted, true);
  assert.equal(state.records.has(242), false);
  assert.deepEqual(state.requests.filter((item) => item.method !== "GET").map((item) => item.path), ["/api/v1/request/242"]);
});

test("a request that remains readable is not reported as deleted", async (t) => {
  const { client, state } = fixture(t);
  state.retainDeleted = true;
  assert.equal((await client.deleteRequest(target)).deleted, false);
});

test("approved 4K replacement verifies 1080p destination before removing only the old request record", async (t) => {
  const { client, state } = fixture(t);
  const result = await client.replaceRequest(replacement);
  assert.equal(result.replaced, true);
  assert.equal("request" in result && result.request.id, 300);
  assert.equal(state.records.has(242), false);
  assert.equal(state.records.get(300).is4k, false);
  assert.deepEqual(state.requests.filter((item) => item.method !== "GET").map((item) => [item.method, item.path]), [["POST", "/api/v1/request"], ["DELETE", "/api/v1/request/242"]]);
  const creationIndex = state.requests.findIndex((item) => item.method === "POST");
  const verificationIndex = state.requests.findIndex((item) => item.path === "/api/v1/request/300");
  const deletionIndex = state.requests.findIndex((item) => item.method === "DELETE");
  assert.ok(creationIndex < verificationIndex && verificationIndex < deletionIndex);
});

test("replacement preserves exact TV seasons when converting quality scope", async (t) => {
  const { client, state } = fixture(t);
  Object.assign(state.records.get(242), { type: "tv", seasons: [{ seasonNumber: 2, status: 2 }] });
  const result = await client.replaceRequest({ ...replacement, mediaType: "tv" });
  assert.equal(result.replaced, true);
  assert.deepEqual(state.requests.find((item) => item.method === "POST")?.body.seasons, [2]);
});

test("pending approval, ignored destination, changed source and failed verification retain the original", async (t) => {
  const { client, state } = fixture(t);
  state.newStatus = 1;
  const pending = await client.replaceRequest(replacement);
  assert.equal(pending.replaced, false);
  assert.equal("originalRetained" in pending && pending.originalRetained, true);
  // Further attempts inspect the existing request instead of creating a duplicate.
  const duplicate = await client.replaceRequest(replacement);
  assert.equal(duplicate.replaced, false);
  assert.equal(state.requests.filter((item) => item.method === "POST").length, 1);
  state.records.delete(300); state.newStatus = 2; state.ignoreDestination = true;
  assert.equal((await client.replaceRequest(replacement)).replaced, false);
  state.records.delete(300); state.ignoreDestination = false; state.changeSource = true;
  assert.equal((await client.replaceRequest(replacement)).replaced, false);
  state.records.delete(300); state.changeSource = false; state.failReplacementRead = true;
  const unverified = await client.replaceRequest(replacement);
  assert.equal("request" in unverified && unverified.request.id, 300);
  assert.equal(state.records.has(242), true);
  assert.equal(state.requests.some((item) => item.method === "DELETE"), false);
});

test("Seerr denial does not remove the original or fall back to an administrator or direct Arr add", async (t) => {
  const { client, state } = fixture(t);
  state.failure = 403;
  await assert.rejects(client.replaceRequest(replacement), (error: Error) => /HTTP 403/.test(error.message) && !error.message.includes("private-error"));
  assert.equal(state.records.has(242), true);
  assert.equal(state.requests.some((item) => item.method === "DELETE"), false);
  state.failure = 0; state.records.get(242).requestedBy.id = 1;
  await assert.rejects(client.replaceRequest(replacement), /preserve the requester/);
  assert.equal(state.requests.filter((item) => item.method === "POST").length, 1);
});

test("partial replacement exposes the new request ID when original removal is denied", async (t) => {
  const { client, state } = fixture(t);
  state.deleteFailure = 403;
  const result = await client.replaceRequest(replacement);
  assert.equal(result.replaced, false);
  assert.equal("originalRemovalUnverified" in result && result.originalRemovalUnverified, true);
  assert.equal("request" in result && result.request.id, 300);
  assert.equal(state.records.has(242), true);
  assert.equal(state.records.has(300), true);
  assert.doesNotMatch(JSON.stringify(result), /private-|secret-api-key/);
});

test("same-scope replacements never delete first to evade duplicate protection", async (t) => {
  const { client, state } = fixture(t);
  await assert.rejects(client.replaceRequest({ ...replacement, is4k: true }), /different 4K scope/);
  assert.equal(state.requests.some((item) => item.method !== "GET"), false);
});

test("all Seerr repairs enforce bot roles, exact confirmation and destructive policy before HTTP", async (t) => {
  const { state } = fixture(t);
  const values = new Map(Object.entries({ "seerr.url": settings.url, "seerr.apiKey": settings.apiKey, "seerr.userMappings": settings.userMappings }));
  const repair = { requireConfirmation: true, allowDestructive: true, allowDirectAdd: false };
  const store = { getString: (key: string) => values.get(key), getJson: (key: string, fallback: unknown) => key === "repair" ? repair : fallback };
  const service = new PiAgentService({} as never, store as never) as any;
  let allowedAction = "";
  const tools = service.createTools({ roles: [], userId: discordId, channelId: "channel", consumeConfirmation: (action: string) => action === allowedAction });
  for (const name of ["update_seerr_request", "retry_seerr_request", "delete_seerr_request", "replace_seerr_request"]) {
    const tool = tools.find((item: { name: string }) => item.name === name);
    const result = await tool.execute("id", replacement);
    assert.equal(result.details.confirmationRequired, true, name);
    values.set("discord.repairRoleIds", "allowed");
    assert.equal((await tool.execute("id", replacement)).details.blocked, true, name);
    values.delete("discord.repairRoleIds");
  }
  repair.requireConfirmation = false; repair.allowDestructive = false;
  for (const name of ["delete_seerr_request", "replace_seerr_request"]) {
    const tool = tools.find((item: { name: string }) => item.name === name);
    assert.match((await tool.execute("id", replacement)).details.reason, /Destructive/);
  }
  assert.equal(state.requests.length, 0);
  repair.requireConfirmation = true; repair.allowDestructive = true;
  const tool = tools.find((item: { name: string }) => item.name === "replace_seerr_request");
  allowedAction = (await tool.execute("id", replacement)).details.action;
  assert.equal((await tool.execute("id", { ...replacement, destination: { ...destination, profileId: 9 } })).details.confirmationRequired, true);
  assert.equal(state.requests.length, 0);
  assert.equal((await tool.execute("id", replacement)).details.replaced, true);
});

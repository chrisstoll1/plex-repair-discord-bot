import assert from "node:assert/strict";
import test from "node:test";
import { PlexMovieClient } from "../src/services/plex-movies.js";
import { PlexClient } from "../src/services/plex-client.js";
import { PiAgentService, toolNamesForTask } from "../src/agent/pi-agent.js";
import { TOOL_PROFILES } from "../src/agent/tool-profiles.js";

const runner = { id: "224898", file: "/movies/Runner (2026)/Runner.mkv" };
const other = { id: "220541", file: "/movies/The Runner (2026)/The.Runner.mkv" };
const oldGuid = "plex://movie/6738e193d70f01a8cec05ff0";
const newGuid = "plex://movie/65d2daf3359932bcaa86b538";
const candidate = `<MediaContainer><SearchResult name="Runner" year="2026" guid="${newGuid}" /></MediaContainer>`;
const fix = { ratingKey: "200000", externalId: "tmdb://1377237", expectedPart: runner, expectedCurrentGuid: oldGuid, matchGuid: newGuid, title: "Runner", year: 2026 };

function video(key: string, parts: Array<{ id: string; file: string }>, corrected = false) {
  return `<Video type="movie" ratingKey="${key}" librarySectionID="1" title="${corrected ? "Runner" : "The Runner"}" year="2026" guid="${corrected ? newGuid : oldGuid}">
    <Guid id="${corrected ? "tmdb://1377237" : "tmdb://1386315"}" /><Guid id="imdb://tt${corrected ? "31349844" : "34564059"}" />
    <Summary>${"filler".repeat(3000)}</Summary>
    ${parts.map((part, index) => `<Media id="${index + 100}" duration="5875000"><Part id="${part.id}" file="${part.file}" size="11263026816" exists="1" accessible="1" /></Media>`).join("")}
    </Video>`;
}
function metadata(key: string, parts: Array<{ id: string; file: string }>, corrected = false) {
  return `<MediaContainer size="1">${video(key, parts, corrected)}</MediaContainer>`;
}
const provider = async () => metadata("65d2daf3359932bcaa86b538", [runner], true);

test("compact movie metadata keeps exact identity and every version beyond raw output limit", async () => {
  const xml = metadata("177708", [other, { id: "224898", file: "/movies/Runner &amp; extras.mkv" }]);
  assert.ok(xml.length > 12000);
  const client = new PlexMovieClient(async (path) => {
    assert.equal(path, "/library/metadata/177708?includeGuids=1"); return xml;
  }, provider);
  const movie = await client.getMovie("177708");
  assert.deepEqual(movie.guids, ["tmdb://1386315", "imdb://tt34564059"]);
  assert.equal(movie.media[1]?.parts[0]?.file, "/movies/Runner & extras.mkv");
  assert.equal(movie.media[0]?.parts[0]?.exists, true);
  assert.ok(JSON.stringify(movie).length < 12000);
  await assert.rejects(client.getMovie("177708,200000"), /single positive/);
  await assert.rejects(new PlexMovieClient(async () => '<MediaContainer><Video type="episode" ratingKey="177708"></Video></MediaContainer>', provider).getMovie("177708"), /non-movie/);
});

test("compact paged search exposes every movie and refuses ignored pagination", async () => {
  const requests: URLSearchParams[] = [];
  const client = new PlexMovieClient(async (path) => {
    const params = new URL(path, "http://plex").searchParams;
    requests.push(params);
    const offset = Number(params.get("X-Plex-Container-Start"));
    return `<MediaContainer offset="${offset}" totalSize="6">${Array.from({ length: 6 - offset }, (_, n) => video(String(100 + offset + n), [runner])).join("")}</MediaContainer>`;
  }, provider);
  const first = await client.findMovies({ sectionId: 1, title: "Runner", year: 2026, limit: 5 });
  assert.equal(first.movies.length, 5);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 5);
  const last = await client.findMovies({ sectionId: 1, title: "Runner", year: 2026, offset: first.nextOffset });
  assert.equal(last.movies[0]?.ratingKey, "105");
  assert.equal(last.hasMore, false);
  assert.equal(requests[0]?.get("includeGuids"), "1");
  assert.equal(requests[0]?.get("type"), "1");
  assert.equal(requests[0]?.get("year"), "2026");
  await assert.rejects(new PlexMovieClient(async () => '<MediaContainer size="6"></MediaContainer>', provider)
    .findMovies({ sectionId: 1, title: "Runner", offset: 5 }), /did not honor/);
});

test("split rejects stale part snapshots and single-version items without mutation", async () => {
  const writes: string[] = [];
  let parts = [other, runner];
  const client = new PlexMovieClient(async (path, method) => {
    if (method === "PUT") writes.push(path);
    return metadata("177708", parts);
  }, provider);
  await assert.rejects(client.splitMovie({ ratingKey: "177708", expectedParts: [runner] }), /parts changed/);
  await assert.rejects(client.splitMovie({ ratingKey: "177708", expectedParts: [other, { ...runner, file: "/wrong.mkv" }] }), /parts changed/);
  parts = [runner];
  await assert.rejects(client.splitMovie({ ratingKey: "177708", expectedParts: [runner] }), /at least two/);
  assert.deepEqual(writes, []);
});

test("split then rediscover then exact Fix Match preserves the other movie and both files", async () => {
  const writes: string[] = [];
  let split = false;
  let corrected = false;
  const client = new PlexMovieClient(async (path, method) => {
    if (method === "PUT") {
      writes.push(path);
      if (path === "/library/metadata/177708/split") split = true;
      else {
        const request = new URL(path, "http://plex");
        assert.equal(request.pathname, "/library/metadata/200000/match");
        assert.equal(request.searchParams.get("guid"), newGuid);
        assert.equal(request.searchParams.get("name"), "Runner");
        assert.equal(request.searchParams.get("year"), "2026");
        corrected = true;
      }
      return "";
    }
    if (path.includes("/matches?")) {
      assert.equal(new URL(path, "http://plex").searchParams.get("title"), "tmdb-1377237");
      return candidate;
    }
    if (path.startsWith("/library/sections/1/all")) return `<MediaContainer offset="0" totalSize="2">${video("177708", [other])}${video("200000", [runner], corrected)}</MediaContainer>`;
    if (path.startsWith("/library/metadata/177708?")) return metadata("177708", split ? [other] : [other, runner]);
    return metadata("200000", [runner], corrected);
  }, provider);
  const result = await client.splitMovie({ ratingKey: "177708", expectedParts: [runner, other] });
  assert.equal(result.splitRequested, true);
  assert.match(result.verificationRequired, /must not be assumed/);
  const found = await client.findMovies({ sectionId: 1, title: "Runner" });
  assert.equal(found.movies.find((movie) => movie.media.some((media) => media.parts.some((part) => part.file === runner.file)))?.ratingKey, "200000");
  const applied = await client.fixMovieMatch(fix);
  assert.equal(applied.verified, true);
  assert.equal(applied.partsPreserved, true);
  const preserved = await client.getMovie("177708");
  assert.equal(preserved.guid, oldGuid);
  assert.deepEqual(preserved.media.flatMap((media) => media.parts).map(({ id, file }) => ({ id, file })), [other]);
  assert.equal(writes.length, 2);
  assert.ok(writes.every((path) => /\/(split|match)(\?|$)/.test(path)));
});

test("Fix Match refuses merged, changed, and wrong file targets before issuing writes", async () => {
  for (const [parts, guid] of [[[runner, other], oldGuid], [[other], oldGuid], [[runner], newGuid]] as const) {
    const methods: string[] = [];
    const client = new PlexMovieClient(async (_path, method) => {
      methods.push(method ?? "GET"); return metadata("200000", [...parts]).replace(oldGuid, guid);
    }, provider);
    await assert.rejects(client.fixMovieMatch(fix), /isolated|identity changed/);
    assert.ok(!methods.includes("PUT"));
  }
});

test("candidate verification rejects ambiguous results, forged GUIDs and provider ID mismatch", async () => {
  for (const scenario of ["ambiguous", "forged", "providerMismatch"]) {
    let writes = 0;
    const client = new PlexMovieClient(async (path, method) => {
      if (method === "PUT") writes++;
      return path.includes("/matches?") ? scenario === "ambiguous" ? candidate.replace("</MediaContainer>", candidate + "</MediaContainer>") : candidate : metadata("200000", [runner]);
    }, scenario === "providerMismatch" ? async () => metadata("key", [runner], true).replace("tmdb://1377237", "tmdb://999") : provider);
    await assert.rejects(client.fixMovieMatch({ ...fix, matchGuid: scenario === "forged" ? oldGuid : newGuid }), /not uniquely verified/);
    assert.equal(writes, 0);
  }
});

test("movie parts are rechecked after lookup and accepted writes can remain unverified", async () => {
  let reads = 0;
  let writes = 0;
  const client = new PlexMovieClient(async (path, method) => {
    if (path.includes("/matches?")) return candidate;
    if (method === "PUT") { writes++; return ""; }
    reads++;
    return metadata("200000", reads === 1 ? [runner] : [runner, other]);
  }, provider);
  await assert.rejects(client.fixMovieMatch(fix), /isolated/);
  assert.equal(writes, 0);
  const pending = new PlexMovieClient(async (path) => path.includes("/matches?") ? candidate : metadata("200000", [runner]), provider);
  assert.equal((await pending.fixMovieMatch(fix)).verified, false);
});

test("actual repair tools enforce roles/confirmation, and post-scan repairs retain split/match", async () => {
  const values = new Map<string, string>();
  let requireConfirmation = true;
  const store = {
    getString: (key: string) => values.get(key),
    getJson: (key: string, fallback: unknown) => key === "repair" ? { requireConfirmation, allowDestructive: false } : fallback,
  };
  const service = new PiAgentService({} as never, store as never) as any;
  const context = { userId: "user", channelId: "channel", roles: [], caseControl: { plexVerification: { followUpChecks: 1, missingMedia: ["Runner"] } } };
  assert.ok(service.availableToolProfiles(context).includes("plex_repair_agent"));
  const request = service.toToolAgentTaskRequest({ title: "fix", toolProfile: "plex_repair_agent", prompt: "fix", input: { plexRefreshBlocked: false } }, context);
  const names = toolNamesForTask(request);
  assert.ok(!names.includes("refresh_plex_library_section"));
  assert.ok(names.includes("split_plex_movie"));
  assert.ok(names.includes("fix_plex_movie_match"));
  assert.ok(!TOOL_PROFILES.plex_agent.includes("split_plex_movie"));
  const tools = service.createTools(context, TOOL_PROFILES.plex_repair_agent);
  for (const [name, params] of [["split_plex_movie", { ratingKey: "177708", expectedParts: [runner, other] }], ["fix_plex_movie_match", fix]] as const) {
    const tool = tools.find((value: { name: string }) => value.name === name);
    const result = await tool.execute("test", params);
    assert.equal(result.details.confirmationRequired, true);
    values.set("discord.repairRoleIds", "allowed");
    requireConfirmation = false;
    assert.equal((await tool.execute("test", params)).details.blocked, true);
    values.delete("discord.repairRoleIds");
    requireConfirmation = true;
  }
});

test("Plex HTTP adapter forwards exact split/match methods and keeps credentials out of URLs", async (t) => {
  const requests: Array<{ url: URL; method: string }> = [];
  let isolated = false;
  let corrected = false;
  t.mock.method(globalThis, "fetch", async (input: URL, options: RequestInit) => {
    const url = new URL(String(input));
    assert.equal((options.headers as Record<string, string>)["X-Plex-Token"], "test-token");
    assert.equal(url.toString().includes("test-token"), false);
    requests.push({ url, method: options.method ?? "GET" });
    let body: string;
    if (url.hostname === "metadata.provider.plex.tv") body = await provider();
    else if (url.pathname.endsWith("/split")) { isolated = true; body = ""; }
    else if (url.pathname.endsWith("/match")) { corrected = true; body = ""; }
    else if (url.pathname.endsWith("/matches")) body = candidate;
    else body = metadata("200000", isolated ? [runner] : [runner, other], corrected);
    return new Response(body, { headers: { "Content-Type": "application/xml" } });
  });
  const client = new PlexClient({ url: "http://plex:32400", token: "test-token" });
  await client.movies.splitMovie({ ratingKey: "200000", expectedParts: [runner, other] });
  assert.equal((await client.movies.fixMovieMatch(fix)).verified, true);
  const writes = requests.filter((request) => request.method !== "GET");
  assert.deepEqual(writes.map((request) => [request.method, request.url.pathname]), [
    ["PUT", "/library/metadata/200000/split"], ["PUT", "/library/metadata/200000/match"],
  ]);
  assert.equal(writes[1]?.url.searchParams.get("guid"), newGuid);
  assert.ok(requests.some((request) => request.url.hostname === "metadata.provider.plex.tv"));
});

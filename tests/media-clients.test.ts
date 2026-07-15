import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ArrClient } from "../src/services/arr-client.js";
import { PlexClient } from "../src/services/plex-client.js";

test("Sonarr manual import executes the same command shape as the UI", async (t) => {
  const requests: Array<{ method?: string; url?: string; body?: unknown }> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : undefined });
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url?.startsWith("/api/v3/manualimport")) {
        response.end(JSON.stringify([{
          id: 1302462566,
          path: "/downloads/House.of.the.Dragon.S03E04.mkv",
          folderName: "House.of.the.Dragon.S03E04",
          series: { id: 599 },
          episodes: [{ id: 152679 }],
          quality: { quality: { id: 3 } },
          languages: [{ id: 1, name: "English" }],
          releaseGroup: "ETHEL",
          downloadId: "download-one",
          indexerFlags: 0,
          releaseType: "singleEpisode",
        }]));
        return;
      }
      response.end(JSON.stringify({ id: 42, status: "queued" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new ArrClient("sonarr", { url: `http://127.0.0.1:${address.port}`, apiKey: "test" });

  await client.executeManualImport({ folder: "/downloads", itemId: 599 }, [1302462566]);

  assert.match(requests[0]!.url!, /manualimport\?.*folder=%2Fdownloads/);
  assert.match(requests[0]!.url!, /seriesId=599/);
  assert.equal(requests[1]?.url, "/api/v3/command");
  assert.deepEqual(requests[1]?.body, {
    name: "ManualImport",
    importMode: "auto",
    files: [{
      path: "/downloads/House.of.the.Dragon.S03E04.mkv",
      folderName: "House.of.the.Dragon.S03E04",
      seriesId: 599,
      episodeIds: [152679],
      quality: { quality: { id: 3 } },
      languages: [{ id: 1, name: "English" }],
      releaseGroup: "ETHEL",
      downloadId: "download-one",
      indexerFlags: 0,
      releaseType: "singleEpisode",
    }],
  });
});

test("Plex section search queries actual library metadata", async (t) => {
  let requestedUrl = "";
  const server = http.createServer((request, response) => {
    requestedUrl = request.url ?? "";
    response.setHeader("Content-Type", "application/xml");
    response.end('<MediaContainer size="1"><Directory ratingKey="123" title="House of the Dragon" /></MediaContainer>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new PlexClient({ url: `http://127.0.0.1:${address.port}`, token: "secret" });

  const result = await client.searchLibrarySection(2, "House of the Dragon");

  assert.match(requestedUrl, /^\/library\/sections\/2\/all\?/);
  assert.match(requestedUrl, /title=House(?:\+|%20)of(?:\+|%20)the(?:\+|%20)Dragon/);
  assert.match(result, /ratingKey="123"/);
});

test("Plex library status reports active scans", async (t) => {
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "application/xml");
    response.end('<MediaContainer><Directory key="2" type="show" title="TV Shows" refreshing="1" /><Directory key="3" type="show" title="Anime" refreshing="0" /></MediaContainer>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new PlexClient({ url: `http://127.0.0.1:${address.port}`, token: "secret" });

  assert.deepEqual(await client.getLibrarySectionStatus(2), { sectionId: 2, title: "TV Shows", type: "show", refreshing: true });
  assert.deepEqual(await client.getLibrarySectionStatus(3), { sectionId: 3, title: "Anime", type: "show", refreshing: false });
  await assert.rejects(client.getLibrarySectionStatus(99), /section 99 was not found/);
});

test("Plex refresh accepts directories, rejects media files, and reports only a submitted request", async (t) => {
  const requestedUrls: string[] = [];
  const server = http.createServer((request, response) => {
    requestedUrls.push(request.url ?? "");
    response.setHeader("Content-Type", "application/xml");
    response.end("");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new PlexClient({ url: `http://127.0.0.1:${address.port}`, token: "secret" });
  const directoryPath = "/mnt/potato-server/Anime/Saga of Tanya the Evil/Season 2";

  assert.deepEqual(await client.refreshLibrarySection(3, directoryPath), { refreshRequested: true, sectionId: 3, directoryPath });
  assert.match(requestedUrls[0]!, /^\/library\/sections\/3\/refresh\?/);
  assert.match(decodeURIComponent(requestedUrls[0]!), /path=\/mnt\/potato-server\/Anime\/Saga(?:\+| )of(?:\+| )Tanya(?:\+| )the(?:\+| )Evil\/Season(?:\+| )2/);
  await assert.rejects(
    client.refreshLibrarySection(3, `${directoryPath}/Saga of Tanya the Evil - S02E02 - A Strange Friendship WEBDL-1080p.mkv`),
    /must be a directory, not a media file/,
  );
  assert.equal(requestedUrls.length, 1);
});

test("Plex season lookup returns compact episodes when the season is beyond the tool response limit", async (t) => {
  const requestedUrls: string[] = [];
  const filler = Array.from({ length: 60 }, (_, index) => `<Directory ratingKey="${1000 + index}" index="${100 + index}" title="${"x".repeat(220)}" />`).join("");
  const server = http.createServer((request, response) => {
    requestedUrls.push(request.url ?? "");
    response.setHeader("Content-Type", "application/xml");
    if (request.url?.startsWith("/library/metadata/89229/children")) {
      response.end(`<MediaContainer>${filler}<Directory ratingKey="season-48" index="48" title="Season 48" /></MediaContainer>`);
      return;
    }
    response.end(`<MediaContainer>
      <Video ratingKey="episode-2" parentIndex="48" index="2" title="Humble Traits"><Media><Part file="/tv/Survivor/Season 48/S48E02 &amp; extras.mkv" /></Media></Video>
      <Video ratingKey="episode-3" parentIndex="48" index="3" title="Committing to the Bit"><Media><Part file="/tv/Survivor/Season 48/S48E03.mkv" /></Media></Video>
    </MediaContainer>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new PlexClient({ url: `http://127.0.0.1:${address.port}`, token: "secret" });

  const result = await client.getTvSeasonEpisodes("89229", 48);

  assert.equal(filler.length > 12_000, true);
  assert.deepEqual(requestedUrls.map((url) => url.split("?")[0]), ["/library/metadata/89229/children", "/library/metadata/season-48/children"]);
  assert.deepEqual(result, {
    showRatingKey: "89229",
    seasonNumber: 48,
    found: true,
    seasonRatingKey: "season-48",
    episodes: [
      { ratingKey: "episode-2", seasonNumber: 48, episodeNumber: 2, title: "Humble Traits", files: ["/tv/Survivor/Season 48/S48E02 & extras.mkv"] },
      { ratingKey: "episode-3", seasonNumber: 48, episodeNumber: 3, title: "Committing to the Bit", files: ["/tv/Survivor/Season 48/S48E03.mkv"] },
    ],
  });
});

test("manual import rejects overrides for unselected candidates", async () => {
  const client = new ArrClient("sonarr", { url: "http://127.0.0.1:1", apiKey: "test" });
  await assert.rejects(
    client.executeManualImport({ folder: "/downloads" }, [1], { overrides: [{ importId: 2, itemId: 599, episodeIds: [152679] }] }),
    /overrides do not match selected IDs: 2/,
  );
});

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

test("manual import rejects overrides for unselected candidates", async () => {
  const client = new ArrClient("sonarr", { url: "http://127.0.0.1:1", apiKey: "test" });
  await assert.rejects(
    client.executeManualImport({ folder: "/downloads" }, [1], { overrides: [{ importId: 2, itemId: 599, episodeIds: [152679] }] }),
    /overrides do not match selected IDs: 2/,
  );
});

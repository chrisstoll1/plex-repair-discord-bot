import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { PlexClient } from "../src/services/plex-client.js";
import { downloadPlexLogs, queryPlexScannerLogs, redactPlexLogLine, validateScannerLogQuery } from "../src/services/plex-scanner-logs.js";
import { TOOL_PROFILES } from "../src/agent/tool-profiles.js";

// Small independent ZIP fixture writer, including stored/deflated entries and CRCs.
function archive(files: Record<string, string>, compressed = true): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const plain = Buffer.from(text);
    const data = compressed ? deflateRawSync(plain) : plain;
    let crc = 0xffffffff;
    for (const byte of plain) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(compressed ? 8 : 0, 8);
    header.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(plain.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    header.copy(entry, 6, 4, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test("scanner logs search rotations, preserve context, and exclude unrelated archive entries", async () => {
  const result = await queryPlexScannerLogs(archive({
    "logs/Plex Media Scanner.1.log": [
      "Nov 07, 2026 10:00:00.000 [1] DEBUG - Starting directory",
      "Nov 07, 2026 10:00:01.000 [1] ERROR - Could not open /movies/Runner (2026)/Runner.mkv",
      "Nov 07, 2026 10:00:02.000 [1] ERROR - Permission denied",
      "Nov 07, 2026 10:00:03.000 [1] DEBUG - unrelated",
    ].join("\n"),
    "logs/Plex Media Scanner Matcher.log": "Nov 07, 2026 11:00:00.000 [1] DEBUG - Runner matched incorrectly",
    "logs/Plex Media Scanner Credits.5.log": "Nov 06, 2026 11:00:00.000 [1] DEBUG - Runner credits analysis",
    "logs/Plex Media Server.log": "Nov 07, 2026 09:00:00.000 [1] DEBUG - Runner scan requested",
    "logs/Preferences.xml": "Runner token=do-not-return",
    "logs/Plex Transcoder.log": "Runner irrelevant",
  }), { query: "runner", contextLines: 1 });
  assert.equal(result.logsAvailable, true);
  assert.equal(result.matchingLines, 4);
  assert.equal(result.entries.length, 6);
  assert.equal(result.entries[0]?.file, "Plex Media Scanner Matcher.log");
  assert.ok(result.entries.some((line) => line.text.endsWith("Permission denied") && !line.matched));
  assert.ok(result.entries.some((line) => line.line === 2 && line.matched));
  assert.equal(result.filesSearched.length, 4);
  assert.equal(JSON.stringify(result).includes("do-not-return"), false);
});

test("scanner time windows use server local dates and exclude out-of-window context", async () => {
  const result = await queryPlexScannerLogs(archive({
    "Plex Media Scanner.log": [
      "undated Runner cannot be placed in time",
      "Dec 31, 2025 23:59:59.999 [1] DEBUG - Runner old year",
      "Jan 01, 2026 00:00:00.000 [1] ERROR - Runner selected",
      "continued error detail",
      "Jan 01, 2026 00:00:01.000 [1] DEBUG - Runner outside window",
    ].join("\n"),
  }, false), { query: "Runner", since: "2026-01-01T00:00:00", until: "2026-01-01T00:00:00", contextLines: 3 });
  assert.equal(result.matchingLines, 1);
  assert.deepEqual(result.entries.map((line) => line.line), [3, 4]);
  assert.equal(result.entries[1]?.timestamp, "2026-01-01T00:00:00");
});

test("scanner pagination stays structured under the general 12000 character tool limit", async () => {
  const bundle = archive({ "Plex Media Scanner.log": Array.from({ length: 80 }, (_, index) =>
    `Nov 07, 2026 10:00:00.000 [1] ERROR - Runner ${index} ${'"'.repeat(2000)}`).join("\n") });
  const seen: number[] = [];
  let offset = 0;
  do {
    const page = await queryPlexScannerLogs(bundle, { query: "Runner", limit: 100, contextLines: 0, offset });
    assert.ok(JSON.stringify(page).length < 12000);
    assert.ok(page.entries.length > 0);
    assert.ok(page.entries.every((entry) => entry.textTruncated));
    seen.push(...page.entries.map((entry) => entry.line));
    if (!page.hasMore) break;
    assert.ok(page.nextOffset! > offset);
    offset = page.nextOffset!;
  } while (true);
  assert.deepEqual(seen, Array.from({ length: 80 }, (_, index) => index + 1));
});

test("scanner log output redacts known secrets and common credential formats", async () => {
  const line = 'Runner X-Plex-Token=other-secret&path=x apiKey: "api-secret" Authorization: Bearer bearer-secret';
  const text = redactPlexLogLine(line);
  for (const secret of ["other-secret", "api-secret", "bearer-secret"]) assert.equal(text.includes(secret), false);
  assert.equal(redactPlexLogLine("Cookie: sid=secret").includes("sid=secret"), false);
  assert.equal(redactPlexLogLine("http://user:password@host/").includes("user:password"), false);
  const result = await queryPlexScannerLogs(archive({
    "Plex Media Server.log": "Nov 07, 2026 10:00:00.000 [1] Runner plain+secret plain%2Bsecret X-Plex-Token=another-secret",
  }), { query: "Runner" }, ["plain+secret"]);
  for (const secret of ["plain+secret", "plain%2Bsecret", "another-secret"]) assert.equal(JSON.stringify(result).includes(secret), false);
});

test("empty/missing logs are inconclusive and invalid archives and expansion bombs fail explicitly", async () => {
  const missing = await queryPlexScannerLogs(archive({ "Preferences.xml": "not a log" }), { query: "Runner" });
  assert.equal(missing.logsAvailable, false);
  assert.equal(missing.matchingLines, 0);
  assert.match(missing.note, /does not prove/);
  const empty = await queryPlexScannerLogs(archive({ "Plex Media Scanner.log": "No related events" }), { query: "Runner" });
  assert.equal(empty.logsAvailable, true);
  assert.equal(empty.entries.length, 0);
  await assert.rejects(queryPlexScannerLogs(Buffer.from("not a zip"), { query: "Runner" }), /invalid log ZIP/);
  await assert.rejects(queryPlexScannerLogs(archive({ "Plex Media Scanner.log": "x".repeat(16 * 1024 * 1024 + 1) }), { query: "Runner" }), /safe log-reading limits/);
});

test("scanner query rejects ambiguous timestamps, invalid windows and unbounded input", () => {
  for (const query of [
    { query: "a" }, { query: "Runner", since: "2026-11-07T10:00:00Z" },
    { query: "Runner", since: "2026-02-30T10:00:00" },
    { query: "Runner", since: "2026-11-08T10:00:00", until: "2026-11-07T10:00:00" },
    { query: "Runner", contextLines: 100 }, { query: "Runner", limit: -1 }, { query: "Runner", offset: 0.5 },
  ]) assert.throws(() => validateScannerLogQuery(query));
});

test("Plex client uses authenticated read-only diagnostic API with bounded results", async (t) => {
  const requests: Array<{ method?: string; url?: string; token?: string }> = [];
  const bundle = archive({ "Plex Media Scanner.log": "Nov 07, 2026 10:00:00.000 [1] Runner path unreadable token=secret" });
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, token: request.headers["x-plex-token"] as string });
    response.setHeader("Content-Type", "application/zip");
    response.end(bundle);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new PlexClient({ url: `http://127.0.0.1:${address.port}`, token: "secret" });
  const result = await client.getScannerLogs({ query: "Runner" });
  assert.deepEqual(requests, [{ method: "GET", url: "/diagnostics/logs", token: "secret" }]);
  assert.equal(result.matchingLines, 1);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  for (const profile of ["plex_agent", "plex_repair_agent"] as const) assert.ok(TOOL_PROFILES[profile].includes("get_plex_scanner_logs"));
  assert.equal(TOOL_PROFILES.radarr_agent.includes("get_plex_scanner_logs"), false);
});

test("log download errors never echo server bodies and stalled bodies respect timeout", async (t) => {
  let mode = "denied";
  const server = http.createServer((_request, response) => {
    if (mode === "denied") { response.writeHead(403); response.end("X-Plex-Token=server-secret"); return; }
    if (mode === "oversize") { response.writeHead(200, { "Content-Length": 40 * 1024 * 1024 }); response.end(); return; }
    response.writeHead(200);
    response.write("partial archive");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  await assert.rejects(downloadPlexLogs(url, "secret", 2), (error: Error) => error.message.includes("HTTP 403") && !error.message.includes("server-secret"));
  mode = "oversize";
  await assert.rejects(downloadPlexLogs(url, "secret", 2), /32 MiB/);
  mode = "stalled";
  await assert.rejects(downloadPlexLogs(url, "secret", 0.05), /timed out/);
});

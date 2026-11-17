import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const image = process.argv[2] || "plex-repairman:dev";
const prefix = `repairman-smoke-${crypto.randomBytes(5).toString("hex")}`;
const containers = new Set();
const volumes = new Set();
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 }).trim();
const runSource = (args, source) => execFileSync("docker", ["run", "--rm", "-i", ...args, "--entrypoint", "node", image, "--input-type=module"], { input: source, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function start(name, volume, uid) {
  containers.add(name);
  docker("run", "-d", "--name", name, "--init", "--user", `${uid}:${uid}`, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m,mode=1777", "--mount", `type=volume,source=${volume},target=/config`, "--publish", "127.0.0.1::3000", image);
  const port = JSON.parse(docker("inspect", "--format", '{{json .NetworkSettings.Ports}}', name))["3000/tcp"][0].HostPort;
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${base}/health`)).ok) return base; } catch { /* startup */ }
    if (docker("inspect", "--format", "{{.State.Running}}", name) !== "true") throw new Error(`Test container ${name} exited during startup.`);
    await pause(500);
  }
  throw new Error(`Test container ${name} did not become healthy.`);
}

async function request(base, route, { method = "GET", body, session, expected = 200 } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { "X-Repairman-Request": "1", ...(body ? { "Content-Type": "application/json" } : {}), ...(session ? { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, expected, `${method} ${route.replace(/\/webhooks\/[^/]+\/.*/, "/webhooks/[redacted]")}`);
  const value = await response.json();
  return { value, cookie: response.headers.get("set-cookie")?.split(";")[0], csrfToken: value.csrfToken };
}

async function setup(base, name, password) {
  const token = docker("exec", name, "cat", "/config/portal-setup-token");
  const result = await request(base, "/api/auth/setup", { method: "POST", body: { token, password } });
  assert.ok(result.cookie);
  assert.match(result.cookie, /^repairman_session=/);
  assert.equal(docker("exec", name, "id", "-u") === "0", false);
  return { cookie: result.cookie, csrfToken: result.csrfToken };
}

function stop(name) { docker("rm", "-f", name); containers.delete(name); }

try {
  for (const [uid, legacy] of [[1000, false], [568, true]]) {
    const volume = `${prefix}-${uid}`;
    volumes.add(volume);
    docker("volume", "create", volume);
    const mount = ["--user", "0:0", "--mount", `type=volume,source=${volume},target=/config`];
    runSource(mount, `
      import fs from 'node:fs';
      import { openDatabase } from './dist/storage/db.js';
      import { SettingsStore } from './dist/storage/settings.js';
      import { SecretBox } from './dist/storage/secrets.js';
      import { RepairCaseStore } from './dist/storage/repair-cases.js';
      if (${legacy}) {
        const db = openDatabase({ databasePath: '/config/plex-repairman.db' });
        const settings = new SettingsStore(db, SecretBox.open('/config/secrets.key'));
        settings.setString('discord.allowedGuildIds', 'legacy-guild');
        settings.setString('sonarr.apiKey', 'synthetic-upgrade-key', { secret: true });
        new RepairCaseStore(db).create({ guildId: 'legacy-guild', threadId: 'legacy-thread', source: 'fixture', userId: 'test', authorizationActor: 'test', title: 'Legacy repair', objective: 'Preserve historical data', status: 'cancelled' });
        db.prepare("UPDATE repair_cases SET status = 'cancelled'").run();
        db.close();
      }
      fs.chownSync('/config', ${uid}, ${uid});
      for (const name of fs.readdirSync('/config')) fs.chownSync('/config/' + name, ${uid}, ${uid});
    `);
    let name = `${prefix}-app-${uid}`;
    let base = await start(name, volume, uid);
    assert.deepEqual((await request(base, "/api/auth/session")).value, { authenticated: false, setupRequired: true });
    await request(base, "/api/settings", { expected: 401 });
    const password = crypto.randomBytes(24).toString("base64url");
    let session = await setup(base, name, password);
    const { value: { settings } } = await request(base, "/api/settings", { session });
    assert.equal(settings.repair.requireConfirmation, true);
    assert.equal(settings.repair.allowDestructive, false);
    assert.equal(settings.repair.allowDirectAdd, false);
    if (legacy) {
      assert.equal(settings.discord.allowedGuildIds, "legacy-guild");
      assert.equal(settings.sonarr.apiKey.configured, true);
      const repairs = (await request(base, "/api/repairs", { session })).value.repairs;
      assert.equal(repairs.some((repair) => repair.title === "Legacy repair"), true);
    }
    const payload = structuredClone(settings);
    for (const [section, key] of [["discord", "token"], ["sonarr", "apiKey"], ["radarr", "apiKey"], ["plex", "token"], ["seerr", "apiKey"]]) payload[section][key] = { action: "keep" };
    payload.discord.allowedGuildIds = "smoke-persisted-guild";
    await request(base, "/api/settings", { method: "PUT", session, body: payload });
    const webhook = (await request(base, "/api/webhooks/config", { method: "PUT", session, body: { publicBaseUrl: base, sonarrEnabled: true, radarrEnabled: false } })).value;
    await request(base, new URL(webhook.sonarrUrl).pathname, { method: "POST", body: { eventType: "Test" }, expected: 202 });
    await request(base, "/webhooks/sonarr/incorrect", { method: "POST", body: { eventType: "Test" }, expected: 401 });
    const logs = docker("logs", name);
    assert.equal(logs.includes(password), false);
    assert.equal(logs.includes(new URL(webhook.sonarrUrl).pathname), false);
    stop(name);

    // Restoring a stopped configuration volume must retain the database and its encryption key together.
    const restored = `${prefix}-restored-${uid}`;
    volumes.add(restored); docker("volume", "create", restored);
    docker("run", "--rm", "--user", "0:0", "--mount", `type=volume,source=${volume},target=/source,readonly`, "--mount", `type=volume,source=${restored},target=/backup`, "--entrypoint", "sh", image, "-c", "cp -a /source/. /backup/");
    name = `${prefix}-restored-app-${uid}`;
    base = await start(name, restored, uid);
    await request(base, "/api/settings", { session, expected: 401 });
    assert.equal((await request(base, "/api/auth/session")).value.setupRequired, false);
    const login = await request(base, "/api/auth/login", { method: "POST", body: { password } });
    session = { cookie: login.cookie, csrfToken: login.csrfToken };
    assert.equal((await request(base, "/api/settings", { session })).value.settings.discord.allowedGuildIds, "smoke-persisted-guild");
    if (legacy) assert.equal((await request(base, "/api/settings", { session })).value.settings.sonarr.apiKey.configured, true);
    stop(name);

    docker("run", "--rm", "--user", `${uid}:${uid}`, "--mount", `type=volume,source=${restored},target=/config`, "--entrypoint", "node", image, "scripts/reset-portal-password.mjs", "--confirm");
    base = await start(name, restored, uid);
    assert.equal((await request(base, "/api/auth/session")).value.setupRequired, true);
    session = await setup(base, name, crypto.randomBytes(24).toString("base64url"));
    assert.equal((await request(base, "/api/settings", { session })).value.settings.discord.allowedGuildIds, "smoke-persisted-guild");
    stop(name);
    console.log(`Passed: UID ${uid}, ${legacy ? "legacy configuration upgrade" : "fresh installation"}, authentication, webhooks, backup/restore and offline password recovery.`);
  }
} finally {
  for (const name of containers) { try { docker("rm", "-f", name); } catch { /* best effort */ } }
  for (const name of volumes) { try { docker("volume", "rm", name); } catch { /* best effort */ } }
}

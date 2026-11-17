import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const image = process.argv[2] || "plex-repairman:dev";
const prefix = `repairman-smoke-${crypto.randomBytes(5).toString("hex")}`;
const containers = new Set();
const volumes = new Set();
const browsers = new Map();
const proxyBasic = `Basic ${Buffer.from("proxy-user:independent-proxy-password").toString("base64")}`;
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

async function request(base, route, { method = "GET", body, auth, expected = 200 } = {}) {
  const browser = browsers.get(base);
  const response = await fetch(`${base}${route}`, { method,
    headers: { "X-Repairman-Request": "1", ...(body ? { "Content-Type": "application/json" } : {}), ...(auth ? { Authorization: proxyBasic, ...(browser?.cookie ? { Cookie: browser.cookie } : {}), ...(browser?.csrfToken ? { "X-CSRF-Token": browser.csrfToken } : {}) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, expected, `${method} ${route.replace(/\/webhooks\/[^/]+\/.*/, "/webhooks/[redacted]")}`);
  const data = await response.json();
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  const session = data.session ?? (route === "/api/auth/login" ? data : undefined);
  if (cookie || session) browsers.set(base, { cookie: cookie ?? browser?.cookie, csrfToken: session?.csrfToken ?? browser?.csrfToken });
  return data;
}
function stop(name) { docker("rm", "-f", name); containers.delete(name); }

try {
  for (const [uid, mode] of [[1000, "fresh"], [568, "unfinished"], [1000, "configured"], [1000, "basic"]]) {
    const volume = `${prefix}-${mode}`;
    volumes.add(volume); docker("volume", "create", volume);
    const password = crypto.randomBytes(24).toString("base64url");
    const auth = true;
    runSource(["--user", "0:0", "--mount", `type=volume,source=${volume},target=/config`], `
      import fs from 'node:fs';
      import crypto from 'node:crypto';
      import { openDatabase } from './dist/storage/db.js';
      import { SettingsStore } from './dist/storage/settings.js';
      import { SecretBox } from './dist/storage/secrets.js';
      import { RepairCaseStore } from './dist/storage/repair-cases.js';
      if (${mode !== "fresh"}) {
        const db = openDatabase({ databasePath: '/config/plex-repairman.db' });
        const settings = new SettingsStore(db, SecretBox.open('/config/secrets.key'));
        settings.setString('discord.allowedGuildIds', 'legacy-guild');
        settings.setString('sonarr.apiKey', 'synthetic-upgrade-key', { secret: true });
        new RepairCaseStore(db).create({ guildId: 'legacy-guild', threadId: 'legacy-thread', source: 'fixture', userId: 'test', authorizationActor: 'test', title: 'Legacy repair', objective: 'Preserve historical data' });
        db.prepare("UPDATE repair_cases SET status = 'cancelled'").run();
        if (${mode === "configured" || mode === "basic"}) {
          const salt = crypto.randomBytes(32).toString('base64url');
          const hash = crypto.scryptSync(${JSON.stringify(password)}, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }).toString('hex');
          if (${mode === "basic"}) settings.setJson('portal.basicAuth', { salt, hash, enabled: true, username: 'admin', revision: 'legacy' }, { secret: true });
          else settings.setJson('portal.adminCredential', { salt, hash }, { secret: true });
        }
        fs.writeFileSync('/config/portal-setup-token', 'obsolete-synthetic-token', { mode: 0o600 });
        db.close();
      }
      fs.chownSync('/config', ${uid}, ${uid});
      for (const name of fs.readdirSync('/config')) fs.chownSync('/config/' + name, ${uid}, ${uid});
    `);
    let name = `${prefix}-app-${mode}`;
    let base = await start(name, volume, uid);
    if (mode === "configured" || mode === "basic") await request(base, "/api/settings", { expected: 401 });
    else {
      assert.deepEqual(await request(base, "/api/portal-auth"), { enabled: false, username: "admin", passwordConfigured: false });
      await request(base, "/api/portal-auth", { method: "PUT", body: { enabled: true, username: "admin", password } });
    }
    await request(base, "/api/auth/login", { method: "POST", body: { username: "admin", password } });
    assert.equal(docker("exec", name, "node", "-p", "require('fs').existsSync('/config/portal-setup-token')"), "false");
    const { settings } = await request(base, "/api/settings", { auth });
    assert.equal(settings.repair.requireConfirmation, true);
    assert.equal(settings.repair.allowDestructive, false);
    assert.equal(settings.repair.allowDirectAdd, false);
    if (mode !== "fresh") {
      assert.equal(settings.discord.allowedGuildIds, "legacy-guild");
      assert.equal(settings.sonarr.apiKey.configured, true);
      assert.equal((await request(base, "/api/repairs", { auth })).repairs.some((repair) => repair.title === "Legacy repair"), true);
    }
    const payload = structuredClone(settings);
    for (const [section, key] of [["discord", "token"], ["sonarr", "apiKey"], ["radarr", "apiKey"], ["plex", "token"], ["seerr", "apiKey"]]) payload[section][key] = { action: "keep" };
    payload.discord.allowedGuildIds = "smoke-persisted-guild";
    await request(base, "/api/settings", { method: "PUT", auth, body: payload });
    const webhook = await request(base, "/api/webhooks/config", { method: "PUT", auth, body: { publicBaseUrl: base, sonarrEnabled: true, radarrEnabled: false } });
    await request(base, new URL(webhook.sonarrUrl).pathname, { method: "POST", body: { eventType: "Test" }, expected: 202 });
    await request(base, "/webhooks/sonarr/incorrect", { method: "POST", body: { eventType: "Test" }, expected: 401 });
    await request(base, "/api/portal-auth", { method: "PUT", auth, body: { enabled: false, username: "admin", currentPassword: password } });
    await request(base, "/api/settings");
    await request(base, "/api/portal-auth", { method: "PUT", body: { enabled: true, username: "admin" } });
    const logs = docker("logs", name);
    assert.equal(logs.includes(password), false);
    assert.equal(logs.includes(proxyBasic), false);
    assert.equal(logs.includes(new URL(webhook.sonarrUrl).pathname), false);
    stop(name);
    const restored = `${prefix}-restored-${mode}`;
    volumes.add(restored); docker("volume", "create", restored);
    docker("run", "--rm", "--user", "0:0", "--mount", `type=volume,source=${volume},target=/source,readonly`, "--mount", `type=volume,source=${restored},target=/backup`, "--entrypoint", "sh", image, "-c", "cp -a /source/. /backup/");
    name = `${prefix}-restored-app-${mode}`;
    base = await start(name, restored, uid);
    await request(base, "/api/settings", { expected: 401 });
    await request(base, "/api/auth/login", { method: "POST", body: { username: "admin", password } });
    assert.equal((await request(base, "/api/settings", { auth })).settings.discord.allowedGuildIds, "smoke-persisted-guild");
    if (mode !== "fresh") assert.equal((await request(base, "/api/settings", { auth })).settings.sonarr.apiKey.configured, true);
    stop(name);
    docker("run", "--rm", "--user", `${uid}:${uid}`, "--mount", `type=volume,source=${restored},target=/config`, "--entrypoint", "node", image, "scripts/reset-portal-password.mjs", "--confirm");
    base = await start(name, restored, uid);
    assert.deepEqual(await request(base, "/api/portal-auth"), { enabled: false, username: "admin", passwordConfigured: false });
    assert.equal((await request(base, "/api/settings")).settings.discord.allowedGuildIds, "smoke-persisted-guild");
    stop(name);
    console.log(`Passed: UID ${uid}, ${mode}, form login with proxy credentials, migration, webhooks, backup/restore and offline recovery.`);
  }
} finally {
  for (const name of containers) { try { docker("rm", "-f", name); } catch { /* best effort */ } }
  for (const name of volumes) { try { docker("volume", "rm", name); } catch { /* best effort */ } }
}

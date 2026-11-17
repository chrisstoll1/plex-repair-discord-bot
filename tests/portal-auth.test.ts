import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { z } from "zod";
import { openDatabase } from "../src/storage/db.js";
import { SettingsStore } from "../src/storage/settings.js";
import { SecretBox } from "../src/storage/secrets.js";
import { PortalAuthService, registerPortalAuth } from "../src/web/portal-auth.js";
import type { AppConfig } from "../src/config.js";

const password = "a-test-form-password";
const proxyAuthorization = `Basic ${Buffer.from("proxy-user:independent-proxy-password").toString("base64")}`;
type Browser = { cookie: string; csrf: string };
const browser = (response: { headers: Record<string, unknown>; json: () => any }): Browser => ({ cookie: String(response.headers["set-cookie"]).split(";")[0]!, csrf: response.json().session?.csrfToken ?? response.json().csrfToken });

async function fixture(t: test.TestContext, legacy?: "pending" | "configured" | "basic-enabled" | "basic-disabled", secure = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repairman-portal-auth-"));
  const db = openDatabase({ databasePath: path.join(root, "app.db") } as AppConfig);
  const store = new SettingsStore(db, SecretBox.open(path.join(root, "secrets.key")));
  if (legacy) fs.writeFileSync(path.join(root, "portal-setup-token"), "obsolete-test-token", { mode: 0o600 });
  if (legacy && legacy !== "pending") {
    const salt = crypto.randomBytes(32).toString("base64url");
    const hash = crypto.scryptSync(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }).toString("hex");
    if (legacy === "configured") store.setJson("portal.adminCredential", { salt, hash }, { secret: true });
    else store.setJson("portal.basicAuth", { enabled: legacy === "basic-enabled", username: "owner", salt, hash, revision: "old-revision" }, { secret: true });
  }
  let now = Date.now();
  const auth = new PortalAuthService(store, root, secure, () => now);
  const app = Fastify();
  registerPortalAuth(app, auth);
  app.get("/health", async () => ({ ok: true }));
  app.get("/", async () => "Sign-in shell");
  app.get("/assets/app.js", async () => "JavaScript");
  app.get("/api/private", async () => ({ private: true }));
  app.post("/api/private", async () => ({ changed: true }));
  app.post("/webhooks/:provider/:secret", async (request, reply) => {
    if ((request.params as { secret: string }).secret !== "valid-secret") return reply.code(401).send({ ok: false });
    return reply.code(202).send({ accepted: true });
  });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof z.ZodError ? 400 : error.statusCode || 500).send({ error: error.message }));
  t.after(async () => { await app.close(); db.close(); fs.rmSync(root, { force: true, recursive: true }); });
  const headers = (session?: Browser) => ({ "x-repairman-request": "1", ...(session ? { cookie: session.cookie, "x-csrf-token": session.csrf } : {}) });
  const update = (body: unknown, session?: Browser, extra: Record<string, string> = {}) => app.inject({ method: "PUT", url: "/api/portal-auth", headers: { ...headers(session), ...extra }, payload: body });
  const login = (username = "admin", value = password) => app.inject({ method: "POST", url: "/api/auth/login", headers: { ...headers(), authorization: proxyAuthorization }, payload: { username, password: value } });
  const read = (session?: Browser) => app.inject({ url: "/api/private", headers: session ? { cookie: session.cookie } : {} });
  return { app, auth, store, db, root, update, login, read, headers, advance: (milliseconds: number) => { now += milliseconds; } };
}

test("optional login defaults off; unfinished setup is removed without changing service settings", async (t) => {
  const f = await fixture(t, "pending");
  f.store.setString("sonarr.apiKey", "preserved-test-key", { secret: true });
  assert.equal((await f.read()).statusCode, 200);
  assert.deepEqual((await f.app.inject("/api/auth/session")).json(), { enabled: false, authenticated: false });
  assert.equal(fs.existsSync(path.join(f.root, "portal-setup-token")), false);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/private" })).statusCode, 403);
  assert.equal((await f.update({ enabled: true, username: "admin" })).statusCode, 400);
  assert.equal(f.store.getString("sonarr.apiKey"), "preserved-test-key");
});

test("enabling login keeps the saving browser signed in; APIs use a cookie independently of proxy Basic", async (t) => {
  const f = await fixture(t, undefined, true);
  const enabled = await f.update({ enabled: true, username: "admin", password });
  assert.equal(enabled.statusCode, 200);
  const session = browser(enabled);
  assert.equal(enabled.json().session.authenticated, true);
  assert.match(String(enabled.headers["set-cookie"]), /HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
  const row = f.db.prepare("SELECT value, secret FROM app_settings WHERE key = 'portal.login'").get() as { value: string; secret: number };
  assert.equal(row.secret, 1);
  assert.doesNotMatch(row.value, /a-test-form-password|"hash"|"salt"/);
  for (const url of ["/api/private", "/api/portal-auth", "/api/not-real", "/api/"]) {
    const response = await f.app.inject(url);
    assert.equal(response.statusCode, 401, url);
    assert.equal(response.headers["www-authenticate"], undefined, "application never opens a Basic dialog");
    assert.equal(response.headers["cache-control"], "no-store");
  }
  for (const url of ["/", "/assets/app.js", "/health"]) assert.equal((await f.app.inject(url)).statusCode, 200);
  assert.equal((await f.app.inject({ url: "/api/private", headers: { cookie: session.cookie, authorization: proxyAuthorization } })).statusCode, 200);
  assert.equal((await f.app.inject({ url: "/api/private", headers: { authorization: proxyAuthorization } })).statusCode, 401);
  const loggedIn = await f.login();
  assert.equal(loggedIn.statusCode, 200);
  assert.equal((await f.read(browser(loggedIn))).statusCode, 200);
  assert.equal((await f.login("wrong")).statusCode, 401);
  const snapshot = await f.app.inject({ url: "/api/auth/session", headers: { cookie: browser(loggedIn).cookie } });
  assert.equal(snapshot.json().authenticated, true);
  assert.doesNotMatch(snapshot.body, /"hash"|"salt"|a-test-form-password/);
});

test("mutations require session CSRF and request-origin checks; health and secret webhooks stay independent", async (t) => {
  const f = await fixture(t);
  const session = browser(await f.update({ enabled: true, username: "admin", password }));
  for (const headers of [{ cookie: session.cookie }, { ...f.headers(session), "x-csrf-token": "wrong" }, { ...f.headers(session), "sec-fetch-site": "cross-site" }]) {
    assert.equal((await f.app.inject({ method: "POST", url: "/api/private", headers })).statusCode, 403);
  }
  assert.equal((await f.app.inject({ method: "POST", url: "/api/private", headers: f.headers(session) })).statusCode, 200);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password } })).statusCode, 403);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/auth/login", headers: { ...f.headers(), "sec-fetch-site": "cross-site" }, payload: { username: "admin", password } })).statusCode, 403);
  assert.equal((await f.app.inject({ method: "POST", url: "/webhooks/sonarr/valid-secret" })).statusCode, 202);
  assert.equal((await f.app.inject({ method: "POST", url: "/webhooks/sonarr/wrong" })).statusCode, 401);
});

test("sessions expire, sign out, rotate on login and never survive a process restart", async (t) => {
  const f = await fixture(t);
  const initial = browser(await f.update({ enabled: true, username: "admin", password }));
  const rotated = await f.app.inject({ method: "POST", url: "/api/auth/login", headers: f.headers(initial), payload: { username: "admin", password } });
  assert.equal((await f.read(initial)).statusCode, 401);
  const session = browser(rotated);
  assert.equal((await f.read(session)).statusCode, 200);
  const restarted = new PortalAuthService(f.store, f.root);
  assert.equal(restarted.session({ headers: { cookie: session.cookie } } as never), undefined);
  const logout = await f.app.inject({ method: "POST", url: "/api/auth/logout", headers: f.headers(session) });
  assert.equal(logout.statusCode, 200);
  assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);
  assert.equal((await f.read(session)).statusCode, 401);
  const expired = browser(await f.login());
  f.advance(12 * 60 * 60 * 1000 + 1);
  assert.equal((await f.read(expired)).statusCode, 401);
});

test("security changes require current password, revoke other sessions and support disabling and re-enabling", async (t) => {
  const f = await fixture(t);
  const initial = browser(await f.update({ enabled: true, username: "admin", password }));
  const other = browser(await f.login());
  assert.equal((await f.update({ enabled: false, username: "admin", currentPassword: "wrong" }, initial)).statusCode, 401);
  assert.equal((await f.read(initial)).statusCode, 200);
  const changed = await f.update({ enabled: true, username: "owner", password: "changed-password", currentPassword: password }, initial);
  assert.equal(changed.statusCode, 200);
  assert.equal((await f.read(other)).statusCode, 401);
  assert.equal((await f.read(initial)).statusCode, 401);
  const current = browser(changed);
  assert.equal((await f.read(current)).statusCode, 200);
  assert.equal((await f.login()).statusCode, 401);
  assert.equal((await f.login("owner", "changed-password")).statusCode, 200);
  const off = await f.update({ enabled: false, username: "owner", currentPassword: "changed-password" }, current);
  assert.equal(off.statusCode, 200);
  assert.equal((await f.read()).statusCode, 200);
  assert.equal((await f.update({ enabled: true, username: "owner" })).statusCode, 200);
  assert.equal((await f.read(current)).statusCode, 401, "disabled sessions cannot be reused on re-enable");
  assert.equal((await f.login("owner", "changed-password")).statusCode, 200);
});

for (const mode of ["configured", "basic-enabled", "basic-disabled"] as const) test(`migration preserves ${mode} credentials and enabled state`, async (t) => {
  const f = await fixture(t, mode);
  const username = mode === "configured" ? "admin" : "owner";
  assert.deepEqual(f.auth.settings, { enabled: mode !== "basic-disabled", username, passwordConfigured: true });
  assert.equal(f.store.getString("portal.adminCredential"), undefined);
  assert.equal(f.store.getString("portal.basicAuth"), undefined);
  assert.equal(fs.existsSync(path.join(f.root, "portal-setup-token")), false);
  if (mode === "basic-disabled") await f.update({ enabled: true, username });
  assert.equal((await f.login(username)).statusCode, 200);
});

test("failed form passwords are throttled and malformed saved credentials fail closed", async (t) => {
  const f = await fixture(t);
  for (const body of [{ enabled: true, username: "invalid:name", password }, { enabled: true, username: "admin", password: "short" }]) assert.equal((await f.update(body)).statusCode, 400);
  await f.update({ enabled: true, username: "admin", password });
  for (let index = 0; index < 10; index += 1) assert.equal((await f.login("admin", "wrong-password")).statusCode, 401);
  assert.equal((await f.login()).statusCode, 429);
  f.advance(15 * 60 * 1000 + 1);
  assert.equal((await f.login()).statusCode, 200);
  f.store.setJson("portal.login", { enabled: true, username: "admin", revision: "bad" }, { secret: true });
  assert.throws(() => new PortalAuthService(f.store, f.root));
});

test("concurrent first-time enables cannot replace the first account", async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all([f.update({ enabled: true, username: "first", password }), f.update({ enabled: true, username: "second", password: "second-password" })]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
  assert.equal((await f.login("first")).statusCode, 200);
  assert.equal((await f.login("second", "second-password")).statusCode, 401);
});

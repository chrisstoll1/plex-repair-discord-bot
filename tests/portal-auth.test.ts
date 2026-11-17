import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { openDatabase } from "../src/storage/db.js";
import { SettingsStore } from "../src/storage/settings.js";
import { SecretBox } from "../src/storage/secrets.js";
import { PortalAuthService, registerPortalAuth } from "../src/web/portal-auth.js";
import type { AppConfig } from "../src/config.js";

const password = "a-test-admin-password";

async function fixture(t: test.TestContext, secure = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repairman-portal-auth-"));
  const config = { configDir: root, databasePath: path.join(root, "app.db") } as AppConfig;
  const db = openDatabase(config);
  const store = new SettingsStore(db, SecretBox.open(path.join(root, "secrets.key")));
  let now = Date.now();
  const auth = new PortalAuthService(store, root, secure, () => now);
  const app = Fastify();
  registerPortalAuth(app, auth);
  app.get("/health", async () => ({ ok: true }));
  app.get("/api/private", async () => ({ private: true }));
  app.post("/api/private", async () => ({ changed: true }));
  app.post("/webhooks/:provider/:secret", async () => ({ accepted: true }));
  app.setErrorHandler((error, _request, reply) => reply.code(error.statusCode || 400).send({ error: error.message }));
  t.after(async () => { await app.close(); db.close(); fs.rmSync(root, { force: true, recursive: true }); });
  const setupToken = fs.readFileSync(auth.setupTokenPath, "utf8").trim();
  const setup = () => app.inject({ method: "POST", url: "/api/auth/setup", headers: { "x-repairman-request": "1" }, payload: { token: setupToken, password } });
  return { app, auth, store, db, root, setup, setupToken, advance: (milliseconds: number) => { now += milliseconds; } };
}

test("unconfigured and configured portals protect every admin route while health and webhooks remain accessible", async (t) => {
  const { app, auth, setup, db, setupToken } = await fixture(t, true);
  assert.deepEqual((await app.inject("/api/auth/session")).json(), { authenticated: false, setupRequired: true });
  assert.equal((await app.inject("/api/private")).statusCode, 401);
  assert.equal((await app.inject("/api/private?x=1")).statusCode, 401);
  assert.equal((await app.inject("/health")).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/webhooks/sonarr/synthetic-secret", payload: {} })).statusCode, 200);
  const claimed = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { "x-repairman-request": "1" }, payload: { token: "wrong-token", password } });
  assert.equal(claimed.statusCode, 401);
  const created = await setup();
  assert.equal(created.statusCode, 200);
  const cookie = String(created.headers["set-cookie"]).split(";")[0]!;
  assert.match(String(created.headers["set-cookie"]), /HttpOnly; SameSite=Strict; Max-Age=43200; Secure/);
  assert.equal(fs.existsSync(auth.setupTokenPath), false);
  const stored = db.prepare("SELECT value, secret FROM app_settings WHERE key = 'portal.adminCredential'").get() as { value: string; secret: number };
  assert.equal(stored.secret, 1);
  assert.doesNotMatch(stored.value, new RegExp(`${password}|${setupToken}|salt|hash`));
  assert.equal((await setup()).statusCode, 409, "the setup token cannot be reused");
  const session = await app.inject({ url: "/api/auth/session", headers: { cookie } });
  assert.equal(session.json().authenticated, true);
  assert.equal(session.headers["cache-control"], "no-store");
  assert.equal((await app.inject({ url: "/api/private", headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/private", headers: { cookie } })).statusCode, 403);
  const headers = { cookie, "x-repairman-request": "1", "x-csrf-token": created.json().csrfToken };
  assert.equal((await app.inject({ method: "POST", url: "/api/private", headers: { ...headers, "x-csrf-token": "wrong" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/private", headers: { ...headers, "sec-fetch-site": "cross-site" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/private", headers })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/private", headers: { cookie } })).statusCode, 401);
});

test("sign-in is rate limited, validates password size and cannot be triggered by a plain cross-origin form", async (t) => {
  const { app, setup, advance } = await fixture(t);
  assert.equal((await setup()).statusCode, 200);
  const login = (value: string) => app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-repairman-request": "1" }, payload: { password: value } });
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password } })).statusCode, 403);
  assert.equal((await login("x".repeat(257))).statusCode, 400);
  for (let index = 0; index < 10; index += 1) assert.equal((await login("wrong-password")).statusCode, 401);
  assert.equal((await login(password)).statusCode, 429);
  advance(15 * 60 * 1000 + 1);
  const signedIn = await login(password);
  assert.equal(signedIn.statusCode, 200);
  const cookie = String(signedIn.headers["set-cookie"]).split(";")[0]!;
  advance(12 * 60 * 60 * 1000 + 1);
  assert.equal((await app.inject({ url: "/api/private", headers: { cookie } })).statusCode, 401);
});

test("password changes revoke other sessions; credentials survive restart while sessions do not", async (t) => {
  const { app, setup, auth, store, root } = await fixture(t);
  const first = await setup();
  const second = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-repairman-request": "1" }, payload: { password } });
  const firstCookie = String(first.headers["set-cookie"]).split(";")[0]!;
  const secondCookie = String(second.headers["set-cookie"]).split(";")[0]!;
  const headers = { cookie: firstCookie, "x-repairman-request": "1", "x-csrf-token": first.json().csrfToken };
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/password", headers, payload: { currentPassword: "wrong", newPassword: "the-new-admin-password" } })).statusCode, 401);
  const changed = await app.inject({ method: "POST", url: "/api/auth/password", headers, payload: { currentPassword: password, newPassword: "the-new-admin-password" } });
  assert.equal(changed.statusCode, 200);
  assert.equal((await app.inject({ url: "/api/private", headers: { cookie: firstCookie } })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/private", headers: { cookie: secondCookie } })).statusCode, 401);
  const restarted = new PortalAuthService(store, root);
  assert.equal(restarted.configured, true);
  assert.equal(fs.existsSync(auth.setupTokenPath), false);
  await assert.rejects(restarted.verify(password, "restart"), /Incorrect/);
  await restarted.verify("the-new-admin-password", "restart");
  const server = Fastify();
  registerPortalAuth(server, restarted);
  server.get("/api/private", async () => ({}));
  t.after(() => server.close());
  assert.equal((await server.inject({ url: "/api/private", headers: { cookie: String(changed.headers["set-cookie"]).split(";")[0] } })).statusCode, 401);
});

test("simultaneous setup attempts cannot replace the first administrator", async (t) => {
  const { setup } = await fixture(t);
  const responses = await Promise.all([setup(), setup()]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
});

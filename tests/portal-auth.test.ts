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

const password = "a-test-basic-password";
const basic = (username = "admin", value = password) => `Basic ${Buffer.from(`${username}:${value}`, "utf8").toString("base64")}`;

async function fixture(t: test.TestContext, legacy?: "pending" | "configured") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repairman-portal-auth-"));
  const db = openDatabase({ databasePath: path.join(root, "app.db") } as AppConfig);
  const store = new SettingsStore(db, SecretBox.open(path.join(root, "secrets.key")));
  if (legacy) fs.writeFileSync(path.join(root, "portal-setup-token"), "obsolete-test-token", { mode: 0o600 });
  if (legacy === "configured") {
    const salt = crypto.randomBytes(32).toString("base64url");
    const hash = crypto.scryptSync(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }).toString("hex");
    store.setJson("portal.adminCredential", { salt, hash }, { secret: true });
  }
  let now = Date.now();
  const auth = new PortalAuthService(store, root, () => now);
  const app = Fastify();
  registerPortalAuth(app, auth);
  app.get("/health", async () => ({ ok: true }));
  app.get("/", async () => "Portal HTML");
  app.get("/assets/app.js", async () => "JavaScript");
  app.get("/api/private", async () => ({ private: true }));
  app.post("/api/private", async () => ({ changed: true }));
  app.post("/webhooks/:provider/:secret", async (request, reply) => {
    if ((request.params as { secret: string }).secret !== "valid-secret") return reply.code(401).send({ ok: false });
    return reply.code(202).send({ accepted: true });
  });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof z.ZodError ? 400 : error.statusCode || 500).send({ error: error.message }));
  t.after(async () => { await app.close(); db.close(); fs.rmSync(root, { force: true, recursive: true }); });
  const update = (body: unknown, authorization?: string, extra: Record<string, string> = {}) => app.inject({ method: "PUT", url: "/api/portal-auth", headers: { "x-repairman-request": "1", ...(authorization ? { authorization } : {}), ...extra }, payload: body });
  return { app, auth, store, db, root, update, advance: (milliseconds: number) => { now += milliseconds; } };
}

test("default portal opens immediately and unfinished 0.2.0 setup is removed without changing media settings", async (t) => {
  const { app, store, root, update } = await fixture(t, "pending");
  store.setString("sonarr.apiKey", "preserved-test-key", { secret: true });
  assert.equal((await app.inject("/")).statusCode, 200);
  assert.equal((await app.inject("/api/private")).statusCode, 200);
  assert.deepEqual((await app.inject("/api/portal-auth")).json(), { enabled: false, username: "admin", passwordConfigured: false });
  assert.equal(fs.existsSync(path.join(root, "portal-setup-token")), false);
  assert.equal((await app.inject({ method: "POST", url: "/api/private" })).statusCode, 403);
  assert.equal((await update({ enabled: true, username: "admin" })).statusCode, 400);
  assert.equal(store.getString("sonarr.apiKey"), "preserved-test-key");
});

test("the UI toggle enables standard Basic challenges for HTML, assets and all admin APIs, never returning password material", async (t) => {
  const { app, update, db } = await fixture(t);
  const response = await update({ enabled: true, username: "admin", password });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { enabled: true, username: "admin", passwordConfigured: true });
  const row = db.prepare("SELECT value, secret FROM app_settings WHERE key = 'portal.basicAuth'").get() as { value: string; secret: number };
  assert.equal(row.secret, 1);
  assert.doesNotMatch(row.value, /a-test-basic-password|"hash"|"salt"/);
  for (const url of ["/", "/assets/app.js", "/api/private", "/api/portal-auth", "/api/not-real"]) {
    const read = await app.inject(url);
    assert.equal(read.statusCode, 401, url);
    assert.match(String(read.headers["www-authenticate"]), /^Basic realm="Plex Repairman", charset="UTF-8"$/);
    assert.equal(read.headers["cache-control"], "no-store");
  }
  assert.equal((await app.inject({ url: "/api/private", headers: { authorization: basic("other") } })).statusCode, 401);
  const parallel = await Promise.all(Array.from({ length: 8 }, () => app.inject({ url: "/api/private", headers: { authorization: basic() } })));
  assert.equal(parallel.every((result) => result.statusCode === 200), true, "concurrent browser requests share a successful verification");
  assert.equal((await app.inject("/health")).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/webhooks/sonarr/valid-secret", payload: {} })).statusCode, 202);
  assert.equal((await app.inject({ method: "POST", url: "/webhooks/sonarr/wrong", payload: {} })).statusCode, 401);
  assert.equal((await update({ enabled: false, username: "admin" })).statusCode, 401, "disabling requires the active credentials");
  assert.equal((await update({ enabled: false, username: "admin" }, basic(), { "sec-fetch-site": "cross-site" })).statusCode, 403);
});

test("credentials persist across restarts, can be changed or retained, and the toggle can turn protection off again", async (t) => {
  const { app, update, auth, store, root } = await fixture(t);
  await update({ enabled: true, username: "admin", password });
  assert.equal((await app.inject({ url: "/api/private", headers: { authorization: basic() } })).statusCode, 200);
  assert.equal((await update({ enabled: true, username: "new-user", password: "new-test-password" }, basic())).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/private", headers: { authorization: basic() } })).statusCode, 401, "credential changes revoke cached authorizations");
  const changed = basic("new-user", "new-test-password");
  assert.equal((await update({ enabled: false, username: "new-user" }, changed)).statusCode, 200);
  assert.equal((await app.inject("/api/private")).statusCode, 200);
  assert.equal((await update({ enabled: true, username: "new-user", password: "" })).statusCode, 200, "retained password supports re-enabling");
  const restarted = new PortalAuthService(store, root);
  assert.deepEqual(restarted.settings, auth.settings);
  assert.equal(await restarted.authenticate(changed, "restart"), true);
  assert.equal(await restarted.authenticate(undefined, "restart"), false);
});

test("completed 0.2.0 administrator setup migrates without silently removing protection", async (t) => {
  const { app, auth, store, root } = await fixture(t, "configured");
  assert.deepEqual(auth.settings, { enabled: true, username: "admin", passwordConfigured: true });
  assert.equal(store.getString("portal.adminCredential"), undefined);
  assert.equal(fs.existsSync(path.join(root, "portal-setup-token")), false);
  assert.equal((await app.inject("/")).statusCode, 401);
  assert.equal((await app.inject({ url: "/", headers: { authorization: basic() } })).statusCode, 200);
});

test("failed passwords are throttled; invalid headers and credentials are rejected without leaking data", async (t) => {
  const { app, update, advance } = await fixture(t);
  for (const body of [{ enabled: true, username: "invalid:name", password }, { enabled: true, username: "admin", password: "short" }]) assert.equal((await update(body)).statusCode, 400);
  await update({ enabled: true, username: "admin", password });
  for (const authorization of ["Bearer invalid", "Basic !!!", `Basic ${Buffer.from([255, 254, 58, 255]).toString("base64")}`, basic("", password), basic("admin", "test\npassword")]) assert.equal((await app.inject({ url: "/api/private", headers: { authorization } })).statusCode, 401);
  for (let index = 0; index < 10; index += 1) assert.equal((await app.inject({ url: "/api/private", headers: { authorization: basic("admin", "wrong-password") } })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/private", headers: { authorization: basic() } })).statusCode, 429);
  advance(15 * 60 * 1000 + 1);
  assert.equal((await app.inject({ url: "/api/private", headers: { authorization: basic() } })).statusCode, 200);
});

test("concurrent first-time enable requests cannot replace the first credentials", async (t) => {
  const { update, auth } = await fixture(t);
  const responses = await Promise.all([update({ enabled: true, username: "first", password }), update({ enabled: true, username: "second", password: "second-password" })]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
  assert.equal(await auth.authenticate(basic("first"), "check"), true);
  assert.equal(await auth.authenticate(basic("second", "second-password"), "check"), false);
});

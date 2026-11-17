import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from "fastify";
import { z } from "zod";
import type { SettingsStore } from "../storage/settings.js";

const settingsKey = "portal.login";
const cookieName = "repairman_session";
const sessionLifetime = 12 * 60 * 60 * 1000;
const attemptWindow = 15 * 60 * 1000;
const usernameSchema = z.string().trim().min(1).max(128).regex(/^[^:\x00-\x1f\x7f]+$/, "Username cannot contain colons or control characters.");
const passwordSchema = z.string().min(8).max(256).regex(/^[^\x00-\x1f\x7f]+$/, "Password cannot contain control characters.");
const credentialSchema = z.object({ salt: z.string().min(16).max(128), hash: z.string().regex(/^[a-f0-9]{128}$/) });
const savedSchema = z.object({
  enabled: z.boolean(), username: usernameSchema, revision: z.string(),
  salt: credentialSchema.shape.salt.optional(), hash: credentialSchema.shape.hash.optional(),
}).refine((value) => !value.enabled || Boolean(value.salt && value.hash), "Enabled sign-in requires a saved password.");
const updateSchema = z.object({ enabled: z.boolean(), username: usernameSchema, password: z.union([z.literal(""), passwordSchema]).optional(), currentPassword: z.string().max(256).optional() }).strict();
type SavedAuth = z.infer<typeof savedSchema>;
type Session = { revision: string; csrfToken: string; expiresAt: number };
export type PortalAuthSettings = { enabled: boolean; username: string; passwordConfigured: boolean };
export type PortalSession = { enabled: boolean; authenticated: boolean; username?: string; csrfToken?: string };

export class PortalAuthService {
  private readonly attempts = new Map<string, { count: number; expiresAt: number }>();
  private readonly sessions = new Map<string, Session>();
  private hashing = 0;
  private updating = false;

  constructor(private readonly store: SettingsStore, configDir: string, private readonly secureCookie = false, private readonly now = Date.now) {
    // Preserve configured credentials without using the proxy's Authorization header.
    if (!store.getString(settingsKey)) {
      const basic = store.getString("portal.basicAuth");
      const legacy = store.getString("portal.adminCredential");
      const migrated = basic ? savedSchema.parse(JSON.parse(basic)) : legacy
        ? { ...credentialSchema.parse(JSON.parse(legacy)), enabled: true, username: "admin", revision: crypto.randomUUID() } : undefined;
      if (migrated) store.transaction((writer) => {
        writer.setJson(settingsKey, { ...migrated, revision: crypto.randomUUID() }, { secret: true });
        writer.delete("portal.basicAuth");
        writer.delete("portal.adminCredential");
      });
    }
    this.read(); // Invalid persisted credentials fail closed.
    fs.rmSync(path.join(configDir, "portal-setup-token"), { force: true });
  }

  private read(): SavedAuth {
    const value = this.store.getString(settingsKey);
    return value ? savedSchema.parse(JSON.parse(value)) : { enabled: false, username: "admin", revision: "initial" };
  }

  get settings(): PortalAuthSettings {
    const saved = this.read();
    return { enabled: saved.enabled, username: saved.username, passwordConfigured: Boolean(saved.hash && saved.salt) };
  }

  session(request: FastifyRequest): Session | undefined {
    const tokens = request.headers.cookie?.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`)) ?? [];
    const token = tokens.length === 1 ? tokens[0]!.slice(cookieName.length + 1) : "";
    if (!/^[\w-]{43}$/.test(token)) return undefined;
    const key = digest(token);
    const session = this.sessions.get(key);
    const saved = this.read();
    if (session && saved.enabled && session.revision === saved.revision && session.expiresAt > this.now()) return session;
    this.sessions.delete(key);
    return undefined;
  }

  snapshot(request: FastifyRequest): PortalSession {
    const saved = this.read();
    const session = this.session(request);
    return { enabled: saved.enabled, authenticated: Boolean(session), ...(session ? { username: saved.username, csrfToken: session.csrfToken } : {}) };
  }

  private async verify(username: string, password: string, ip: string): Promise<void> {
    for (const [key, value] of this.attempts) if (value.expiresAt <= this.now()) this.attempts.delete(key);
    const attempt = this.attempts.get(ip) ?? { count: 0, expiresAt: this.now() + attemptWindow };
    if (attempt.count >= 10 || (!this.attempts.has(ip) && this.attempts.size >= 1000)) throw authError(429, "Too many sign-in attempts. Try again in 15 minutes.");
    attempt.count += 1;
    this.attempts.set(ip, attempt);
    const saved = this.read();
    const actual = await this.hash(password, saved.salt ?? "unconfigured-portal");
    const validUsername = equal(username, saved.username);
    const validPassword = equal(actual, saved.hash ?? "");
    if (!saved.enabled || !validUsername || !validPassword || this.read().revision !== saved.revision) throw authError(401, "Incorrect username or password.");
    this.attempts.delete(ip);
  }

  private async hash(password: string, salt: string): Promise<string> {
    if (this.hashing >= 2) throw authError(429, "Sign-in is busy. Try again shortly.");
    this.hashing += 1;
    try {
      return await new Promise<string>((resolve, reject) => crypto.scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result.toString("hex"))));
    } finally { this.hashing -= 1; }
  }

  async login(username: string, password: string, ip: string, reply: FastifyReply, request: FastifyRequest): Promise<PortalSession> {
    if (!this.read().enabled) throw authError(409, "Portal sign-in is not enabled.");
    await this.verify(username, password, ip);
    const previous = this.session(request);
    for (const [key, session] of this.sessions) if (session === previous) this.sessions.delete(key);
    return this.signIn(reply);
  }

  private signIn(reply: FastifyReply): PortalSession {
    const saved = this.read();
    for (const [key, value] of this.sessions) if (value.expiresAt <= this.now()) this.sessions.delete(key);
    while (this.sessions.size >= 20) this.sessions.delete(this.sessions.keys().next().value!);
    const token = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    this.sessions.set(digest(token), { revision: saved.revision, csrfToken, expiresAt: this.now() + sessionLifetime });
    this.cookie(reply, token, sessionLifetime / 1000);
    return { enabled: true, authenticated: true, username: saved.username, csrfToken };
  }

  private cookie(reply: FastifyReply, value: string, maxAge: number): void {
    reply.header("Set-Cookie", `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secureCookie ? "; Secure" : ""}`);
  }

  logout(request: FastifyRequest, reply: FastifyReply): void {
    const session = this.session(request);
    for (const [key, value] of this.sessions) if (value === session) this.sessions.delete(key);
    this.cookie(reply, "", 0);
  }

  async update(input: z.infer<typeof updateSchema>, ip: string, reply: FastifyReply): Promise<PortalAuthSettings & { session: PortalSession }> {
    if (this.updating) throw authError(409, "Security settings are being updated. Try again.");
    this.updating = true;
    try {
      const previous = this.read();
      if (previous.enabled) await this.verify(previous.username, input.currentPassword ?? "", ip);
      if (input.enabled && !input.password && !previous.hash) throw authError(400, "Enter a password before enabling sign-in.");
      const credentials = input.password ? { salt: crypto.randomBytes(32).toString("base64url"), hash: "" } : { salt: previous.salt, hash: previous.hash };
      if (input.password) credentials.hash = await this.hash(input.password, credentials.salt!);
      if (this.read().revision !== previous.revision) throw authError(409, "Security settings changed. Reload and try again.");
      this.store.setJson(settingsKey, { ...credentials, enabled: input.enabled, username: input.username, revision: crypto.randomUUID() }, { secret: true });
      this.sessions.clear();
      this.attempts.clear();
      // Keep the person saving signed in; all other sessions are revoked.
      if (input.enabled) return { ...this.settings, session: this.signIn(reply) };
      this.cookie(reply, "", 0);
      return { ...this.settings, session: { enabled: false, authenticated: false } };
    } finally { this.updating = false; }
  }
}

export function registerPortalAuth<Logger extends FastifyBaseLogger>(app: FastifyInstance<RawServerDefault, RawRequestDefaultExpression<RawServerDefault>, RawReplyDefaultExpression<RawServerDefault>, Logger>, auth: PortalAuthService): void {
  const publicApi = new Set(["/api/auth/session", "/api/auth/login"]);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    reply.header("Cache-Control", "no-store");
    const route = request.routeOptions.url ?? "";
    const pathname = request.url.split("?")[0] ?? "";
    if (!(pathname === "/api" || pathname.startsWith("/api/"))) return;
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (mutation && (request.headers["x-repairman-request"] !== "1" || request.headers["sec-fetch-site"] === "cross-site")) return reply.code(403).send({ error: { code: "invalid_request_origin", message: "Use the portal to submit this request." } });
    if (publicApi.has(route)) return;
    if (!auth.settings.enabled) return;
    const session = auth.session(request);
    if (!session) return reply.code(401).send({ error: { code: "authentication_required", message: "Sign in to Plex Repairman to continue." } });
    if (mutation && (typeof request.headers["x-csrf-token"] !== "string" || !equal(request.headers["x-csrf-token"], session.csrfToken))) return reply.code(403).send({ error: { code: "invalid_csrf_token", message: "Reload the portal and try again." } });
  });
  app.get("/api/auth/session", async (request) => auth.snapshot(request));
  app.post("/api/auth/login", { bodyLimit: 4096 }, async (request, reply) => {
    const body = z.object({ username: z.string().min(1).max(128), password: z.string().min(1).max(256) }).strict().parse(request.body);
    return auth.login(body.username, body.password, request.ip, reply, request);
  });
  app.post("/api/auth/logout", async (request, reply) => { auth.logout(request, reply); return { ok: true }; });
  app.get("/api/portal-auth", async () => auth.settings);
  app.put("/api/portal-auth", { bodyLimit: 4096 }, async (request, reply) => auth.update(updateSchema.parse(request.body), request.ip, reply));
}

function digest(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function equal(left: string, right: string): boolean { return crypto.timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right))); }
function authError(statusCode: number, message: string): Error & { statusCode: number } { return Object.assign(new Error(message), { statusCode }); }

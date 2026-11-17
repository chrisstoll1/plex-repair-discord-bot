import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from "fastify";
import { z } from "zod";
import type { SettingsStore } from "../storage/settings.js";

const credentialKey = "portal.adminCredential";
const cookieName = "repairman_session";
const sessionLifetime = 12 * 60 * 60 * 1000;
const attemptWindow = 15 * 60 * 1000;
const passwordSchema = z.string().min(12).max(256);
type Credential = { salt: string; hash: string };
type Session = { csrfToken: string; expiresAt: number };

export class PortalAuthService {
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, { count: number; expiresAt: number }>();
  private hashing = 0;
  private settingUp = false;
  readonly setupTokenPath: string;

  constructor(private readonly store: SettingsStore, configDir: string, readonly secureCookie = false, private readonly now = Date.now) {
    this.setupTokenPath = path.join(configDir, "portal-setup-token");
    if (!this.configured) {
      fs.mkdirSync(configDir, { recursive: true });
      try {
        fs.writeFileSync(this.setupTokenPath, `${crypto.randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } else {
      fs.rmSync(this.setupTokenPath, { force: true });
    }
  }

  get configured(): boolean { return Boolean(this.store.getString(credentialKey)); }

  session(request: FastifyRequest): Session | undefined {
    const token = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!token || !/^[\w-]{43}$/.test(token)) return undefined;
    const key = digest(token);
    const session = this.sessions.get(key);
    if (session && session.expiresAt > this.now() && this.configured) return session;
    this.sessions.delete(key);
    return undefined;
  }

  private checkAttempts(ip: string): void {
    for (const [key, value] of this.attempts) if (value.expiresAt <= this.now()) this.attempts.delete(key);
    const attempt = this.attempts.get(ip) ?? { count: 0, expiresAt: this.now() + attemptWindow };
    if (attempt.count >= 10 || this.hashing >= 2 || (!this.attempts.has(ip) && this.attempts.size >= 1000)) {
      throw authError(429, "Too many sign-in attempts. Try again in 15 minutes.");
    }
    attempt.count += 1;
    this.attempts.set(ip, attempt);
  }

  private async hash(password: string, salt: string): Promise<Buffer> {
    this.hashing += 1;
    try {
      return await new Promise<Buffer>((resolve, reject) => crypto.scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }, (error, value) => error ? reject(error) : resolve(value)));
    } finally { this.hashing -= 1; }
  }

  async setup(token: string, password: string, ip: string): Promise<void> {
    this.checkAttempts(ip);
    if (this.configured || this.settingUp) throw authError(409, "The administrator account is already configured.");
    if (!equal(token, fs.readFileSync(this.setupTokenPath, "utf8").trim())) throw authError(401, "Invalid setup token.");
    this.settingUp = true;
    try {
      const salt = crypto.randomBytes(32).toString("base64url");
      const hash = (await this.hash(password, salt)).toString("hex");
      this.store.setJson(credentialKey, { salt, hash }, { secret: true });
      fs.rmSync(this.setupTokenPath, { force: true });
      this.attempts.delete(ip);
    } finally { this.settingUp = false; }
  }

  async verify(password: string, ip: string): Promise<string> {
    this.checkAttempts(ip);
    const credential = this.store.getJson<Credential | null>(credentialKey, null);
    // Perform the same work when no account exists.
    const actual = await this.hash(password, credential?.salt ?? "unconfigured-portal");
    if (!credential || !equal(actual.toString("hex"), credential.hash) || this.store.getJson<Credential | null>(credentialKey, null)?.hash !== credential.hash) throw authError(401, "Incorrect administrator password.");
    this.attempts.delete(ip);
    return credential.hash;
  }

  async changePassword(currentPassword: string, newPassword: string, ip: string): Promise<void> {
    const previousHash = await this.verify(currentPassword, ip);
    const salt = crypto.randomBytes(32).toString("base64url");
    const hash = (await this.hash(newPassword, salt)).toString("hex");
    if (this.store.getJson<Credential | null>(credentialKey, null)?.hash !== previousHash) throw authError(409, "The administrator password changed. Sign in again.");
    this.store.setJson(credentialKey, { salt, hash }, { secret: true });
    this.sessions.clear();
  }

  signIn(reply: FastifyReply): { authenticated: true; setupRequired: false; csrfToken: string } {
    for (const [key, value] of this.sessions) if (value.expiresAt <= this.now()) this.sessions.delete(key);
    while (this.sessions.size >= 20) this.sessions.delete(this.sessions.keys().next().value!);
    const token = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    this.sessions.set(digest(token), { csrfToken, expiresAt: this.now() + sessionLifetime });
    reply.header("Set-Cookie", `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetime / 1000}${this.secureCookie ? "; Secure" : ""}`);
    return { authenticated: true, setupRequired: false, csrfToken };
  }

  signOut(request: FastifyRequest, reply: FastifyReply): void {
    const session = this.session(request);
    for (const [key, value] of this.sessions) if (value === session) this.sessions.delete(key);
    reply.header("Set-Cookie", `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.secureCookie ? "; Secure" : ""}`);
  }
}

export function registerPortalAuth<Logger extends FastifyBaseLogger>(app: FastifyInstance<RawServerDefault, RawRequestDefaultExpression<RawServerDefault>, RawReplyDefaultExpression<RawServerDefault>, Logger>, auth: PortalAuthService): void {
  const publicApi = new Set(["/api/auth/session", "/api/auth/setup", "/api/auth/login"]);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const route = request.routeOptions.url ?? request.url.split("?")[0] ?? "";
    if (route !== "/api" && !route.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    // Custom headers require a CORS preflight; this server never grants cross-origin access.
    if (mutation && (request.headers["x-repairman-request"] !== "1" || request.headers["sec-fetch-site"] === "cross-site")) {
      return reply.code(403).send({ error: { code: "invalid_request_origin", message: "Use the portal to submit this request." } });
    }
    if (publicApi.has(route)) return;
    const session = auth.session(request);
    if (!session) return reply.code(401).send({ error: { code: "authentication_required", message: "Sign in to the administration portal." } });
    if (mutation && (typeof request.headers["x-csrf-token"] !== "string" || !equal(request.headers["x-csrf-token"], session.csrfToken))) {
      return reply.code(403).send({ error: { code: "invalid_csrf_token", message: "Reload the portal and try again." } });
    }
  });

  app.get("/api/auth/session", async (request) => {
    const session = auth.session(request);
    return { authenticated: Boolean(session), setupRequired: !auth.configured, ...(session ? { csrfToken: session.csrfToken } : {}) };
  });
  app.post("/api/auth/setup", { bodyLimit: 4096 }, async (request, reply) => {
    const body = z.object({ token: z.string().min(1).max(128), password: passwordSchema }).strict().parse(request.body);
    await auth.setup(body.token, body.password, request.ip);
    return auth.signIn(reply);
  });
  app.post("/api/auth/login", { bodyLimit: 4096 }, async (request, reply) => {
    const body = z.object({ password: z.string().min(1).max(256) }).strict().parse(request.body);
    await auth.verify(body.password, request.ip);
    return auth.signIn(reply);
  });
  app.post("/api/auth/logout", async (request, reply) => {
    auth.signOut(request, reply);
    return { ok: true };
  });
  app.post("/api/auth/password", { bodyLimit: 4096 }, async (request, reply) => {
    const body = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema }).strict().parse(request.body);
    await auth.changePassword(body.currentPassword, body.newPassword, request.ip);
    return auth.signIn(reply);
  });
}

function digest(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function equal(left: string, right: string): boolean { return crypto.timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right))); }
function authError(statusCode: number, message: string): Error & { statusCode: number } { return Object.assign(new Error(message), { statusCode }); }

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger, FastifyInstance, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from "fastify";
import { z } from "zod";
import type { SettingsStore } from "../storage/settings.js";

const settingsKey = "portal.basicAuth";
const legacyKey = "portal.adminCredential";
const attemptWindow = 15 * 60 * 1000;
const usernameSchema = z.string().trim().min(1).max(128).regex(/^[^:\x00-\x1f\x7f]+$/, "Username cannot contain colons or control characters.");
const passwordSchema = z.string().min(8).max(256).regex(/^[^\x00-\x1f\x7f]+$/, "Password cannot contain control characters.");
const credentialSchema = z.object({ salt: z.string().min(16).max(128), hash: z.string().regex(/^[a-f0-9]{128}$/) });
const savedSchema = z.object({
  enabled: z.boolean(), username: usernameSchema, revision: z.string(),
  salt: credentialSchema.shape.salt.optional(), hash: credentialSchema.shape.hash.optional(),
}).refine((value) => !value.enabled || Boolean(value.salt && value.hash), "Enabled Basic auth requires a saved password.");
const updateSchema = z.object({ enabled: z.boolean(), username: usernameSchema, password: z.union([z.literal(""), passwordSchema]).optional() }).strict();
type SavedAuth = z.infer<typeof savedSchema>;
export type PortalAuthSettings = { enabled: boolean; username: string; passwordConfigured: boolean };

export class PortalAuthService {
  private readonly attempts = new Map<string, { count: number; expiresAt: number }>();
  private readonly verified = new Map<string, { revision: string; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<boolean>>();
  private readonly cacheKey = crypto.randomBytes(32);
  private hashing = 0;
  private updating = false;

  constructor(private readonly store: SettingsStore, configDir: string, private readonly now = Date.now) {
    // Preserve protection for an administrator who completed 0.2.0 setup.
    // An unfinished setup becomes the default, unauthenticated portal.
    if (!store.getString(settingsKey) && store.getString(legacyKey)) {
      const legacy = credentialSchema.parse(store.getJson(legacyKey, null));
      store.transaction((writer) => {
        writer.setJson(settingsKey, { ...legacy, enabled: true, username: "admin", revision: crypto.randomUUID() }, { secret: true });
        writer.delete(legacyKey);
      });
    }
    this.read(); // Invalid saved authentication fails closed.
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

  private checkAttempts(ip: string): void {
    for (const [key, value] of this.attempts) if (value.expiresAt <= this.now()) this.attempts.delete(key);
    const attempt = this.attempts.get(ip) ?? { count: 0, expiresAt: this.now() + attemptWindow };
    if (attempt.count >= 10 || this.hashing >= 2 || (!this.attempts.has(ip) && this.attempts.size >= 1000)) {
      throw authError(429, "Too many sign-in attempts. Try again in 15 minutes.");
    }
    attempt.count += 1;
    this.attempts.set(ip, attempt);
  }

  private async hash(password: string, salt: string): Promise<string> {
    if (this.hashing >= 2) throw authError(429, "Authentication is busy. Try again shortly.");
    this.hashing += 1;
    try {
      const value = await new Promise<Buffer>((resolve, reject) => crypto.scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
      return value.toString("hex");
    } finally { this.hashing -= 1; }
  }

  async authenticate(authorization: string | undefined, ip: string): Promise<boolean> {
    const saved = this.read();
    if (!saved.enabled) return true;
    const credentials = parseBasic(authorization);
    if (!credentials) return false;
    const key = crypto.createHmac("sha256", this.cacheKey).update(authorization!).digest("hex");
    const cached = this.verified.get(key);
    if (cached?.revision === saved.revision && cached.expiresAt > this.now()) return true;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const operation = (async () => {
      this.checkAttempts(ip);
      const hash = await this.hash(credentials.password, saved.salt!);
      const valid = equal(credentials.username, saved.username) && equal(hash, saved.hash!) && this.read().revision === saved.revision;
      if (valid) {
        this.attempts.delete(ip);
        for (const [key, entry] of this.verified) if (entry.expiresAt <= this.now()) this.verified.delete(key);
        while (this.verified.size >= 256) this.verified.delete(this.verified.keys().next().value!);
        this.verified.set(key, { revision: saved.revision, expiresAt: this.now() + 5 * 60 * 1000 });
      }
      return valid;
    })();
    this.pending.set(key, operation);
    try { return await operation; } finally { this.pending.delete(key); }
  }

  async update(input: z.infer<typeof updateSchema>): Promise<PortalAuthSettings> {
    if (this.updating) throw authError(409, "Portal access settings are being updated. Try again.");
    this.updating = true;
    try {
      const previous = this.read();
      if (input.enabled && !input.password && !previous.hash) throw authError(400, "Enter a password before enabling Basic authentication.");
      const credentials = input.password ? { salt: crypto.randomBytes(32).toString("base64url"), hash: "" } : { salt: previous.salt, hash: previous.hash };
      if (input.password) credentials.hash = await this.hash(input.password, credentials.salt!);
      if (this.read().revision !== previous.revision) throw authError(409, "Portal access settings changed. Reload and try again.");
      this.store.setJson(settingsKey, { ...credentials, enabled: input.enabled, username: input.username, revision: crypto.randomUUID() }, { secret: true });
      this.verified.clear();
      this.attempts.clear();
      return this.settings;
    } finally { this.updating = false; }
  }
}

export function registerPortalAuth<Logger extends FastifyBaseLogger>(app: FastifyInstance<RawServerDefault, RawRequestDefaultExpression<RawServerDefault>, RawReplyDefaultExpression<RawServerDefault>, Logger>, auth: PortalAuthService): void {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const route = request.routeOptions.url ?? "";
    const pathname = request.url.split("?")[0] ?? "";
    const isApi = route.startsWith("/api/") || pathname === "/api" || pathname.startsWith("/api/");
    // Health checks and secret-authenticated Arr webhooks work independently.
    if ((route === "/health" && ["GET", "HEAD"].includes(request.method)) || (route === "/webhooks/:provider/:secret" && request.method === "POST")) return;
    // Responses must not remain accessible in caches after a toggle change.
    reply.header("Cache-Control", "no-store");
    if (!(await auth.authenticate(request.headers.authorization, request.ip))) {
      return reply.header("WWW-Authenticate", 'Basic realm="Plex Repairman", charset="UTF-8"').code(401).send({ error: { code: "authentication_required", message: "HTTP Basic authentication is required." } });
    }
    if (isApi && !["GET", "HEAD", "OPTIONS"].includes(request.method) && (request.headers["x-repairman-request"] !== "1" || request.headers["sec-fetch-site"] === "cross-site")) {
      return reply.code(403).send({ error: { code: "invalid_request_origin", message: "Use the portal to submit this request." } });
    }
  });
  app.get("/api/portal-auth", async () => auth.settings);
  app.put("/api/portal-auth", { bodyLimit: 4096 }, async (request) => auth.update(updateSchema.parse(request.body)));
}

function parseBasic(value: string | undefined): { username: string; password: string } | undefined {
  if (!value || value.length > 4096) return undefined;
  const encoded = /^Basic +([a-z0-9+/]+={0,2})$/i.exec(value)?.[1];
  if (!encoded || encoded.length % 4 === 1) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64"));
    const colon = text.indexOf(":");
    if (colon < 1 || /[\x00-\x1f\x7f]/.test(text)) return undefined;
    const username = text.slice(0, colon);
    const password = text.slice(colon + 1);
    return username.length <= 128 && password.length <= 256 ? { username, password } : undefined;
  } catch { return undefined; }
}
function equal(left: string, right: string): boolean {
  return crypto.timingSafeEqual(crypto.createHash("sha256").update(left).digest(), crypto.createHash("sha256").update(right).digest());
}
function authError(statusCode: number, message: string): Error & { statusCode: number } { return Object.assign(new Error(message), { statusCode }); }

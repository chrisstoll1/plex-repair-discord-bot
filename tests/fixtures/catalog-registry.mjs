import crypto from "node:crypto";
import fs from "node:fs";

const scenario = process.env.REPAIRMAN_REGISTRY_SCENARIO;
const version = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const hash = (value) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
const config = JSON.stringify({ os: "linux", architecture: "amd64", config: { User: scenario === "root" ? "0:0" : "node", Labels: { "org.opencontainers.image.version": scenario === "wrong-version" ? "0.0.0" : version, "org.opencontainers.image.revision": "a".repeat(40) } } });
const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: hash(config) } });
const index = JSON.stringify({ schemaVersion: 2, manifests: [{ digest: hash(manifest), platform: { os: "linux", architecture: scenario === "wrong-platform" ? "arm64" : "amd64" } }] });
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname === "/token") return new Response(JSON.stringify({ token: "synthetic-registry-token" }), { status: scenario === "private" ? 401 : 200 });
  if (url.pathname.endsWith(`/manifests/${version}`)) return new Response(index, { status: scenario === "missing" ? 404 : 200, headers: { "docker-content-digest": scenario === "corrupt-digest" ? "sha256:invalid" : hash(index) } });
  if (url.pathname.endsWith(`/manifests/${hash(manifest)}`)) return new Response(manifest);
  if (url.pathname.endsWith(`/blobs/${hash(config)}`)) return new Response(config);
  throw new Error("Unexpected registry fixture request.");
};

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const repository = "chrisstoll1/plex-repair-discord-bot";
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Catalog submissions require a stable semantic release version.");
const outputIndex = process.argv.indexOf("--output");
if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error("Usage: node scripts/prepare-truenas-release.mjs --output <new-directory>");
const output = path.resolve(process.argv[outputIndex + 1]);
if (fs.existsSync(output)) throw new Error("Choose a new output directory; existing files will not be overwritten.");
const source = path.join(root, "packaging/truenas/ix-dev/community/plex-repairman");
const sourceValues = fs.readFileSync(path.join(source, "ix_values.yaml"), "utf8");
const versionPattern = new RegExp(`tag: ['\"]?${version.replaceAll(".", "\\.")}(?:['\"]?\\s|$)`);
if (!versionPattern.test(sourceValues)) throw new Error("The source catalog image version is out of date.");

const authorization = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`, { signal: AbortSignal.timeout(20_000) });
if (!authorization.ok) throw new Error("The container package is not accessible anonymously. Set the GitHub container package visibility to Public before preparing a catalog submission.");
const { token } = await authorization.json();
const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" };
async function registry(kind, reference) {
  const response = await fetch(`https://ghcr.io/v2/${repository}/${kind}/${reference}`, { headers, signal: AbortSignal.timeout(20_000) });
  if (response.status === 404) throw new Error(`Stable image ${version} has not been published. Complete the release workflow before preparing a catalog submission.`);
  if (!response.ok) throw new Error(`Cannot verify the stable image (registry status ${response.status}).`);
  const body = await response.text();
  if (reference.startsWith("sha256:") && `sha256:${crypto.createHash("sha256").update(body).digest("hex")}` !== reference) throw new Error("Registry image content digest verification failed.");
  return { response, body, json: JSON.parse(body) };
}
const published = await registry("manifests", version);
const digest = `sha256:${crypto.createHash("sha256").update(published.body).digest("hex")}`;
if (published.response.headers.get("docker-content-digest") !== digest) throw new Error("Registry manifest digest verification failed.");
let manifest = published.json;
if (manifest.manifests) {
  const platform = manifest.manifests.find((entry) => entry.platform?.os === "linux" && entry.platform?.architecture === "amd64");
  if (!platform) throw new Error("The release has no linux/amd64 image for TrueNAS.");
  manifest = (await registry("manifests", platform.digest)).json;
}
const config = (await registry("blobs", manifest.config.digest)).json;
if (config.os !== "linux" || config.architecture !== "amd64") throw new Error("The release image must support linux/amd64.");
if (config.config?.Labels?.["org.opencontainers.image.version"] !== version) throw new Error("The published image version label does not match the catalog release.");
if (!config.config?.User || ["root", "0", "0:0"].includes(config.config.User)) throw new Error("The published image must default to a non-root user.");
const revision = config.config.Labels["org.opencontainers.image.revision"];
if (!/^[a-f0-9]{40}$/.test(revision || "")) throw new Error("The published image must identify its source commit.");

const destination = path.join(output, "ix-dev/community/plex-repairman");
fs.cpSync(source, destination, { recursive: true, filter: (name) => !["library", "rendered"].includes(path.basename(name)) });
const valuesPath = path.join(destination, "ix_values.yaml");
fs.writeFileSync(valuesPath, sourceValues.replace(new RegExp(`tag: ['\"]?${version.replaceAll(".", "\\.")}['\"]?`), `tag: "${version}@${digest}"`));
const assets = path.join(root, "packaging/truenas/assets");
if (fs.existsSync(assets)) fs.cpSync(assets, path.join(output, "assets"), { recursive: true });
fs.writeFileSync(path.join(output, "release.json"), JSON.stringify({ version, image: `ghcr.io/${repository}:${version}@${digest}`, revision }, null, 2) + "\n");
console.log(`Prepared version ${version}, source ${revision}, digest ${digest}, in ${output}.`);

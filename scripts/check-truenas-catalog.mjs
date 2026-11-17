import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packaging/truenas/ix-dev/community/plex-repairman");
const toolchain = JSON.parse(fs.readFileSync(path.join(root, "packaging/truenas/toolchain.json"), "utf8"));
const args = process.argv.slice(2);
const image = args.includes("--image") ? args[args.indexOf("--image") + 1] : undefined;
if (args.includes("--image") && !image) throw new Error("--image needs a locally built image name.");
const write = args.includes("--write");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "repairman-catalog-"));
const upstream = path.join(temp, "apps");
const prefix = `repairman-catalog-${crypto.randomBytes(5).toString("hex")}`;
const volume = `${prefix}-workspace`;
const runner = `${prefix}-tools`;
const appPath = "/workspace/ix-dev/community/plex-repairman";
const fixturesPath = path.join(root, "packaging/truenas/fixtures");
const fixtures = fs.existsSync(fixturesPath) ? fs.readdirSync(fixturesPath).filter((name) => name.endsWith(".yaml")) : [];
const testCases = fs.readdirSync(path.join(source, "templates/test_values")).filter((name) => name.endsWith(".yaml"));
for (const name of fixtures) {
  assert.ok(!testCases.includes(name), `Duplicate catalog fixture ${name}.`);
  testCases.push(name);
}
const exec = (command, values) => execFileSync(command, values, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 180_000 }).trim();
const docker = (...values) => exec("docker", values);
let createdVolume = false;
let createdRunner = false;

try {
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  assert.match(fs.readFileSync(path.join(source, "app.yaml"), "utf8"), new RegExp(`app_version: ['\"]?${version.replaceAll(".", "\\.")}`));
  exec("git", ["clone", "--quiet", "--depth", "1", "--filter=blob:none", "--no-checkout", toolchain.repository, upstream]);
  exec("git", ["-C", upstream, "sparse-checkout", "set", ".github", "library", "ix-dev"]);
  exec("git", ["-C", upstream, "fetch", "--quiet", "--depth", "1", "origin", toolchain.commit]);
  exec("git", ["-C", upstream, "checkout", "--quiet", "--detach", toolchain.commit]);
  docker("volume", "create", volume); createdVolume = true;
  docker("run", "-d", "--name", runner, "--env", "FAKE_ENV=1", "--env", `CATALOG_VOLUME=${volume}`, "--volume", `${volume}:/workspace`, "--volume", "/var/run/docker.sock:/var/run/docker.sock:ro", "--workdir", "/workspace", "--entrypoint", "sleep", toolchain.validationImage, "infinity"); createdRunner = true;
  for (const name of [".github", ".gitignore", "ix-dev", "library"]) docker("cp", path.join(upstream, name), `${runner}:/workspace/${name}`);
  docker("cp", source, `${runner}:/workspace/ix-dev/community/plex-repairman`);
  // Supplemental storage scenarios stay in our validation suite, outside the upstream app definition.
  for (const name of fixtures) docker("cp", path.join(fixturesPath, name), `${runner}:${appPath}/templates/test_values/${name}`);
  docker("cp", path.join(root, "scripts/truenas-catalog.py"), `${runner}:/workspace/check-catalog.py`);
  console.log(docker("exec", runner, "python3", "/workspace/.github/scripts/port_validation.py"));
  docker("exec", runner, "apps_catalog_hash_generate", "--path", "/workspace", "--train", "community", "--app", "plex-repairman");
  console.log(docker("exec", runner, "python3", "/workspace/check-catalog.py"));
  for (const name of ["app.yaml", "item.yaml", "README.md"]) {
    const generated = path.join(temp, name);
    docker("cp", `${runner}:${appPath}/${name}`, generated);
    if (write) fs.copyFileSync(generated, path.join(source, name));
    else assert.equal(fs.readFileSync(path.join(source, name), "utf8").replaceAll("\r\n", "\n"), fs.readFileSync(generated, "utf8").replaceAll("\r\n", "\n"), `${name} is out of date. Run this script with --write.`);
  }

  if (image) {
    for (const testCase of testCases) {
      const name = path.basename(testCase, ".yaml");
      const rendered = path.join(temp, `${name}.json`);
      docker("cp", `${runner}:/workspace/check-results/${name}.json`, rendered);
      const compose = JSON.parse(fs.readFileSync(rendered, "utf8"));
      const app = compose.services["plex-repairman"];
      app.image = image;
      app.pull_policy = "never";
      const configPath = `/opt/tests/${prefix}/${name}`;
      for (const service of Object.values(compose.services)) {
        for (const mount of service.volumes ?? []) if (mount.type === "bind" && mount.source.startsWith("/opt/tests/")) mount.source = configPath;
      }
      for (const port of app.ports) { port.published = 0; port.host_ip = "127.0.0.1"; }
      fs.writeFileSync(rendered, JSON.stringify(compose, null, 2));
      const project = `${prefix}-${name}`;
      const composeArgs = ["compose", "-p", project, "-f", rendered];
      try {
        if (name === "host-path-values") {
          // Host datasets are supplied by the administrator with existing permissions.
          // Initialize only this run's empty, uniquely named fixture directory.
          docker("run", "--rm", "--user", "0:0", "--volume", `${configPath}:/prepare`, "--entrypoint", "chown", image, app.user, "/prepare");
        }
        docker(...composeArgs, "up", "-d", "--wait", "--wait-timeout", "90");
        const id = docker(...composeArgs, "ps", "-q", "plex-repairman");
        const exposed = JSON.parse(docker("inspect", "--format", "{{json .NetworkSettings.Ports}}", id));
        const port = exposed[`${app.environment.HTTP_PORT}/tcp`][0].HostPort;
        const response = await fetch(`http://127.0.0.1:${port}/api/portal-auth`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { enabled: false, username: "admin", passwordConfigured: false });
        assert.equal(docker(...composeArgs, "exec", "-T", "plex-repairman", "id", "-u"), app.user.split(":")[0]);
        console.log(`Passed catalog installation: ${name}, user ${app.user}, target port ${app.environment.HTTP_PORT}.`);
      } catch (error) {
        try { console.error(docker(...composeArgs, "logs", "--no-color", "--tail", "30", "plex-repairman")); } catch { /* no container yet */ }
        throw error;
      } finally {
        docker(...composeArgs, "down", "--volumes", "--remove-orphans");
        // This uniquely named directory contains only this run's synthetic configuration.
        docker("run", "--rm", "--user", "0:0", "--mount", `type=bind,source=${configPath},target=/cleanup`, "--entrypoint", "node", image, "--input-type=module", "-e", "import fs from 'node:fs'; for (const name of fs.readdirSync('/cleanup')) fs.rmSync('/cleanup/' + name, { recursive: true, force: true });");
      }
    }
  }
  console.log("TrueNAS catalog validation passed.");
} catch (error) {
  // Docker tooling output contains only this run's synthetic fixtures.
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  if (createdRunner) { try { docker("rm", "-f", runner); } catch { /* best effort */ } }
  if (createdVolume) { try { docker("volume", "rm", volume); } catch { /* best effort */ } }
  if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith("repairman-catalog-")) throw new Error("Unexpected temporary catalog path.");
  fs.rmSync(temp, { recursive: true, force: true });
}

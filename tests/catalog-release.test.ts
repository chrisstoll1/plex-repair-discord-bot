import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("catalog export requires a public, published, correctly versioned non-root amd64 image and pins its digest", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repairman-release-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const run = (scenario: string, output: string) => spawnSync(process.execPath, ["--import", pathToFileURL(path.resolve("tests/fixtures/catalog-registry.mjs")).href, "scripts/prepare-truenas-release.mjs", "--output", output], { encoding: "utf8", env: { ...process.env, REPAIRMAN_REGISTRY_SCENARIO: scenario } });
  for (const scenario of ["private", "missing", "root", "wrong-version", "wrong-platform", "corrupt-digest"]) {
    const output = path.join(root, scenario);
    const result = run(scenario, output);
    assert.notEqual(result.status, 0, scenario);
    assert.equal(fs.existsSync(output), false, `${scenario} must fail before creating submission files`);
  }
  const output = path.join(root, "valid");
  const result = run("success", output);
  assert.equal(result.status, 0, result.stderr);
  const release = JSON.parse(fs.readFileSync(path.join(output, "release.json"), "utf8"));
  assert.equal(release.revision, "a".repeat(40));
  const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version as string;
  const versionExpression = version.replaceAll(".", "\\.");
  assert.match(release.image, new RegExp(`:${versionExpression}@sha256:[a-f0-9]{64}$`));
  const app = path.join(output, "ix-dev/community/plex-repairman");
  assert.ok(fs.existsSync(path.join(app, "item.yaml")));
  assert.match(fs.readFileSync(path.join(app, "ix_values.yaml"), "utf8"), new RegExp(`tag: "${versionExpression}@sha256:[a-f0-9]{64}"`));
  assert.equal(fs.existsSync(path.join(app, "templates/library")), false);
  assert.equal(fs.existsSync(path.join(app, "templates/rendered")), false);
  fs.writeFileSync(path.join(output, "keep.txt"), "preserved");
  assert.notEqual(run("success", output).status, 0, "existing destinations are not overwritten");
  assert.equal(fs.readFileSync(path.join(output, "keep.txt"), "utf8"), "preserved");
});

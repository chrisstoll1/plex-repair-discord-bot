import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error This build helper is executed as JavaScript by npm.
import { temporarilyAccepted } from "../scripts/audit-frontend.mjs";

test("the audit exception is limited to the exact advisory, development dependencies and its expiry", () => {
  const report = { vulnerabilities: {
    picomatch: { via: [{ url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf" }], nodes: ["node_modules/picomatch"] },
    vite: { via: ["picomatch"], nodes: ["node_modules/vite"] },
  } };
  const lock = { packages: { "node_modules/picomatch": { dev: true }, "node_modules/vite": { dev: true } } };
  const now = Date.parse("2026-11-17T00:00:00Z");
  assert.equal(temporarilyAccepted(report, lock, now), true);
  assert.equal(temporarilyAccepted(report, lock, Date.parse("2026-12-01T00:00:00Z")), false);
  assert.equal(temporarilyAccepted(report, { packages: { ...lock.packages, "node_modules/picomatch": { dev: false } } }, now), false);
  assert.equal(temporarilyAccepted(report, { packages: {} }, now), false);
  const additional = structuredClone(report);
  additional.vulnerabilities.picomatch.via.push({ url: "https://github.com/advisories/unrelated-advisory" });
  assert.equal(temporarilyAccepted(additional, lock, now), false);
  assert.equal(temporarilyAccepted({ vulnerabilities: { vite: { via: ["missing"], nodes: ["node_modules/vite"] } } }, lock, now), false);
  assert.equal(temporarilyAccepted({ vulnerabilities: { ...report.vulnerabilities, vite: { via: ["picomatch", "missing"], nodes: ["node_modules/vite"] } } }, lock, now), false);
});

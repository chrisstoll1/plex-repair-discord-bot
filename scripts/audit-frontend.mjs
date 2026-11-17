import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const advisory = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
const expires = "2026-12-01T00:00:00Z";

export function temporarilyAccepted(report, lock, now = Date.now()) {
  if (now >= Date.parse(expires)) return false;
  const vulnerabilities = report.vulnerabilities ?? {};
  function leaves(name, seen = new Set()) {
    if (seen.has(name) || !vulnerabilities[name]) return [{ url: "unresolved-advisory" }];
    const next = new Set(seen).add(name);
    return vulnerabilities[name].via.flatMap((entry) => typeof entry === "string" ? leaves(entry, next) : [entry]);
  }
  const entries = Object.entries(vulnerabilities);
  return entries.length > 0 && entries.every(([name, value]) => {
    const causes = leaves(name);
    return value.nodes.length > 0 && value.nodes.every((node) => lock.packages?.[node]?.dev === true)
      && causes.length > 0 && causes.every((cause) => cause.url === advisory);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.npm_execpath) throw new Error("Run this check with npm run audit:frontend.");
  const result = spawnSync(process.execPath, [process.env.npm_execpath, "--prefix", "frontend", "audit", "--json"], { encoding: "utf8" });
  if (result.error || ![0, 1].includes(result.status)) throw new Error("Frontend dependency audit could not complete.");
  const report = JSON.parse(result.stdout);
  if (report.error || !report.metadata?.vulnerabilities) throw new Error("Frontend dependency audit returned an invalid report.");
  if (report.metadata.vulnerabilities.total === 0) console.log("Frontend dependency audit: zero vulnerabilities.");
  else if (temporarilyAccepted(report, JSON.parse(fs.readFileSync("frontend/package-lock.json", "utf8")))) {
    // No patched picomatch release exists. These build-tool globs come only from
    // repository-controlled configuration, and this dependency is not shipped.
    console.log(`Frontend audit: accepted dev-only ${advisory} until ${expires}. No production findings.`);
  } else {
    console.error("Frontend audit has findings outside the temporary dev-only exception:", Object.keys(report.vulnerabilities));
    process.exitCode = 1;
  }
}

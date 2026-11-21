import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildHomePage, buildSidebar, rewriteLinksForWiki, syncWikiDirectory } from "../scripts/sync-wiki.mjs";

test("rewriteLinksForWiki converts docs links to wiki slugs and parent links to GitHub URLs", () => {
  const input = [
    "[Setup](setup.md)",
    "[Ops](operations.md#backups-upgrades-and-rollback)",
    "[Security](../SECURITY.md)",
    "[Catalog](../packaging/truenas/)",
    "[External](https://example.com)",
    "[Local](#section)",
  ].join("\n");

  const output = rewriteLinksForWiki(input);
  assert.match(output, /\[Setup\]\(Setup\)/);
  assert.match(output, /\[Ops\]\(Operations#backups-upgrades-and-rollback\)/);
  assert.match(output, /\[Security\]\(https:\/\/github\.com\/chrisstoll1\/plex-repair-discord-bot\/blob\/master\/SECURITY\.md\)/);
  assert.match(output, /\[Catalog\]\(https:\/\/github\.com\/chrisstoll1\/plex-repair-discord-bot\/tree\/master\/packaging\/truenas\/\)/);
  assert.match(output, /\[External\]\(https:\/\/example\.com\)/);
  assert.match(output, /\[Local\]\(#section\)/);
});

test("syncWikiDirectory generates wiki pages, sidebar, home, and removes stale pages", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "repairman-wiki-"));
  try {
    fs.writeFileSync(path.join(outDir, "Obsolete.md"), "old", "utf8");
    syncWikiDirectory(path.resolve("docs"), outDir);

    const files = fs.readdirSync(outDir).sort();
    assert.deepEqual(files, [
      "AI-Providers.md",
      "Development.md",
      "Home.md",
      "Operations.md",
      "Repairs-and-Safety.md",
      "Setup.md",
      "_Sidebar.md",
    ]);

    assert.equal(fs.readFileSync(path.join(outDir, "Home.md"), "utf8"), buildHomePage());
    assert.equal(fs.readFileSync(path.join(outDir, "_Sidebar.md"), "utf8"), buildSidebar());

    const setup = fs.readFileSync(path.join(outDir, "Setup.md"), "utf8");
    assert.match(setup, /\]\(AI-Providers\)/);
    assert.doesNotMatch(setup, /\]\(ai-providers\.md\)/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("relative markdown links in README.md and docs/ resolve to existing files", () => {
  const root = path.resolve(".");
  const docsFiles = fs.readdirSync(path.join(root, "docs")).filter((name) => name.endsWith(".md")).map((name) => path.join(root, "docs", name));
  const files = [path.join(root, "README.md"), ...docsFiles];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const match of content.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1]!;
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
      const relPath = target.split("#")[0]!;
      const resolved = path.resolve(path.dirname(file), relPath);
      assert.ok(fs.existsSync(resolved), `Broken link ${target} in ${path.relative(root, file)}`);
    }
  }
});

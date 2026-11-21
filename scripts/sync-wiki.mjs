import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_URL = "https://github.com/chrisstoll1/plex-repair-discord-bot";
const RAW_DOCS_URL = "https://raw.githubusercontent.com/chrisstoll1/plex-repair-discord-bot/master/docs";

const PAGES = [
  { source: "setup.md", slug: "Setup", title: "Setup Guide", summary: "Discord bot setup, Plex/Sonarr/Radarr/Seerr connections, Seerr user mappings, and Arr webhooks." },
  { source: "ai-providers.md", slug: "AI-Providers", title: "AI Providers & Models", summary: "OAuth, API keys, custom endpoints, ordered fallback hierarchy, connectivity testing, thinking level, and timeouts." },
  { source: "repairs-and-safety.md", slug: "Repairs-and-Safety", title: "Repairs, Safety & Policies", summary: "Policy toggles, Plex scanner diagnostics, Split Apart / Fix Match, manual imports, Seerr requests, and thread lifecycle." },
  { source: "operations.md", slug: "Operations", title: "Operations & Troubleshooting", summary: "Environment variables, /config files, portal sign-in, reverse proxies, backups, upgrades, password recovery, and troubleshooting." },
  { source: "development.md", slug: "Development", title: "Development & CI", summary: "Local Node 24 + Vite workflow, validation suite, repository layout, weekly Pi SDK updates, and Wiki sync." },
];

const SLUG_BY_SOURCE = new Map(PAGES.map((page) => [page.source, page.slug]));

export function rewriteLinksForWiki(markdown) {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (match, target) => {
    if (/^(?:https?:|mailto:|#)/i.test(target)) return match;
    const hashIndex = target.indexOf("#");
    const rawPath = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
    const anchor = hashIndex >= 0 ? target.slice(hashIndex) : "";
    const normalized = rawPath.replace(/^\.\//, "");
    const wikiSlug = SLUG_BY_SOURCE.get(normalized);
    if (wikiSlug) return `](${wikiSlug}${anchor})`;
    if (normalized.startsWith("images/")) {
      return `](${RAW_DOCS_URL}/${normalized})`;
    }
    if (rawPath.startsWith("../")) {
      const repoPath = rawPath.replace(/^\.\.\//, "");
      const kind = repoPath.endsWith("/") ? "tree" : "blob";
      return `](${REPO_URL}/${kind}/master/${repoPath}${anchor})`;
    }
    return match;
  });
}

export function buildHomePage() {
  const rows = PAGES.map((page) => `| [${page.title}](${page.slug}) | ${page.summary} |`).join("\n");
  return `# Plex Repairman Wiki

Plex Repairman is a self-hosted Discord bot and web portal for diagnosing and repairing Plex, Sonarr, Radarr, and Seerr media issues.

> This wiki is automatically synced from [\`docs/\`](${REPO_URL}/tree/master/docs) on \`master\`. Please make edits via pull requests to the main repository.

![Plex Repairman Overview](${RAW_DOCS_URL}/images/overview.png)

## Guides

| Guide | Topics |
| --- | --- |
${rows}

## Repository Links

- [README & Quick Start](${REPO_URL}/blob/master/README.md)
- [Changelog](${REPO_URL}/blob/master/CHANGELOG.md)
- [Security Policy](${REPO_URL}/blob/master/SECURITY.md)
- [TrueNAS Catalog Package](${REPO_URL}/blob/master/packaging/truenas/README.md)
- [Releases](${REPO_URL}/releases)
`;
}

export function buildSidebar() {
  const links = PAGES.map((page) => `- [${page.title}](${page.slug})`).join("\n");
  return `### Documentation

- [Home](Home)
${links}

### Project

- [README & Quick Start](${REPO_URL}/blob/master/README.md)
- [Changelog](${REPO_URL}/blob/master/CHANGELOG.md)
- [Security Policy](${REPO_URL}/blob/master/SECURITY.md)
- [TrueNAS Catalog](${REPO_URL}/blob/master/packaging/truenas/README.md)
`;
}

export function syncWikiDirectory(docsDir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const expectedFiles = new Set(["Home.md", "_Sidebar.md", ...PAGES.map((page) => `${page.slug}.md`)]);

  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md") && !expectedFiles.has(entry.name)) {
      fs.rmSync(path.join(outDir, entry.name));
    }
  }

  for (const page of PAGES) {
    const sourcePath = path.join(docsDir, page.source);
    const content = fs.readFileSync(sourcePath, "utf8");
    fs.writeFileSync(path.join(outDir, `${page.slug}.md`), rewriteLinksForWiki(content), "utf8");
  }

  fs.writeFileSync(path.join(outDir, "Home.md"), buildHomePage(), "utf8");
  fs.writeFileSync(path.join(outDir, "_Sidebar.md"), buildSidebar(), "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  if (outIndex < 0 || !args[outIndex + 1]) {
    console.error("Usage: node scripts/sync-wiki.mjs --out <wiki-directory>");
    process.exit(1);
  }
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  syncWikiDirectory(path.join(rootDir, "docs"), path.resolve(args[outIndex + 1]));
  console.log(`Synced ${PAGES.length} docs pages, Home.md, and _Sidebar.md to ${path.resolve(args[outIndex + 1])}.`);
}

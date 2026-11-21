# Development & CI

## Prerequisites

- **Node.js 24** recommended (Node `>=22.19.0` is required by `@earendil-works/pi-coding-agent`).
- **Docker** and **Git** for container smoke tests and TrueNAS catalog validation.

## Local Development

Install dependencies for both the backend and frontend:

```bash
npm ci
npm --prefix frontend ci
```

Run the backend API and Vite dev server in separate terminals (Vite proxies `/api` to `http://localhost:3000`):

```bash
npm run dev
npm run dev:web
```

Or run against the local Docker dev container (`plex-repairman:dev`, using `./config:/config` via [compose.yml](../compose.yml)):

```bash
docker compose build plex-repairman
docker compose up -d plex-repairman
docker compose logs --tail=80 plex-repairman
```

## Validation Suite

Run the same checks that GitHub Actions enforces on pull requests and release tags:

```bash
npm run typecheck
npm test
npm audit
npm run audit:frontend
```

Build the local image and run the disposable container smoke and TrueNAS catalog suites (these use temporary synthetic configs and never touch live services):

```bash
docker compose build plex-repairman
node scripts/smoke-container.mjs plex-repairman:dev
node scripts/check-truenas-catalog.mjs --image plex-repairman:dev
```

- `scripts/smoke-container.mjs` verifies fresh installs, unfinished/configured/Basic migrations, non-root UID `1000` and `568`, restart persistence, secret-authenticated webhooks, backup/restore, and offline password recovery.
- `scripts/check-truenas-catalog.mjs` validates the package in [packaging/truenas/](../packaging/truenas/README.md) against the pinned upstream TrueNAS toolchain in `packaging/truenas/toolchain.json` for both managed-volume (`basic-values.yaml`) and host-path (`host-path-values.yaml`) scenarios.

## Repository Layout

| Path | Responsibility |
| --- | --- |
| `src/agent/` | Pi agent runner, multi-provider auth (`pi-auth.ts`), fallback execution, policy checks (`policy.ts`), repair case lifecycle, and tool worker queue |
| `src/discord/` | Discord.js client, thread creation, confirmation buttons, reactions, and `/health` slash command |
| `src/services/` | Plex, Sonarr, Radarr, Seerr clients, Plex scanner log ZIP inspection, and movie split/match helpers |
| `src/storage/` | SQLite database, encrypted secrets store, settings, conversations, repair cases, and agent tasks |
| `src/web/` | Fastify API server, portal form authentication/sessions/CSRF, webhooks, and static SPA hosting |
| `frontend/` | React + Vite + Tailwind + shadcn-style operations console ([frontend/README.md](../frontend/README.md)) |
| `scripts/` | Build/streaming patch (`patch-pi-streaming.mjs`), audits, smoke/catalog checks, TrueNAS exporter, password reset, and Wiki sync |
| `packaging/truenas/` | TrueNAS Community catalog definition and test fixtures |
| `docs/` | User, operations, and developer documentation (synced to GitHub Wiki) |

## Automated Pi SDK Updates

Dependabot checks `@earendil-works/pi-coding-agent` weekly (Mondays at 09:00 America/New_York) via [.github/dependabot.yml](../.github/dependabot.yml).

- Update PRs run `npm run typecheck`, `npm test`, dependency audits, Docker build, container smoke checks, and TrueNAS catalog checks without publishing an image.
- `scripts/patch-pi-streaming.mjs` enforces a 64 KB tool-argument limit on Pi's incremental streaming parser during `npm install`; unknown SDK source layouts fail installation immediately.
- Once the required `build` check succeeds, [.github/workflows/pi-auto-merge.yml](../.github/workflows/pi-auto-merge.yml) (running from `master`) automatically merges same-repository Dependabot PRs that touch only `package.json` and `package-lock.json` for `@earendil-works/pi-coding-agent`, then dispatches the Container workflow to publish the updated image. Catalog updates never change the user's configured model.

## Documentation & GitHub Wiki Sync

`docs/` is the single source of truth for user and operator documentation. On pushes to `master` that modify `docs/`, `scripts/sync-wiki.mjs`, or `.github/workflows/wiki-sync.yml`, GitHub Actions runs `scripts/sync-wiki.mjs` to generate `Home.md`, `_Sidebar.md`, and rewritten Markdown pages in the repository's GitHub Wiki.

You can preview the generated Wiki files locally without pushing:

```bash
node scripts/sync-wiki.mjs --out .agent-local/wiki-preview
```

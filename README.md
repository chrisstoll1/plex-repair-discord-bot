<p align="center">
  <img src="src/web/assets/repairman.png" alt="Plex Repairman" width="120">
</p>

# Plex Repairman

Plex Repairman is a Discord bot for diagnosing and repairing Plex, Sonarr, and Radarr media issues. Mention it in Discord, describe what is wrong, and it can inspect your media services, explain what it found, and run repairs allowed by your policy settings.

Portal-managed AI authentication supports OAuth sign-in, API keys across multiple providers, custom OpenAI/Anthropic-compatible endpoints, and an ordered primary/fallback model hierarchy.

## Capabilities

- Diagnose missing or incorrect movies, series, seasons, episodes, specials, and anime releases.
- Compare Plex availability with Sonarr or Radarr state, queues, history, files, and releases.
- Request new movies and TV seasons through optional Seerr integration, retaining request IDs, approval states, and links in repair history.
- Inspect Seerr destinations and quality profiles, edit pending request destinations, retry failed requests, and replace explicitly authorized 4K/standard requests after verifying the replacement. Seerr does not support changing an approved request's quality scope in place; request removal/replacement follows destructive-repair policy and never requests media/file deletion.
- Add movies to Radarr or series to Sonarr when the direct-add toggle is enabled, using existing roots/profiles and requested TV-season scope.
- Diagnose Plex indexing and matching issues using read-only scanner/server log excerpts filtered by title/path, with context, server-local time windows, pagination, and credential redaction.
- Inspect compact movie identities and all file versions, split incorrectly merged Plex movies, and fix an isolated movie's match using an exact external-ID lookup while preserving both files.
- Search for and grab releases, import and rename files, update monitoring and media settings, and refresh Plex libraries.
- Preview and execute Sonarr or Radarr manual imports with explicit media mappings and import modes, and preview renames before applying them.
- Restrict requests by Discord guild or channel and repairs by Discord role.
- Retain complete context with each repair thread.
- Create a dedicated public Discord thread for each issue, keep participants informed, and continue repairs after downloads or other external work finishes.
- Persist ongoing repairs across restarts and manage working, waiting, blocked, and completed cases from Ongoing Repairs.
- Resume waiting repairs from Sonarr or Radarr webhooks, with event replay for updates that arrive just before a wait is stored.
- Track queued and completed service workers from the Agent Tasks page.
- Configure connections, model behavior, timeouts, and repair policy from the web portal.

## Safety

The web portal opens directly by default. To require a form login, open **Settings > Security**, turn on **Require sign-in**, and save an administrator username and password. Sessions use a private cookie and can coexist with reverse-proxy authentication. When sign-in is off, anyone who can reach the portal can manage credentials, policies and retained data. Use a trusted network or an authenticated HTTPS reverse proxy. See [SECURITY.md](SECURITY.md).

Repair execution is disabled by default:

- `Require confirmation` asks the requesting user to approve one exact server-described repair action with temporary Discord Confirm/Cancel buttons before that action can execute.
- Disabling confirmation permits direct non-destructive repairs for users who satisfy the configured repair-role policy.
- `Allow destructive repairs` must also be enabled for queue removal, file deletion, and movie or series removal.
- `Allow direct Sonarr/Radarr additions` controls new direct additions and defaults off. It does not change existing-media repair permissions.
- Seerr is preferred for new requests when configured. To choose direct additions instead, enable the direct-add toggle and turn off `Prefer Seerr for new requests` in Connections. Preferred Seerr approvals, quotas, and denials cannot be bypassed with direct adds.
- Repair policy is checked again when each write action runs.

## Quick Start

The published image is available from GitHub Container Registry:

```text
ghcr.io/chrisstoll1/plex-repair-discord-bot:latest
```

Create a Compose file:

```yaml
services:
  plex-repairman:
    image: ghcr.io/chrisstoll1/plex-repair-discord-bot:latest
    container_name: plex-repairman
    ports:
      - "3000:3000"
    environment:
      CONFIG_DIR: /config
      HTTP_HOST: 0.0.0.0
      HTTP_PORT: 3000
      LOG_LEVEL: info
    volumes:
      - repairman-config:/config
    restart: unless-stopped
    init: true
    read_only: true
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=64m,mode=1777

volumes:
  repairman-config:
```

Start the container and open the portal:

```bash
docker compose up -d
```

```text
http://localhost:3000
```

The `/config` volume is required for persistent settings, secrets, repair context, task history, and AI provider auth. Back up the entire directory as a unit.

Use service URLs reachable from the container, such as `http://sonarr:8989`, `http://radarr:7878`, and `http://plex:32400`. For services on another machine, use their LAN addresses. Direct Docker or LAN URLs are preferable to tunnels and public proxies, which may time out during long release lookups.

Scanner diagnostics use Plex's `/diagnostics/logs` ZIP download with the configured Plex token. The token must have administrator log-download access. No Plex filesystem mount is required. Only scanner, matcher, analysis, and server logs (including retained rotations) are read in memory; archives are never extracted to disk. Downloads are limited to 32 MiB, each log to 16 MiB, and total selected logs to 64 MiB. Filters use Plex server local time (`YYYY-MM-DDTHH:mm:ss` without a timezone suffix); missing or rotated log entries cannot prove that a file was scanned or is healthy. The tool does not enable logging or trigger scans.

Movie match repairs use the modern Plex Movie agent and Plex's metadata provider to verify an exact TMDB/IMDb identity. Split Apart requires a current snapshot of every part ID and file path; Fix Match requires one isolated part and a uniquely verified match candidate. Both follow the configured repair-role and confirmation policy. They do not delete media. After splitting, the bot must rediscover item IDs by file path and verify both movies before reporting success.

For Docker-based TrueNAS releases (24.10 and newer), the Custom App YAML accepts the same Compose configuration. To use an existing dataset, replace `repairman-config:/config` with a dataset path such as `/mnt/tank/apps/plex-repairman/config:/config` and grant the runtime user read/write access to that dataset. The image defaults to UID/GID `1000:1000`; the catalog package defaults to TrueNAS `568:568`. No media mounts, Docker socket, host management API, GPU or privileged mode are required. The native catalog package and submission procedure are in [packaging/truenas](packaging/truenas/README.md).

## First-Time Setup

1. Open `http://<host>:3000`. The portal opens immediately. Optionally enable **Require sign-in** under **Settings > Security**; no setup token or container-shell access is required.
2. Open **Settings > Discord** for the bot token and application ID. Open **Settings > Connections** for Plex, Sonarr, Radarr and optional Seerr credentials.
   Seerr uses its configured server/profile defaults. The API key is encrypted and never returned by the settings API. Link Discord IDs in Seerr notification settings or provide explicit `DiscordID:SeerrUserID` mappings. An optional shared Seerr account ID can own unlinked requests; 0 requires a linked account. The effective Seerr user's permissions, quotas, and approval rules apply.
3. Open **Settings > AI** to connect one or more AI providers (OAuth, API key, or custom endpoint), configure your primary and fallback model hierarchy, test connectivity, and set thinking level and timeouts.
4. Optionally configure **Automatic progress events** in **Settings > Connections**, copy each generated webhook URL, and add it in Sonarr or Radarr under `Settings > Connect` as a webhook for grab, download/import, upgrade, rename, and manual-interaction-required events.
5. Configure guild/channel allowlists and repair roles in **Settings > Discord**. Configure confirmations, destructive actions and direct additions in **Settings > Repair policy**.
6. Open **Overview** to review service connectivity and AI-auth status. Use **Repairs** and **Agent tasks** to inspect retained operational data.

The sidebar separates daily work (Overview, Repairs and Agent tasks) from configuration. **Settings** contains Connections, Discord, AI, Repair policy and Security. Existing `/connections`, `/bot-settings` and `/account` links redirect into the new structure. Settings forms share Save changes, Reset and unsaved-change protection.

The portal remains available when Discord is unconfigured or fails to connect, allowing connection settings to be corrected.

## Discord Setup

Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).

Required configuration:

- Enable the `Message Content Intent` for the bot.
- Give the bot permission to view channels, read message history, send messages, create public threads, send messages in threads, manage threads, and add reactions where it will be used.
- Add the bot token on the Plex Repairman `Connections` page.
- Invite the bot to your server.

The application ID is optional and is used to register the global `/health` slash command. Direct messages are disabled by default and can be enabled under `Bot Settings`.

In a server, mention the bot with a request:

```text
@Plex Repairman why is Dune missing?
```

The bot creates a public thread from the request. Messages from any participant in that active thread are included without another mention, and each Discord thread is constrained to one durable repair case. Each participant's current Discord roles are checked for repairs requested on their behalf. Separate issue threads can work concurrently.

When confirmation is disabled, an ongoing case may diagnose, repair, verify, wait, and resume until it succeeds or reaches a real blocker. Healthy configured webhooks resume work after successful imports or related manual-interaction events. A two-hour fallback check catches missed events. For unreleased media with an exact service release timestamp, the fallback waits until one hour after availability; matching events can still resume the case earlier. Unchanged automatic checks stay quiet, back off to at most one check per day, and do not spend repair attempts. Release waits retain a seven-day verification window after the expected release. Disabling an integration converts its event waits to timers while preserving these planned check times. New user messages still receive a response, and changed wait states or final results produce updates.

## Configuration and Data

### Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `CONFIG_DIR` | `./config` | Persistent application data directory; the container sets `/config` |
| `HTTP_HOST` | `0.0.0.0` | Web server bind address |
| `HTTP_PORT` | `3000` | Web server port |
| `LOG_LEVEL` | `info` | Application log level |
| `PORTAL_SECURE_COOKIE` | `false` | Set `true` for an HTTPS-only portal; secure cookies cannot be used over direct HTTP |

### Persistent Files

| Path | Contents |
| --- | --- |
| `/config/plex-repairman.db` | Settings, complete repair-thread history, wake conditions, delivery state, processed messages, and agent-task history |
| `/config/secrets.key` | Local key used to encrypt Discord and media-service credentials |
| `/config/pi/auth.json` | Pi AI provider authentication data |
| `/config/pi/models.json` | Custom OpenAI/Anthropic-compatible provider definitions (when configured) |

Ordinary settings and retained message/task data are not encrypted. The database and `secrets.key` belong together; losing the key makes encrypted service credentials unrecoverable.

Repair threads retain their complete conversation context with the repair case. Older context is compacted for model prompts when necessary but remains available through case-history lookup.

### Upgrading and Backup

Stop the app before taking a filesystem copy of `/config`, or use a coordinated dataset snapshot while the app is stopped. Back up the entire volume, including the SQLite database, any WAL/SHM files, `secrets.key` and `pi/`. Restore them together. Never copy only the database or replace its key with a new one.

When upgrading from a 0.1 image:

1. Stop the app and back up its configuration dataset.
2. Grant the configured non-root runtime UID/GID read/write access to the existing configuration tree. On an ordinary Linux bind mount using the default image user, the owner is `1000:1000`. TrueNAS catalog defaults use `568:568`; use Dataset Permissions/ACLs to grant access. The permissions helper initializes empty datasets; it deliberately does not recursively change ownership of existing data. Do not change ownership of your media datasets.
3. Start the new image with the same `/config` volume. Existing settings, encrypted credentials, AI authentication and repair history are retained.
4. Open the portal and review **Settings > Security**. Sign-in defaults off unless credentials were already configured; see the migration notes below.
5. Verify `/health`, portal access, service connectivity and retained repairs before enabling further work.

For rollback, stop the app, restore the complete pre-upgrade backup and use its previous exact image tag or digest. Avoid running an older image against a database already changed by a newer version.

### Portal Authentication

Enable or disable **Require sign-in** from **Settings > Security**. Set a username and a password of at least eight characters, then confirm the new password. Leave the password blank to keep the saved one. Security changes require your current password when sign-in is already enabled. Saving keeps your current browser signed in and revokes other sessions. Use **Sign out** in the header on a shared computer. Sessions expire after 12 hours or an application restart.

The portal uses its own sign-in form and HttpOnly, SameSite cookies. It does not use HTTP Basic challenges or the Authorization header, so an existing reverse-proxy Basic login can remain enabled with different credentials. Use HTTPS for remote access, set `PORTAL_SECURE_COOKIE=true` for HTTPS-only cookies, and disable proxy caching for the portal and `/api` routes.

Upgrading from **0.2.1** preserves the application-auth toggle, username and password, migrating them from Basic auth to form sign-in. Completed **0.2.0** administrator accounts migrate with username **admin** and the same password. Fresh installs and unfinished setups remain open by default; obsolete setup tokens are removed. Other settings, encryption keys, AI authentication and repair history are retained. Existing browser sessions must sign in again after upgrading.

To recover lost credentials, stop the app, run the reset helper with the same configuration volume and runtime UID/GID, then restart it:

```bash
docker compose stop plex-repairman
docker compose run --rm --no-deps --entrypoint node plex-repairman scripts/reset-portal-password.mjs --confirm
docker compose up -d plex-repairman
```

This disables application sign-in and clears only its credentials. Re-enable it in **Settings > Security** if desired. In TrueNAS, use a temporary container with the same image, runtime UID/GID and configuration dataset to run the helper while the app is stopped. Do not delete the database or secrets.key.

## Example Requests

```text
@Plex Repairman Plex does not show Chainsaw Man episode 3. Check Sonarr and Plex.
```

```text
@Plex Repairman find a dual-audio replacement for Jujutsu Kaisen S01E10
```

```text
@Plex Repairman refresh my Plex TV library
```

## Operations

The container health endpoint is:

```text
http://<host>:3000/health
```

It returns `200` when the web process is alive. It intentionally does not depend on Discord, Plex, Sonarr, Radarr, or AI authentication so incomplete configuration does not cause container restart loops. Detailed media-service checks are available on `Overview`.

Images are validated before publication. Builds from `master` use the package version followed by `-build.<run>.<attempt>`; for example `0.2.3-build.65.1`. A matching `v0.2.3` Git tag publishes stable image version `0.2.3` after verifying that its commit belongs to `master`. Local builds display `dev`. Pull requests and manual runs on other branches validate without publishing. See [CHANGELOG.md](CHANGELOG.md).

| Tag | Use |
| --- | --- |
| `latest` | Current mutable build from `master` |
| `0.2.3` | Stable release published by the matching Git tag; pin the digest for a catalog submission |
| `0.2.3-build.<run>.<attempt>` | Automatic build from `master` |
| `build-<run-number>.<run-attempt>` | Exact workflow attempt, including reruns |
| `sha-<commit-sha>` | Build for a specific source commit |

The web menu links the displayed version to this repository. Use an exact build-attempt tag or image digest when reproducible deployment or rollback is important.

When sign-in is enabled, administration APIs require a portal session. The public page shell displays only the sign-in form until authenticated. `/health` remains public and Arr webhooks use their own secret URL. State-changing API requests require `X-Repairman-Request: 1` and authenticated changes also require the session CSRF token. No cross-origin access is granted.

## Development

Node 24 is recommended; Node 22.19 or newer is required by the Pi SDK.

```bash
npm ci
npm --prefix frontend ci
npm run typecheck
npm test
npm run build
```

Image and catalog installation checks use disposable synthetic configurations and never access your running media services:

```bash
docker compose build plex-repairman
node scripts/smoke-container.mjs plex-repairman:dev
node scripts/check-truenas-catalog.mjs --image plex-repairman:dev
```

These checks require Docker and Git. Catalog validation uses the pinned upstream repository and validation image in `packaging/truenas/toolchain.json`. It tests both managed-volume and host-path templates, non-default ports, non-root users, health and default portal access. The image smoke checks also cover a legacy-data fixture, restart persistence, backup/restore, secret-authenticated webhooks and offline authentication recovery.

Run the API and Vite development servers in separate terminals:

```bash
npm run dev
npm run dev:web
```

Vite proxies `/api` to the API on port `3000`. To run the local development container instead:

```bash
docker compose up --build
```

### Weekly model catalog updates

Dependabot checks `@earendil-works/pi-coding-agent` for updates every Monday at
09:00 America/New_York and opens an update PR against `master`. Pi supplies the
bot's built-in model catalog, so available models follow Pi releases. This
configuration becomes active when `.github/dependabot.yml` reaches GitHub's
default branch.

Update PRs run typechecking, tests, and a Docker build without publishing an
image. The application keeps a 64 KB tool-argument limit on top of Pi's
incremental streaming parser. Unknown SDK source layouts fail installation;
streaming and authentication regression tests must pass before an update merges.

After successful Container validation, a workflow from the trusted default
branch automatically merges same-repository Dependabot PRs that change only
`package.json` and `package-lock.json`, with Pi as the only manifest change.
It checks the exact validated commit and GitHub's required `build` check.
Failed, stale, draft, forked, or mixed updates require manual intervention.
The workflow explicitly dispatches Container after merging so the new image is
published even though GitHub's workflow token does not trigger push workflows.
Production restarts remain manual. Catalog updates do not change the bot's
selected model.

## License

Plex Repairman is available under the [MIT License](LICENSE).

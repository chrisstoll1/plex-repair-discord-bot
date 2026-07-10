<p align="center">
  <img src="src/web/assets/repairman.png" alt="Plex Repairman" width="120">
</p>

# Plex Repairman

Plex Repairman is a Discord bot for diagnosing Plex, Sonarr, and Radarr media issues. Mention it in Discord, describe what is wrong, and it can inspect your media apps, explain what it found, and recommend the next repair step.

It is built for common home media-server workflows like missing movies, missing episodes, wrong anime audio language, replacement searches, and checking whether Plex/Sonarr/Radarr agree about what is available.

**NOTE:** **Currently only OpenAI Codex - OAuth is supported for AI models integration**
## Features

- Discord mention-driven repair assistant.
- Optional direct-message handling.
- Web portal for configuration, health checks, and OpenAI Codex auth.
- Plex, Sonarr, and Radarr connection settings stored in encrypted SQLite-backed config.
- Radarr-first handling for movie, film, theatrical, and multi-language movie requests.
- Sonarr-first handling for series, seasons, episodes, specials, anime seasons, and OVAs.
- Read-only Radarr movie, queue, history, file, and release inspection.
- Read-only Sonarr series, season, episode, queue, history, file, and release inspection.
- Plex library and service health inspection.
- Manual import and rename previews without applying changes.
- Configurable conversation memory for follow-up messages in channels, threads, and DMs.
- Configurable status reactions and refreshed typing indicators while requests are running.
- OpenAI Codex device-code auth through Pi Coding Agent.

## How It Works

Plex Repairman gives focused read-only tools to separate Sonarr, Radarr, Plex, and cross-service workers. A coordinator assigns inspection tasks and combines their findings into one response.

Current worker profiles are intentionally read-only. The codebase contains repair-tool implementations and policy settings, but they are not exposed to the active coordinator/worker path. Safe write execution requires a server-owned, action-specific confirmation workflow before those tools can be enabled.

For example, if you ask for a replacement anime episode because the audio is wrong, the bot can:

1. Find the Sonarr series.
2. Resolve the exact season and episode.
3. Inspect the current episode file.
4. Inspect available releases and relevant queue or history entries.
5. Explain the evidence and recommend the specific replacement or repair action.

For movies, it follows the same diagnostic pattern through Radarr and reports movie-file-level findings.

## Docker Install

The published container image is available from GitHub Container Registry:

```bash
ghcr.io/chrisstoll1/plex-repair-discord-bot:latest
```

Run with Docker:

```bash
docker run -d \
  --name plex-repairman \
  --restart unless-stopped \
  -p 3000:3000 \
  -e CONFIG_DIR=/config \
  -e HTTP_HOST=0.0.0.0 \
  -e HTTP_PORT=3000 \
  -e LOG_LEVEL=info \
  -v ./config:/config \
  ghcr.io/chrisstoll1/plex-repair-discord-bot:latest
```

Open the portal at:

```text
http://localhost:3000
```

The `/config` volume is required. It stores app settings, encrypted secrets, and Pi/OpenAI auth data. Back up the entire directory as a unit; the SQLite database and `secrets.key` belong together because stored API tokens are encrypted.

## Docker Compose

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
      - ./config:/config
    restart: unless-stopped
```

Start it:

```bash
docker compose up -d
```

Stop it:

```bash
docker compose down
```

If Plex, Sonarr, or Radarr are running in other containers, use URLs that are reachable from the Plex Repairman container. Examples:

```text
http://sonarr:8989
http://radarr:7878
http://plex:32400
```

If they are running on the host or another machine, use the appropriate LAN address instead.

Avoid Cloudflare, tunnels, or public reverse-proxy URLs for Sonarr/Radarr/Plex API access. Release lookups can run long enough for proxies to return `504 Gateway Timeout`; direct Docker or LAN URLs are more reliable.

## TrueNAS Custom App Compose

In TrueNAS SCALE, create a Custom App and paste a compose file like this. Change the dataset path to match your system.

```yaml
services:
  plex-repairman:
    image: ghcr.io/chrisstoll1/plex-repair-discord-bot:latest
    pull_policy: always
    container_name: plex-repairman
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      CONFIG_DIR: /config
      HTTP_HOST: 0.0.0.0
      HTTP_PORT: 3000
      LOG_LEVEL: info
    volumes:
      - /mnt/tank/apps/plex-repairman/config:/config
```

Recommended TrueNAS notes:

- Create the config dataset before starting the app.
- Replace `/mnt/tank/apps/plex-repairman/config` with your actual dataset path.
- Back up the full config dataset, not just the database file.
- Put the portal behind your normal reverse proxy or private network access controls.
- Configure Sonarr, Radarr, and Plex URLs using addresses reachable from the app container.

This compose example is for TrueNAS Custom App installs. Official TrueNAS catalog submission uses the Docker Compose-based catalog at `https://github.com/truenas/apps` and wraps the same image, `/config` storage, port `3000`, and environment variables in catalog metadata and templates.

## First-Time Setup

1. Start the container.
2. Open `http://<host>:3000`.
3. Open `Connections`.
4. Enter your Discord bot token and application ID.
5. Configure allowed guild IDs and channel IDs if you want to restrict where the bot responds.
6. Configure repair role IDs if only specific Discord roles should be allowed to run repair actions.
7. Configure Sonarr URL and API key.
8. Configure Radarr URL and API key.
9. Configure Plex URL and token.
10. Open `Bot Settings` and choose repair policy settings.
11. Choose conversation memory settings.
12. Save settings.
13. Connect OpenAI Codex auth from the device-code panel on `Connections`.
14. Check `Overview` to confirm all services are reachable.

The portal intentionally has no built-in authentication. Run it only on a trusted network or put it behind a reverse proxy with access controls.

## Discord Bot Setup

Create a Discord application and bot in the Discord Developer Portal.

Required setup:

- Copy the bot token into Plex Repairman's settings page.
- Copy the application ID into Plex Repairman's settings page.
- Enable the `Message Content Intent` for the bot.
- Invite the bot to your server.
- Give it permission to read messages, send messages, and add reactions in the channels where it should respond.

By default, the bot responds when mentioned:

```text
@Plex Repairman why is Dune missing?
```

Direct messages are disabled by default. Enable `Allow Direct Messages` in settings if you want DM messages to be handled as bot requests without requiring an `@` mention.

## Example Usage

Missing movie:

```text
@Plex Repairman why is Dune missing?
```

Search for a movie in Radarr:

```text
@Plex Repairman can you search Radarr for The Batman?
```

Wrong audio on a movie:

```text
@Plex Repairman replace Demon Slayer Mugen Train with English or multi-language audio
```

Wrong audio on an anime episode:

```text
@Plex Repairman fix Demon Slayer S02E05, it has the wrong audio
```

Search for a replacement episode:

```text
@Plex Repairman search for a replacement for One Piece S01E12 with English audio
```

Search specials or Season 0:

```text
@Plex Repairman search Demon Slayer specials for the English dub
```

Check why something is not in Plex:

```text
@Plex Repairman Plex does not show Chainsaw Man episode 3, can you check Sonarr and Plex?
```

Refresh a Plex library section:

```text
@Plex Repairman refresh my Plex TV library
```

Ask before a repair:

```text
@Plex Repairman find a better dual-audio release for Jujutsu Kaisen S01E10
```

The bot should explain what it found and ask for confirmation before policy-controlled repair actions.

## Conversation Memory

Conversation memory is configured on the `Bot Settings` page. Active sessions can be inspected and deleted from `Memory`.

Available settings:

- `Enable conversation memory`: turns recent-message context on or off.
- `Memory Scope`: controls whether memory is per user or shared by everyone in a channel/thread.
- `Max Messages To Remember`: limits how many recent turns are included in the next prompt.
- `Memory TTL Hours`: expires older stored messages.
- `Include bot replies in memory`: lets follow-up messages include what the bot previously said.

Default behavior:

- Memory is enabled.
- Scope is `Channel/thread + user`.
- Up to 10 recent messages are remembered.
- Messages expire after 24 hours.
- Bot replies are included.

Discord threads use their own Discord channel ID, so each thread gets separate memory. If you configure allowed channel IDs, remember that a Discord thread has a different channel ID than its parent channel.

Scope options:

- `Channel/thread + user`: safest default. Each user gets separate memory within a channel or thread.
- `Shared channel/thread`: collaborative mode. Everyone in the channel or thread shares the same recent context.

Memory is used only as prompt context. The app still creates a fresh AI session for each Discord message.

## Repair Policy

Repair settings are configured on the `Bot Settings` page, but active worker profiles are currently read-only. These settings are retained for the future confirmed-action executor and do not make write tools reachable today.

`Require confirmation for repair actions` will require an explicit, action-specific confirmation before a future executor can make changes.

`Allow destructive repair actions` will control file and media removal. It should remain disabled until server-owned confirmation and execution are implemented.

Recommended defaults:

- Keep confirmation required.
- Keep destructive actions disabled.
- Configure repair role IDs before write execution is introduced.

Important behavior:

- Read-only checks are allowed without confirmation.
- The bot recommends repair steps but does not currently execute them.
- Enabling write tools directly in a worker profile is not supported or safe.

## OpenAI Codex Auth

Plex Repairman uses Pi Coding Agent for the AI runtime and supports OpenAI Codex auth through a device-code flow.

Open the portal and select `Connections`:

```text
http://<host>:3000/connections
```

Start login, open the verification URL, enter the displayed code, and leave the page open until it completes.

Credentials are stored under:

```text
/config/pi/auth.json
```

OAuth access tokens expire, but the SDK refreshes them automatically when possible. The portal also attempts to refresh expired credentials before showing auth status. If refresh fails, reconnect from `Connections`.

## Health Checks

The lightweight container health endpoint is:

```text
http://<host>:3000/health
```

It returns `200` when the web process is alive. It does not require Discord, Sonarr, Radarr, Plex, or Pi auth to be configured, so container orchestrators do not restart the app during first-time setup.

Detailed service connectivity is available on the portal overview:

```text
http://<host>:3000/
```

## Published Images

GitHub Actions publishes images to GHCR on pushes to `master` and manual workflow runs.

Available tags:

```text
ghcr.io/chrisstoll1/plex-repair-discord-bot:latest
ghcr.io/chrisstoll1/plex-repair-discord-bot:<package-version>
ghcr.io/chrisstoll1/plex-repair-discord-bot:sha-<commit-sha>
```

Use `latest` for normal deployments. Use `<package-version>` when you want a stable release tag. Use `sha-<commit-sha>` when you want to pin, test, or roll back to a specific build.

Images include OCI labels that link back to the source repository and exact commit:

```text
org.opencontainers.image.source
org.opencontainers.image.revision
org.opencontainers.image.url
```

## Development

Install dependencies:

```bash
npm install
npm --prefix frontend install
```

Run the API and frontend development servers in separate terminals:

```bash
npm run dev
npm run dev:web
```

The Vite development server proxies `/api` requests to the API on port `3000`.

Typecheck:

```bash
npm run typecheck
```

Build:

```bash
npm run build
```

Run tests:

```bash
npm test
```

Run with the local development compose file:

```bash
docker compose up --build
```

By default, local config is stored in `./config`. In containers, use `/config` as a persistent volume.

The Pi SDK requires Node `>=22.19.0`. If your local Node is older, use Docker Desktop or the published container image.

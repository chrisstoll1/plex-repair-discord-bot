<p align="center">
  <img src="src/web/assets/repairman.png" alt="Plex Repairman" width="120">
</p>

# Plex Repairman

Plex Repairman is a Discord bot for diagnosing and repairing Plex, Sonarr, and Radarr media issues. Mention it in Discord, describe what is wrong, and it can inspect your media services, explain what it found, and run repairs allowed by your policy settings.

Portal-managed AI authentication currently supports OpenAI Codex OAuth only.

## Capabilities

- Diagnose missing or incorrect movies, series, seasons, episodes, specials, and anime releases.
- Compare Plex availability with Sonarr or Radarr state, queues, history, files, and releases.
- Search for and grab releases, import and rename files, update monitoring and media settings, and refresh Plex libraries.
- Preview and execute Sonarr or Radarr manual imports with explicit media mappings and import modes, and preview renames before applying them.
- Restrict requests by Discord guild or channel and repairs by Discord role.
- Retain complete context with each repair thread.
- Create a dedicated public Discord thread for each issue, keep participants informed, and continue repairs after downloads or other external work finishes.
- Persist ongoing repairs across restarts and manage working, waiting, blocked, and completed cases from Ongoing Repairs.
- Resume waiting repairs from Sonarr or Radarr webhooks, with event replay and bounded fallback checks when a webhook is missed.
- Track queued and completed service workers from the Agent Tasks page.
- Configure connections, model behavior, timeouts, and repair policy from the web portal.

## Safety

The web portal has no built-in authentication. Keep it on a trusted network or place it behind a reverse proxy with access controls. Portal users can change credentials and policies and inspect or delete retained conversation and agent-task data.

Repair execution is disabled by default:

- `Require confirmation` asks the requesting user to approve one exact server-described repair action with temporary Discord Confirm/Cancel buttons before that action can execute.
- Disabling confirmation permits direct non-destructive repairs for users who satisfy the configured repair-role policy.
- `Allow destructive repairs` must also be enabled for queue removal, file deletion, and movie or series removal.
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
      - ./config:/config
    restart: unless-stopped
```

Start the container and open the portal:

```bash
docker compose up -d
```

```text
http://localhost:3000
```

The `/config` volume is required for persistent settings, secrets, repair context, task history, and OpenAI auth. Back up the entire directory as a unit.

Use service URLs reachable from the container, such as `http://sonarr:8989`, `http://radarr:7878`, and `http://plex:32400`. For services on another machine, use their LAN addresses. Direct Docker or LAN URLs are preferable to tunnels and public proxies, which may time out during long release lookups.

For TrueNAS SCALE, use the same Compose configuration in a Custom App and replace `./config` with a dataset path such as `/mnt/tank/apps/plex-repairman/config`.

## First-Time Setup

1. Open `http://<host>:3000/connections`.
2. Enter the Discord bot token and your Plex, Sonarr, and Radarr connection details.
3. Enter the Discord application ID if you want the global `/health` slash command.
4. Connect OpenAI Codex using the device-code panel.
5. Optionally configure the public Repairman URL under `Automatic progress events`, copy each generated webhook URL, and add it in Sonarr or Radarr under `Settings > Connect` as a webhook for grab, download/import, upgrade, and rename events.
6. Open `Bot Settings` and configure Discord allowlists, repair roles, model behavior, timeouts, and repair policy.
7. Open `Overview` to test Plex, Sonarr, and Radarr connectivity and review Discord and AI-auth status.
8. Use `Ongoing Repairs` and `Agent Tasks` to inspect or manage retained operational data.

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

When confirmation is disabled, an ongoing case may diagnose, repair, verify, wait, and resume until it succeeds or reaches a real blocker. Healthy configured webhooks are preferred over timed checks. Disabling a webhook integration converts affected waits to a delayed check.

## Configuration and Data

### Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `CONFIG_DIR` | `./config` | Persistent application data directory; the container sets `/config` |
| `HTTP_HOST` | `0.0.0.0` | Web server bind address |
| `HTTP_PORT` | `3000` | Web server port |
| `LOG_LEVEL` | `info` | Application log level |

### Persistent Files

| Path | Contents |
| --- | --- |
| `/config/plex-repairman.db` | Settings, complete repair-thread history, wake conditions, delivery state, processed messages, and agent-task history |
| `/config/secrets.key` | Local key used to encrypt Discord and media-service credentials |
| `/config/pi/auth.json` | Pi/OpenAI authentication data |

Ordinary settings and retained message/task data are not encrypted. The database and `secrets.key` belong together; losing the key makes encrypted service credentials unrecoverable.

Repair threads retain their complete conversation context with the repair case. Older context is compacted for model prompts when necessary but remains available through case-history lookup.

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

Images are published from `master` and manual workflow runs with these tags:

| Tag | Use |
| --- | --- |
| `latest` | Current mutable build from `master` |
| `<package-version>` | Version label; mutable when rebuilt without a version bump |
| `sha-<commit-sha>` | Immutable build for a specific commit |

Use a SHA tag when reproducible deployment or rollback is important.

## Development

Node 24 is recommended; Node 22.19 or newer is required by the Pi SDK.

```bash
npm ci
npm --prefix frontend ci
npm run typecheck
npm test
npm run build
```

Run the API and Vite development servers in separate terminals:

```bash
npm run dev
npm run dev:web
```

Vite proxies `/api` to the API on port `3000`. To run the local development container instead:

```bash
docker compose up --build
```

## License

Plex Repairman is available under the [MIT License](LICENSE).

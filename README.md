<p align="center">
  <img src="src/web/assets/repairman.png" alt="Plex Repairman" width="120">
</p>

# Plex Repairman

Plex Repairman is a Discord bot for diagnosing and repairing Plex, Sonarr, and Radarr media issues. Mention it in Discord, describe what is wrong, and it can inspect your media apps, explain what it found, and run approved repair actions.

It is built for common home media-server workflows like missing movies, missing episodes, wrong anime audio language, replacement searches, and checking whether Plex/Sonarr/Radarr agree about what is available.

**NOTE:** **Currently only OpenAI Codex - OAuth is supported for AI models integration**
## Features

- Discord mention-driven repair assistant.
- Optional direct-message handling.
- Web portal for configuration, health checks, and OpenAI Codex auth.
- Plex, Sonarr, and Radarr connection settings stored in encrypted SQLite-backed config.
- Radarr-first handling for movie, film, theatrical, and multi-language movie requests.
- Sonarr-first handling for series, seasons, episodes, specials, anime seasons, and OVAs.
- Manual Radarr movie searches.
- Manual Sonarr series, season, and episode searches.
- Release listing and explicit release grabs for Radarr and Sonarr.
- File-level replacement workflows for bad audio or wrong-language files.
- Delete a specific Sonarr episode file without removing the whole series.
- Delete a specific Radarr movie file without removing the movie from Radarr.
- Monitoring updates for Radarr movies, Sonarr series, and Sonarr seasons.
- Repair policy controls for confirmation prompts and destructive actions.
- Repair role restrictions for limiting who can run repair actions.
- Configurable conversation memory for follow-up messages in channels, threads, and DMs.
- Configurable status reactions and refreshed typing indicators while requests are running.
- OpenAI Codex device-code auth through Pi Coding Agent.

## How It Works

Plex Repairman gives the AI agent a focused set of media-management tools. The bot can inspect Plex, Sonarr, and Radarr before answering, then use repair tools only when policy allows it.

For example, if you ask for a replacement anime episode because the audio is wrong, the bot can:

1. Find the Sonarr series.
2. Resolve the exact season and episode.
3. Inspect the current episode file.
4. Ask for confirmation if a delete/search/grab action is required.
5. Delete only the bad episode file if destructive repairs are enabled.
6. Trigger an episode search or inspect available releases.
7. Grab a selected replacement release.

For movies, it follows the same pattern through Radarr and works at the movie-file level when replacing a bad file.

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

The `/config` volume is required. It stores app settings, encrypted secrets, and Pi/OpenAI auth data.

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

## TrueNAS Custom App Compose

In TrueNAS SCALE, create a Custom App and paste a compose file like this. Change the dataset path to match your system.

```yaml
services:
  plex-repairman:
    image: ghcr.io/chrisstoll1/plex-repair-discord-bot:latest
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
- Put the portal behind your normal reverse proxy or private network access controls.
- Configure Sonarr, Radarr, and Plex URLs using addresses reachable from the app container.

## First-Time Setup

1. Start the container.
2. Open `http://<host>:3000`.
3. Go to `Settings`.
4. Enter your Discord bot token and application ID.
5. Configure allowed guild IDs and channel IDs if you want to restrict where the bot responds.
6. Configure repair role IDs if only specific Discord roles should be allowed to run repair actions.
7. Configure Sonarr URL and API key.
8. Configure Radarr URL and API key.
9. Configure Plex URL and token.
10. Choose repair policy settings.
11. Choose conversation memory settings.
12. Save settings.
13. Go to `Pi Auth` and connect OpenAI Codex auth with the device-code flow.
14. Check `Health` to confirm all services are reachable.

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

Conversation memory is configured in the Settings page.

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

Repair settings are configured in the portal.

`Require confirmation for repair actions` controls whether the bot must ask before actions such as searches, grabs, monitoring changes, and deletes.

`Allow destructive repair actions` controls whether destructive tools can run. Destructive actions include deleting a Sonarr episode file, deleting a Radarr movie file, removing a Sonarr series, or removing a Radarr movie.

Recommended defaults:

- Keep confirmation required.
- Keep destructive actions disabled until you are comfortable with the workflow.
- Configure repair role IDs so only trusted Discord roles can run repair tools.

Important behavior:

- Read-only checks are allowed without confirmation.
- File replacement should delete only the specific bad episode file or movie file.
- Whole-series or whole-movie removal is separate and should not be used for a single bad file.
- The bot must not claim an action was performed unless a tool result confirms it.

## OpenAI Codex Auth

Plex Repairman uses Pi Coding Agent for the AI runtime and supports OpenAI Codex auth through a device-code flow.

Open:

```text
http://<host>:3000/pi-auth
```

Start login, open the verification URL, enter the displayed code, and leave the page open until it completes.

Credentials are stored under:

```text
/config/pi/auth.json
```

OAuth access tokens expire, but the SDK refreshes them automatically when possible. The portal also attempts to refresh expired credentials before showing auth status. If refresh fails, reconnect from the `Pi Auth` page.

## Health Checks

Open:

```text
http://<host>:3000/health
```

The health page checks connectivity to Sonarr, Radarr, Plex, and Pi auth status.

## Published Images

GitHub Actions publishes images to GHCR on pushes to `master` and manual workflow runs.

Available tags:

```text
ghcr.io/chrisstoll1/plex-repair-discord-bot:latest
ghcr.io/chrisstoll1/plex-repair-discord-bot:sha-<commit-sha>
```

Use `latest` for normal deployments. Use `sha-<commit-sha>` when you want to pin, test, or roll back to a specific build.

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
```

Run locally:

```bash
npm run dev
```

Typecheck:

```bash
npm run typecheck
```

Build:

```bash
npm run build
```

Run with the local development compose file:

```bash
docker compose up --build
```

By default, local config is stored in `./config`. In containers, use `/config` as a persistent volume.

The Pi SDK requires Node `>=22.19.0`. If your local Node is older, use Docker Desktop or the published container image.

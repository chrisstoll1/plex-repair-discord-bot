<p align="center">
  <img src="src/web/assets/repairman.png" alt="Plex Repairman" width="120">
</p>

# Plex Repairman

Plex Repairman is a self-hosted Discord bot and web portal for diagnosing and repairing Plex, Sonarr, Radarr, and Seerr media issues. Mention it in Discord, describe what is wrong, and it inspects your media services, explains what it found, and runs repairs allowed by your policy settings.

- **Multi-provider AI with fallbacks:** Connect OAuth subscriptions, API keys, or custom OpenAI/Anthropic-compatible endpoints with an ordered primary/fallback model hierarchy and inline connectivity tests.
- **Safe by default:** Destructive repairs and direct Sonarr/Radarr additions are off by default, write actions can require per-action Discord confirmation, and repair permissions can be scoped by Discord role.
- **Durable repair threads:** Each issue gets a dedicated public Discord thread that persists across restarts and resumes automatically from Sonarr/Radarr webhooks or scheduled checks.
- **Self-contained web portal:** Configure connections, AI providers, policies, and optional form sign-in from the browser—no container shell access required.

## Quick Start

### TrueNAS (Community Catalog)

Install **Plex Repairman** directly from **Apps → Discover Apps** in TrueNAS (Community train). See [packaging/truenas/README.md](packaging/truenas/README.md) for catalog details.

### Docker Compose

Create a `compose.yml` using the published GitHub Container Registry image (`ghcr.io/chrisstoll1/plex-repair-discord-bot:latest`, or pin a stable release tag such as `:0.2.3`):

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

Start the container and open `http://<host>:3000`:

```bash
docker compose up -d
```

The container runs as non-root (`1000:1000` by default; `568:568` in the TrueNAS catalog) and needs no host media mounts, Docker socket, GPU, or privileged mode.

## First-Time Setup

1. Open `http://<host>:3000` in your browser. Optionally enable **Require sign-in** under **Settings → Security**.
2. Open **Settings → Discord** and enter your Discord bot token (with `Message Content Intent` enabled), optional application ID, and any guild/channel/role restrictions.
3. Open **Settings → Connections** and enter your Plex, Sonarr, Radarr, and optional Seerr URLs and credentials. Optionally configure **Automatic progress events** for Sonarr/Radarr webhooks.
4. Open **Settings → AI** to connect one or more AI providers (OAuth, API key, or custom endpoint), choose your primary and fallback models, and click **Test** to verify connectivity.
5. Review **Settings → Repair policy** (confirmations, destructive actions, direct additions), then check **Overview** to confirm every service is healthy.

See [Setup Guide](docs/setup.md) and [AI Providers & Models](docs/ai-providers.md) for full details.

## Example Requests

Mention the bot in an allowed Discord channel to start a repair thread:

```text
@Plex Repairman why is Dune missing?
```

```text
@Plex Repairman Plex does not show Chainsaw Man episode 3. Check Sonarr and Plex.
```

```text
@Plex Repairman find a dual-audio replacement for Jujutsu Kaisen S01E10
```

```text
@Plex Repairman refresh my Plex TV library
```

## Documentation

Browse the guides in `docs/` (also mirrored to the [GitHub Wiki](https://github.com/chrisstoll1/plex-repair-discord-bot/wiki)):

| Guide | What it covers |
| --- | --- |
| [Setup Guide](docs/setup.md) | Discord Developer Portal setup, Plex/Sonarr/Radarr/Seerr connections, Seerr user mappings, and Arr webhooks |
| [AI Providers & Models](docs/ai-providers.md) | OAuth, API keys, custom endpoints, ordered fallback hierarchy, connectivity testing, thinking level, and timeouts |
| [Repairs, Safety & Policies](docs/repairs-and-safety.md) | Policy toggles, Plex scanner log diagnostics, Split Apart / Fix Match, manual imports, Seerr requests, and thread lifecycle |
| [Operations & Troubleshooting](docs/operations.md) | Environment variables, `/config` files, portal sign-in, reverse proxies, backups, upgrades, image tags, password recovery, and troubleshooting |
| [Development & CI](docs/development.md) | Local Node 24 + Vite workflow, tests, audits, container/catalog validation, and weekly Pi SDK updates |
| [Security Policy](SECURITY.md) | Security model, session/CSRF protections, and vulnerability reporting |
| [Changelog](CHANGELOG.md) | Release history and version notes |
| [TrueNAS Catalog Package](packaging/truenas/README.md) | TrueNAS Community catalog packaging and validation |

## Upgrading and Backup

Stop the container before backing up or taking a dataset snapshot of `/config`. Always back up and restore the entire `/config` directory together (`plex-repairman.db` plus any WAL/SHM files, `secrets.key`, and `pi/`)—losing `secrets.key` makes encrypted credentials in the database unrecoverable.

See [Operations & Troubleshooting](docs/operations.md#backups-upgrades-and-rollback) for full upgrade, 0.1→0.2 migration, rollback, and offline password-recovery instructions.

## License

MIT — see [LICENSE](LICENSE).

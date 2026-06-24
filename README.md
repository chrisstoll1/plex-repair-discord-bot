# Plex Repairman

Plex Repairman is a mention-driven Discord bot for diagnosing and repairing Plex, Sonarr, and Radarr media issues. It uses Pi Coding Agent as the AI agent runtime so private deployments can use Codex subscription authentication.

## Current Status

This repository is in early implementation. The current slice includes:

- TypeScript/Node application skeleton.
- No-auth Fastify web portal intended for reverse-proxy protection.
- Encrypted SQLite-backed settings.
- Discord token configuration through the portal.
- Sonarr/Radarr/Plex connection settings and health checks.
- Discord mention handling.
- Pi SDK agent wrapper with initial custom tools.
- Portal-based OpenAI Codex device-code auth for Pi.
- Dockerfile and GHCR build workflow.

## Development

```bash
npm install
npm run dev
```

By default local config is stored in `./config`. In containers, use `/config` as a persistent volume.

The Pi SDK requires Node `>=22.19.0`. If your local Node is older, use Docker Desktop.

## Docker Desktop

```bash
docker compose up --build
```

Open `http://localhost:3000`. The compose setup stores persistent app data in `./config`, mounted as `/config` in the container.

To stop the app:

```bash
docker compose down
```

## Portal

Open `http://localhost:3000` and configure Discord, Sonarr, Radarr, Plex, and Pi settings.

The portal intentionally has no built-in authentication yet. Put it behind a reverse proxy with access controls.

Discord DMs are disabled by default. Enable `Allow Direct Messages` in settings if you want private messages to be handled as bot requests without requiring an `@` mention.

## Pi Codex Auth

Open `http://localhost:3000/pi-auth` and start the OpenAI Codex login flow. The portal uses device-code auth, so no public OAuth callback URL is required.

Pi credentials are persisted under the configured Pi agent directory, defaulting to `/config/pi/auth.json` in containers.

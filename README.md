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
- Dockerfile and GHCR build workflow.

## Development

```bash
npm install
npm run dev
```

By default local config is stored in `./config`. In containers, use `/config` as a persistent volume.

## Portal

Open `http://localhost:3000` and configure Discord, Sonarr, Radarr, Plex, and Pi settings.

The portal intentionally has no built-in authentication yet. Put it behind a reverse proxy with access controls.

## Pi Codex Auth

Pi credentials should be persisted under the configured Pi agent directory, defaulting to `/config/pi` in containers. Until a first-class portal OAuth flow is added, run a one-time Pi login flow and preserve `/config/pi/auth.json`.

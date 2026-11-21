# Operations & Troubleshooting

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `CONFIG_DIR` | `./config` | Persistent application data directory (the container sets `/config`). |
| `HTTP_HOST` | `0.0.0.0` | Web server bind address. |
| `HTTP_PORT` | `3000` | Web server port. |
| `LOG_LEVEL` | `info` | Pino log level (`debug`, `info`, `warn`, `error`). |
| `PORTAL_SECURE_COOKIE` | `false` | Set to `true` when serving the portal strictly over HTTPS (secure cookies are not sent over plain HTTP). |

## Persistent Files (`/config`)

| Path | Contents |
| --- | --- |
| `/config/plex-repairman.db` | Settings, encrypted credentials, repair-thread history, wake conditions, delivery state, processed messages, and agent-task history (plus SQLite `-wal` / `-shm` files while running). |
| `/config/secrets.key` | Local encryption key for Discord and media-service credentials. |
| `/config/pi/auth.json` | Pi AI provider OAuth tokens and API keys. |
| `/config/pi/models.json` | Custom OpenAI/Anthropic-compatible provider definitions (when configured). |
| `/config/pi/models-store.json` (or `models-catalog.json`) | Cached Pi remote model catalog overlay. |

Ordinary settings and retained repair/task logs are not encrypted. `plex-repairman.db` and `secrets.key` belong together—losing `secrets.key` makes encrypted credentials in the database unrecoverable.

## Health Endpoint

```text
GET http://<host>:3000/health
```

Returns `200 {"ok":true}` whenever the web server is alive. It intentionally does not fail when Discord, media services, or AI providers are unconfigured so container orchestrators do not enter restart loops during initial setup.

## Portal Sign-In & Reverse Proxies

Portal sign-in is optional and off by default for new installs. When off, anyone who can reach the portal can manage credentials, policies, and retained data—keep it on a trusted network, behind an authenticated HTTPS reverse proxy, or enable **Require sign-in** under **Settings → Security**.

When **Require sign-in** is enabled:

- Login uses a form with `HttpOnly`, `SameSite=Strict` cookies that expire after 12 hours or on container restart.
- Passwords must be at least 8 characters and are hashed with scrypt before encryption. Changing security settings requires the current password, rotates the saving browser's session, and revokes other sessions.
- State-changing API requests require `X-Repairman-Request: 1`, and authenticated mutations also require the session CSRF token. No cross-origin access is granted.
- `/health` stays public and Arr webhooks use their own secret URLs.
- Application sessions do not read the `Authorization` header, so an existing reverse-proxy Basic login can remain enabled with separate credentials.

When putting Plex Repairman behind a reverse proxy:

- Use HTTPS and set `PORTAL_SECURE_COOKIE=true`.
- Disable proxy caching for portal HTML and `/api` routes.
- Do not log request bodies, cookies, CSRF tokens, `Authorization` headers, or webhook URLs.

See [SECURITY.md](../SECURITY.md) for the complete security model.

### Offline Password Recovery

If you lose portal sign-in credentials, stop the container, run the reset helper against the same `/config` volume and runtime UID/GID, and restart:

```bash
docker compose stop plex-repairman
docker compose run --rm --no-deps --entrypoint node plex-repairman scripts/reset-portal-password.mjs --confirm
docker compose up -d plex-repairman
```

This disables portal sign-in and clears only the portal login credentials without touching `plex-repairman.db` settings, repair history, `secrets.key`, or AI auth. On TrueNAS, run a temporary container with the same image, UID/GID, and `/config` dataset while the app is stopped.

## Backups, Upgrades, and Rollback

### Backups

1. Stop the app before copying `/config` (or take an atomic dataset snapshot while stopped).
2. Back up the entire `/config` directory as a unit—SQLite database, WAL/SHM files, `secrets.key`, and `pi/`.
3. Restore the entire directory together. Never mix a database from one backup with a `secrets.key` from another.

### Upgrading

- **0.2.x → 0.2.3:** Stop or pull the new image and start it with the same `/config` volume. Existing settings, credentials, AI auth, and repair history carry forward automatically.
- **0.2.0 / 0.2.1 → 0.2.2+:** Completed 0.2.0/0.2.1 portal credentials migrate automatically to form sign-in (username `admin` for 0.2.0; saved username for 0.2.1). Existing browser sessions must sign in again.
- **0.1.x → 0.2.x:**
  1. Stop the app and back up `/config`.
  2. Grant the non-root container UID/GID read/write access to `/config` (`1000:1000` for standard Docker; `568:568` for TrueNAS catalog defaults—do not change permissions on your media datasets).
  3. Start the new image, verify `/health`, check **Settings → Security**, and confirm services on **Overview**.

### Rollback

Stop the app, restore the pre-upgrade `/config` backup in full, and switch back to the previous exact image tag or digest. Avoid running an older image against a database already opened by a newer version.

## Container Image Tags

Images are validated before publication in GitHub Actions:

| Tag | Meaning |
| --- | --- |
| `latest` | Latest build from `master` |
| `<version>` (e.g. `0.2.3`) | Stable release published from a matching `v<version>` Git tag on `master` |
| `<version>-build.<run>.<attempt>` | Automatic branch build from `master` |
| `build-<run>.<attempt>` | Exact workflow run attempt |
| `sha-<commit-sha>` | Build for a specific commit |

The portal sidebar displays the running version (`dev` for local builds). Pin a stable version tag or manifest digest when reproducible deployments and rollbacks matter.

## Troubleshooting

### Bot connects to Discord but ignores messages

- Confirm **Message Content Intent** is enabled in the Discord Developer Portal under **Bot → Privileged Gateway Intents**.
- Check **Allowed guild IDs** and **Allowed channel IDs** under **Settings → Discord** (blank allows all).
- In servers, a new repair requires `@mentioning` the bot. DMs are ignored unless **Allow direct messages** is enabled.
- Verify the bot has **Create Public Threads**, **Send Messages in Threads**, and **Read Message History** permissions in that channel.

### Plex scanner log diagnostics fail with HTTP 401/403

- Plex's `/diagnostics/logs` endpoint requires an **administrator** `X-Plex-Token`. Managed/shared user tokens cannot download server logs.

### AI model shows `(Unavailable)` or test fails

- Click **Test** next to the model in **Settings → AI** to inspect the exact provider error (billing/quota exhaustion, invalid API key, unsupported model, or expired OAuth token).
- For OAuth providers showing a refresh failure, click **Reconnect OAuth** on the provider card in **Settings → AI**.
- Ensure the container can reach `https://pi.dev` if relying on newly released models from Pi's remote catalog overlay, and confirm `/config/pi` is writable by the container's runtime UID/GID.

### Portal sign-in loop behind a reverse proxy

- If accessing over plain HTTP (not HTTPS), ensure `PORTAL_SECURE_COOKIE` is `false` (default)—browsers refuse to send `Secure` cookies over HTTP.
- If accessing over HTTPS, set `PORTAL_SECURE_COOKIE=true` and disable caching on `/api` routes in your reverse proxy.

### Sonarr/Radarr webhooks never wake waiting repairs

- Confirm the **Public Repairman URL** under **Settings → Connections → Automatic progress events** is reachable *from* the Sonarr/Radarr containers (not `localhost` unless sharing a network namespace).
- Verify the webhook URL copied into Sonarr/Radarr matches the current secret (rotating the secret invalidates earlier URLs) and that grab/import/upgrade/rename/manual-interaction triggers are enabled.

### Permission errors on `/config` after switching to non-root

- Standard Docker runs as UID/GID `1000:1000`; the TrueNAS catalog defaults to `568:568`. Ensure the mounted host path or dataset grants read/write access to that UID/GID.

# Security

Report suspected vulnerabilities privately using [GitHub private vulnerability reporting](https://github.com/chrisstoll1/plex-repair-discord-bot/security/advisories/new). If that feature is unavailable, open an issue requesting a private reporting channel without publishing exploit details or credentials.

The portal is a single-administrator interface with the authority to change media-service credentials, repair policy and retained data. Its password is hashed with a random salt and scrypt (N=131072, r=8, p=1), then encrypted in the settings database. Sessions are random, held in memory, expire after 12 hours and are revoked by logout, password changes or application restarts. State-changing administration requests require a custom request header and a session-specific CSRF token. No cross-origin access is granted.

First-time setup requires a random token saved with owner-only permissions in `/config/portal-setup-token`; the token is removed after the administrator is created. Access to the configuration volume is equivalent to administrative access. Anyone who can replace the database, encryption key or AI authentication files can control this application. Keep backups private.

Use HTTPS when accessing the portal outside a trusted local network. Set `PORTAL_SECURE_COOKIE=true` behind an HTTPS reverse proxy. Forward `/api` unchanged, disable proxy caching for it and do not log request bodies, cookies, authorization headers or webhook URLs. The application does not trust forwarded headers for client IPs, so sign-in throttling behind a proxy applies to that proxy's address.

`/health` deliberately remains public and only checks process liveness. Sonarr/Radarr webhooks authenticate with their own generated secret URL; do not publish those URLs. The rest of the administration API requires a portal session. Basic authentication at an existing reverse proxy can remain enabled as an additional layer.

Repairs follow Discord role and confirmation policies. Destructive repairs and direct additions are disabled by default. The application requires no TrueNAS management API, Docker socket, privileged mode or host media mounts. Optional repair actions can still change or delete media through the configured services when an administrator enables them.

Both npm dependency trees are audited in CI. Use a supported Node release (Node 24 recommended; minimum 22.19). Published Docker images include the runtime; no host Node installation is required.

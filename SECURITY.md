# Security

Report suspected vulnerabilities privately using [GitHub private vulnerability reporting](https://github.com/chrisstoll1/plex-repair-discord-bot/security/advisories/new). If that feature is unavailable, open an issue requesting a private reporting channel without publishing exploit details or credentials.

Portal sign-in is optional and defaults off for new installations. Anyone who can reach an unprotected portal can change service credentials, repair policy and retained data. Use a trusted network, an authenticated reverse proxy, or enable **Require sign-in** in **Settings > Security**. Use HTTPS for remote access.

When enabled, a form login authenticates administration APIs through random, in-memory sessions. Public HTML/assets contain the sign-in shell, not private administration data. Session cookies are HttpOnly, SameSite=Strict, expire after 12 hours, and are revoked by sign-out, restart or security-setting changes. Set `PORTAL_SECURE_COOKIE=true` for HTTPS-only cookies. Only a digest of the random cookie is held in memory; cookies and passwords are not logged or stored in browser local storage. A separate session CSRF token is required for authenticated mutations. Sessions are bounded to 20; sign-in throttling and concurrent hashing limits bound login work.

Passwords are hashed with a random salt and scrypt (N=131072, r=8, p=1), then encrypted in the settings database. Passwords and hashes are never returned by the settings API. Changing security settings requires the current password when sign-in is enabled. Successful changes revoke other sessions and rotate the saving browser's session. Failed authentication is throttled; forwarded headers are not trusted, so users behind a proxy share its rate limit.

All state-changing administration requests, including form login, require `X-Repairman-Request: 1`; cross-site browser mutations are rejected. The server grants no cross-origin access. These checks also apply when authentication is off. `/health` remains public for process liveness checks. Sonarr/Radarr webhooks use their own secret URLs and remain independent of portal sessions; do not publish those URLs.

Application sessions do not consume the Authorization header, so a reverse proxy can independently use Basic authentication with different credentials. Disable proxy caching and do not log request bodies, cookies, CSRF tokens, Authorization headers or webhook URLs.

Existing 0.2.1 application Basic credentials migrate to form login with the same username, password and enabled state. Completed 0.2.0 administrator accounts migrate with username `admin`. Unfinished setups remain open by default and unused setup tokens are removed. Invalid saved authentication fails closed. Lost credentials can be cleared with the offline reset helper while the app is stopped; see README.md.

Access to `/config` is equivalent to administrative access. Keep its database, encryption key, AI authentication and complete backups private. Restoring only the database without its matching key makes encrypted credentials unrecoverable.

Repairs follow Discord role and confirmation policies. Destructive repairs and direct additions are disabled by default. The app requires no TrueNAS management API, Docker socket, privileged mode or host media mounts. Optional repairs can change or delete media through the configured services when an administrator enables them.

Both npm dependency trees are audited in CI. Use a supported Node release (Node 24 recommended; minimum 22.19). Published Docker images include the runtime.

The frontend audit temporarily accepts only [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), which currently has no patched picomatch release, until December 1, 2026. Every affected dependency must be marked development-only in the lockfile; production dependencies and unrelated advisories still fail CI. The frontend build tools consume repository-controlled glob configuration, not portal input, and are not included in the runtime image. Remove this exception when a fixed release is available.

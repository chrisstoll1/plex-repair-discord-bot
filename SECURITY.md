# Security

Report suspected vulnerabilities privately using [GitHub private vulnerability reporting](https://github.com/chrisstoll1/plex-repair-discord-bot/security/advisories/new). If that feature is unavailable, open an issue requesting a private reporting channel without publishing exploit details or credentials.

Portal authentication is optional and defaults off for new installations. Anyone who can reach an unprotected portal can change service credentials, repair policy and retained data. Use a trusted network, an authenticated reverse proxy, or enable **Basic authentication** in **Bot settings > Portal access**. Use HTTPS for remote access: HTTP Basic authentication encodes credentials, but does not encrypt them in transit.

When enabled, Basic authentication protects portal HTML, assets and administration APIs using the browser's standard sign-in prompt. Passwords are hashed with a random salt and scrypt (N=131072, r=8, p=1), then encrypted in the settings database. Passwords and hashes are never returned by the settings API. Validated credentials are cached briefly using a keyed digest, without storing plaintext request credentials. Changing the username/password or authentication toggle immediately invalidates that cache. Failed authentication is throttled; forwarded headers are not trusted, so users behind a proxy share its rate limit.

State-changing administration requests require `X-Repairman-Request: 1`, and cross-site browser mutations are rejected. The server grants no cross-origin access. These checks also apply when authentication is off. `/health` remains public for process liveness checks. Sonarr/Radarr webhooks use their own generated secret URLs and are exempt from portal Basic auth; do not publish those URLs.

Use one Basic-auth layer per URL. A reverse proxy and the application both consume the Authorization header; different credentials at those layers cause repeated challenges. Leave the application toggle off if the proxy already handles authentication. Disable proxy caching and do not log request bodies, cookies, Authorization headers or webhook URLs. Basic-auth credential caching is managed by the browser; there is no application session or sign-out control.

Existing completed 0.2.0 administrator accounts migrate to enabled Basic auth with username `admin` and the same password. Unfinished setup no longer blocks the portal; its unused setup-token file is removed. The old session cookie and secure-cookie setting are no longer used. Lost credentials can be cleared with the offline reset helper while the app is stopped; see README.md.

Access to `/config` is equivalent to administrative access. Keep its database, encryption key, AI authentication and complete backups private. Restoring only the database without its matching key makes encrypted credentials unrecoverable.

Repairs follow Discord role and confirmation policies. Destructive repairs and direct additions are disabled by default. The app requires no TrueNAS management API, Docker socket, privileged mode or host media mounts. Optional repairs can change or delete media through the configured services when an administrator enables them.

Both npm dependency trees are audited in CI. Use a supported Node release (Node 24 recommended; minimum 22.19). Published Docker images include the runtime.

The frontend audit temporarily accepts only [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), which currently has no patched picomatch release, until December 1, 2026. Every affected dependency must be marked development-only in the lockfile; production dependencies and unrelated advisories still fail CI. The frontend build tools consume repository-controlled glob configuration, not portal input, and are not included in the runtime image. Remove this exception when a fixed release is available.

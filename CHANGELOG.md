# Changelog

## 0.2.1

- Replace mandatory administrator setup and session login with optional HTTP Basic authentication, configured by a toggle and username/password fields in Bot settings. Authentication defaults off for fresh installs.
- Remove setup-token provisioning, the account page and session-cookie configuration. Existing completed 0.2.0 accounts migrate to enabled Basic auth as admin with the same password; unfinished setups open normally.
- Retain password hashing, login throttling, request forgery protection and offline recovery. Update catalog configuration, installation tests and documentation for the simpler flow.

## 0.2.0

- Require a portal administrator password. First-time setup uses a one-time token from the configuration volume; existing bot settings, credentials and repair history remain intact.
- Add expiring sessions, sign-out, password changes, request forgery protection, login throttling and offline password recovery.
- Run the container as a non-root user. The development Compose and TrueNAS package use a read-only application filesystem and drop Linux capabilities.
- Update vulnerable server, frontend and build dependencies, and audit both dependency trees in CI.
- Bundle portal fonts locally and add browser security headers.
- Add a TrueNAS community catalog definition with managed or host-path storage, configurable UID/GID, networking, resources and installation tests.
- Check fresh installs, upgrades, restart persistence and recovery before publishing images.
- Publish stable version tags from matching `v<version>` Git tags. Branch builds use `<version>-build.<run>.<attempt>`; existing exact build and source tags remain available.

Before upgrading from 0.1 builds, follow the [upgrade instructions](README.md#upgrading-and-backup) for configuration ownership and administrator setup.

## 0.1 series

Initial Discord repair workflows, persistent repair cases, webhooks, Plex scanner and movie match diagnostics, Seerr requests and scoped request repair controls. See the [commit history](https://github.com/chrisstoll1/plex-repair-discord-bot/commits/master/) for individual builds.

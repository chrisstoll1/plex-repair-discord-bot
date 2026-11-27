# Changelog

## 0.2.4

- Find and repair future-dated Plex entries that keep TV shows and movies stuck in Recently Added. The repair uses the configured role and confirmation policy and checks the resulting dates in Plex.
- Update the Pi Coding Agent SDK to 1.6.0.

## 0.2.3

- Add multi-provider AI authentication supporting OAuth sign-in (OpenAI Codex, Anthropic, GitHub Copilot, xAI, Kimi), API keys (Anthropic, OpenAI, Google Gemini, OpenRouter, xAI, DeepSeek, Groq, Mistral, GitHub Copilot, Kimi), and custom OpenAI/Anthropic-compatible endpoints.
- Add an ordered primary and fallback model hierarchy with automatic runtime fallback, live Pi remote model catalog support, and inline connectivity testing on each configured model row.
- Record and display the actual AI model and fallback usage on Overview, Repairs, repair timelines, and Agent tasks.
- Refine Settings layouts with full-width AI model hierarchy and side-by-side thinking, service tier, and timeout controls, plus a consistent full-width bottom save bar across all Settings tabs including unified Connections and webhook saving.
- Recover cleanly from local Pi credential synchronization errors and clear stale refresh errors once valid credentials are stored.

## 0.2.2

- Paginate repairs, agent tasks and repair timelines, with complete history counts and repair status filters across all records. Keep toggles at a fixed size and show disconnected AI accounts in red.
- Replace browser Basic prompts with optional form sign-in, expiring sessions, explicit sign-out and CSRF protection. Preserve configured 0.2.0/0.2.1 credentials and coexist with reverse-proxy authentication.
- Reorganize administration into Overview, Repairs, Agent tasks and Settings, with Connections, Discord, AI, Repair policy and Security sections. Move portal access out of bot settings and keep old URLs working.
- Add password confirmation, current-password verification and consistent save/reset/unsaved-change behavior for security settings. Keep the saving browser signed in when enabling or changing login.

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

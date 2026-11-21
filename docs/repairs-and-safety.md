# Repairs, Safety & Policies

Plex Repairman separates read-only diagnosis from write actions. Policy checks run on the server every time a write tool executes—not just in the prompt.

## Policy Controls (**Settings → Repair policy** & **Settings → Discord**)

| Setting | Default | Effect |
| --- | --- | --- |
| **Require confirmation** | **On** | Posts temporary Discord **Confirm** / **Cancel** buttons describing one exact server-verified action before executing it. Turning this off allows direct non-destructive repairs for users who satisfy your repair-role policy. |
| **Allow destructive repairs** | **Off** | Required for queue removal, file deletion, movie/series removal, or removing an existing Seerr request during a replacement. |
| **Allow direct Sonarr/Radarr additions** | **Off** | Permits adding a new movie to Radarr or series to Sonarr directly using existing root folders and quality profiles. Does not affect repairs on existing media. |
| **Prefer Seerr for new requests** *(under Connections → Seerr)* | **On** | Routes new media requests through Seerr whenever Seerr is configured. Direct Sonarr/Radarr additions are blocked while this is on, so Seerr approvals and quotas cannot be bypassed. |
| **Repair role IDs** *(under Settings → Discord)* | Blank (all allowed) | Restricts write/repair actions to Discord members who currently hold at least one listed role. Role membership is checked per participant on each request. |

## What Plex Repairman Can Do

### Diagnosis (Read-Only)

- Compare Plex availability against Sonarr and Radarr items, queues, history, files, and available releases for movies, series, seasons, episodes, specials, and anime.
- Inspect Plex scanner, matcher, analysis, and server logs via Plex's `/diagnostics/logs` ZIP API without mounting Plex directories on the host:
  - Logs are read strictly in memory and never extracted to disk; tokens are redacted.
  - Enforces hard safety limits: 32 MiB archive download cap, 16 MiB per log file, 64 MiB total selected logs, 2,000 archive entries.
  - Time filters use Plex server local time (`YYYY-MM-DDTHH:mm:ss` without a timezone suffix). Missing or rotated logs cannot prove a file was scanned or healthy; the tool does not toggle Plex logging or start scans.
- Inspect compact Plex movie identities, parts, and file versions to spot incorrectly merged or mismatched movies.
- Inspect Seerr request status, destinations, quality profiles, and approval state.

### Repairs (Policy-Gated)

- **Search & grab:** Search indexers, grab releases, monitor/unmonitor items, and refresh Plex libraries.
- **Manual imports & renames:** Preview and execute Sonarr/Radarr manual imports with explicit media mappings and import modes, and preview file renames before applying them.
- **Plex movie match fixes:**
  - **Split Apart** requires a current snapshot of every part ID and file path, never deletes media, and rediscovers item IDs by file path to verify both movies afterward.
  - **Fix Match** requires one isolated part and an exact verified TMDB/IMDb identity via the modern Plex Movie agent.
- **Seerr requests:** Request new movies and TV seasons, edit pending request destinations, retry failed requests, and replace explicitly authorized 4K/standard requests after verifying the replacement (Seerr does not support changing an approved request's quality scope in place; removal follows destructive-repair policy and never requests media/file deletion).
- **Direct additions:** Add movies to Radarr or series to Sonarr with existing roots/profiles and requested TV-season scope when **Allow direct Sonarr/Radarr additions** is enabled and **Prefer Seerr** is off.

## Durable Repair Threads & Automatic Resume

- Mentioning the bot in a server channel creates a dedicated public Discord thread bound to one persistent repair case.
- Follow-up messages from any participant in an active repair thread are handled without needing another `@mention`; each participant's current Discord roles are checked for actions requested on their behalf. Separate issue threads run concurrently.
- Complete conversation context is stored in `/config/plex-repairman.db` and survives container restarts. Older turns are compacted for model prompts when needed while remaining accessible via case history.
- When confirmation is off and a repair waits on external work (such as a download or upcoming release):
  - Configured Sonarr/Radarr webhooks resume the case immediately on matching grab, import, upgrade, rename, or manual-interaction events (with event replay for events arriving right before a wait is recorded).
  - A 2-hour fallback check catches missed events.
  - For unreleased media with an exact service release timestamp, the fallback waits until 1 hour after release (with a 7-day verification window); matching webhooks can still wake it earlier.
  - Unchanged automatic checks stay quiet, back off to at most once per day, and do not spend repair attempts.
  - Disabling a webhook converts its event waits into timers while preserving planned check times.

## Web Portal Navigation

The portal sidebar separates daily monitoring from configuration:

- **Overview:** Live connectivity status for Discord, Plex, Sonarr, Radarr, Seerr, and AI providers.
- **Repairs:** Paginated repair cases (10/25/50 per page) with full-history status filters, model attribution, and paginated per-case timelines (20 entries per page, newest first).
- **Agent tasks:** Paginated history of queued, running, and completed service worker tasks, including model attribution.
- **Settings:** Organized into **Connections**, **Discord**, **AI**, **Repair policy**, and **Security** tabs, each with unsaved-change protection and a consistent bottom Save/Reset bar. (Legacy `/connections`, `/bot-settings`, and `/account` links redirect automatically.)

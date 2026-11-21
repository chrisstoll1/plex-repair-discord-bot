# Setup Guide

This guide walks through configuring Discord, Plex, Sonarr, Radarr, Seerr, and automatic progress webhooks after starting Plex Repairman.

The web portal stays available even when Discord or media services are not yet configured or fail to connect, so you can fix credentials directly in the browser.

## 1. Discord Setup (**Settings → Discord**)

### Create the Discord Application and Bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Under **Bot**:
   - Copy the **Bot Token**.
   - Enable **Message Content Intent** under **Privileged Gateway Intents**.
3. Under **General Information**, optionally copy the **Application ID** (used to register the global `/health` slash command).
4. Under **OAuth2 → URL Generator**, select the `bot` scope (and `applications.commands` if registering `/health`) with these permissions:
   - View Channels
   - Read Message History
   - Send Messages
   - Create Public Threads
   - Send Messages in Threads
   - Manage Threads
   - Add Reactions
5. Invite the bot to your Discord server using the generated URL.

### Configure Discord in the Portal

Open **Settings → Discord** and fill in:

| Setting | Description |
| --- | --- |
| **Bot token** | Required. Encrypted at rest in `/config/plex-repairman.db`. |
| **Application ID** | Optional. Enables the global `/health` slash command (`Plex Repairman is online.`). |
| **Allowed guild IDs** | Optional comma-separated Discord server IDs. Leave blank to allow any server the bot joins. |
| **Allowed channel IDs** | Optional comma-separated channel IDs (applies to parent channels for threads). Leave blank to allow any channel. |
| **Repair role IDs** | Optional comma-separated Discord role IDs required to authorize write/repair actions. Leave blank to allow any user who can reach the bot. |
| **Allow direct messages** | Off by default. Enable to accept repair requests via Discord DMs. |
| **Reactions enabled** | On by default. Shows lightweight status reactions while working or waiting. |

## 2. Media Services (**Settings → Connections**)

Use direct Docker or LAN URLs reachable from the Plex Repairman container (for example `http://plex:32400`, `http://sonarr:8989`, `http://radarr:7878`, `http://seerr:5055`). Avoid routing service API calls through public tunnels or slow proxies, which may time out during long release lookups.

### Plex

- **Server URL:** Reachable Plex Media Server URL (e.g., `http://plex.local:32400`).
- **Plex token:** An administrator `X-Plex-Token`. Administrator log-download access is required if you want Plex Repairman to inspect `/diagnostics/logs` for scanner and matching issues. No host filesystem mount to Plex is required.

### Sonarr & Radarr

- **Server URL:** Reachable Sonarr or Radarr URL (including any URL base if configured).
- **API key:** Found in Sonarr/Radarr under **Settings → General → Security**.

### Seerr (Optional)

Seerr integration lets Plex Repairman inspect, create, edit, retry, and replace media requests while honoring each user's Seerr permissions, approval rules, and quotas.

| Setting | Description |
| --- | --- |
| **Seerr URL & API key** | Reachable Jellyseerr/Overseerr/Seerr URL and API key. The API key is encrypted at rest and never returned by the settings API. |
| **Prefer Seerr for new requests** | On by default. Routes new movie/TV requests through Seerr instead of direct Sonarr/Radarr additions. Turn off only if you want direct additions (with **Allow direct Sonarr/Radarr additions** enabled in **Settings → Repair policy**). |
| **Default Seerr user ID** | Optional shared Seerr user ID for Discord users who are not linked to a Seerr account. Set to `0` to require every requesting user to be linked. |
| **Discord user mappings** | Optional explicit `DiscordID:SeerrUserID` overrides, one per line or comma-separated. Otherwise Plex Repairman resolves users by the Discord ID saved in their Seerr notification settings. |

Requests use Seerr's configured server and quality-profile defaults. Preferred Seerr approvals, quotas, and denials cannot be bypassed with direct additions.

## 3. Automatic Progress Events (Webhooks)

Webhooks let waiting repairs resume immediately when Sonarr or Radarr grabs, imports, upgrades, renames, or flags a download for manual interaction—instead of waiting for the 2-hour fallback check.

1. At the bottom of **Settings → Connections**, open **Automatic progress events**.
2. Enter the **Public Repairman URL** that Sonarr and Radarr can reach (a Docker/LAN address such as `http://plex-repairman:3000` is fine; it only needs to be reachable from Sonarr/Radarr, not the public internet).
3. Enable **Sonarr** and/or **Radarr** webhooks and click **Save changes** in the bottom save bar.
4. Copy each generated secret webhook URL.
5. In Sonarr and/or Radarr, open **Settings → Connect → Add Connection → Webhook**, paste the URL, and enable:
   - On Grab
   - On Import / On Download
   - On Upgrade
   - On Rename
   - On Manual Interaction Required

Use **Rotate secret** in the webhook card header at any time to invalidate old webhook URLs and generate fresh ones. Keep webhook URLs private—they authenticate webhook deliveries independently of portal sign-in.

## Next Steps

- Connect one or more AI providers and test your models in [AI Providers & Models](ai-providers.md).
- Review confirmation and destructive-action policies in [Repairs, Safety & Policies](repairs-and-safety.md).
- Verify all checks on **Overview** before inviting users to mention the bot.

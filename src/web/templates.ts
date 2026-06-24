import type { PiAuthSnapshot } from "../agent/pi-auth.js";
import type { RuntimeSettings } from "../domain/settings.js";

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - Plex Repairman</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #0e1116; color: #eef2ff; }
    body { margin: 0; }
    main { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
    nav { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 28px; }
    a { color: #8bd3ff; }
    .panel { background: #171c26; border: 1px solid #293241; border-radius: 16px; padding: 22px; margin-bottom: 18px; box-shadow: 0 12px 30px rgba(0,0,0,.22); }
    label { display: block; margin: 14px 0 6px; color: #b9c3d6; }
    input, select { width: 100%; box-sizing: border-box; padding: 11px 12px; border: 1px solid #3a4658; border-radius: 10px; background: #0f141d; color: #eef2ff; }
    button { margin-top: 18px; border: 0; border-radius: 10px; padding: 11px 16px; color: #061018; background: #8bd3ff; font-weight: 700; cursor: pointer; }
    button.danger { background: #ff8b8b; }
    code, pre { background: #0b0f16; border-radius: 8px; }
    pre { padding: 14px; overflow: auto; }
    form.inline { display: inline-block; margin-right: 10px; }
    form.inline button { margin-top: 0; }
    .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
    .muted { color: #9aa7bb; }
  </style>
</head>
<body>
  <main>
    <h1>Plex Repairman</h1>
    <nav>
      <a href="/">Dashboard</a>
      <a href="/settings">Settings</a>
      <a href="/pi-auth">Pi Auth</a>
      <a href="/health">Health</a>
    </nav>
    ${body}
  </main>
</body>
</html>`;
}

export function dashboard(settings: RuntimeSettings, piAuthConfigured: boolean): string {
  return layout(
    "Dashboard",
    `<section class="grid">
      ${statusCard("Discord", Boolean(settings.discord.token), "Token configured through portal")}
      ${statusCard("Sonarr", Boolean(settings.sonarr.url && settings.sonarr.apiKey), settings.sonarr.url || "Not configured")}
      ${statusCard("Radarr", Boolean(settings.radarr.url && settings.radarr.apiKey), settings.radarr.url || "Not configured")}
      ${statusCard("Plex", Boolean(settings.plex.url && settings.plex.token), settings.plex.url || "Not configured")}
      ${statusCard("Pi Auth", piAuthConfigured, piAuthConfigured ? "auth.json present" : "Connect Pi/Codex auth")}
    </section>
    <section class="panel">
      <h2>Usage</h2>
      <p>Mention the bot in Discord after configuration: <code>@Plex Repairman why is Dune missing?</code></p>
      <p><a href="/pi-auth">Connect Pi/Codex auth</a></p>
      <p class="muted">This portal intentionally has no built-in authentication. Put it behind your reverse proxy access controls.</p>
    </section>`,
  );
}

export function settingsPage(settings: RuntimeSettings): string {
  return layout(
    "Settings",
    `<form method="post" action="/settings" class="panel">
      <h2>Discord</h2>
      <label>Bot Token</label>
      <input name="discordToken" type="password" placeholder="Leave blank to keep existing token">
      <label>Application ID</label>
      <input name="discordApplicationId" value="${escapeHtml(settings.discord.applicationId ?? "")}">
      <label>Allowed Guild IDs (comma separated, blank allows all)</label>
      <input name="discordAllowedGuildIds" value="${escapeHtml(settings.discord.allowedGuildIds)}">
      <label>Allowed Channel IDs (comma separated, blank allows all)</label>
      <input name="discordAllowedChannelIds" value="${escapeHtml(settings.discord.allowedChannelIds)}">
      <label>Repair Role IDs (comma separated)</label>
      <input name="discordRepairRoleIds" value="${escapeHtml(settings.discord.repairRoleIds)}">
      <label><input name="discordAllowDirectMessages" type="checkbox" value="true" ${settings.discord.allowDirectMessages ? "checked" : ""} style="width:auto"> Allow Direct Messages</label>
      <p class="muted">When enabled, DM messages are treated as bot requests without requiring an @ mention.</p>

      <h2>Sonarr</h2>
      <label>URL</label>
      <input name="sonarrUrl" value="${escapeHtml(settings.sonarr.url ?? "")}" placeholder="http://sonarr:8989">
      <label>API Key</label>
      <input name="sonarrApiKey" type="password" placeholder="Leave blank to keep existing key">

      <h2>Radarr</h2>
      <label>URL</label>
      <input name="radarrUrl" value="${escapeHtml(settings.radarr.url ?? "")}" placeholder="http://radarr:7878">
      <label>API Key</label>
      <input name="radarrApiKey" type="password" placeholder="Leave blank to keep existing key">

      <h2>Plex</h2>
      <label>URL</label>
      <input name="plexUrl" value="${escapeHtml(settings.plex.url ?? "")}" placeholder="http://plex:32400">
      <label>Token</label>
      <input name="plexToken" type="password" placeholder="Leave blank to keep existing token">

      <h2>Pi / AI</h2>
      <label>Model Provider</label>
      <input name="aiModelProvider" value="${escapeHtml(settings.ai.modelProvider)}" placeholder="openai-codex">
      <label>Model ID</label>
      <input name="aiModelId" value="${escapeHtml(settings.ai.modelId)}" placeholder="Leave blank for Pi default">
      <label>Thinking Level</label>
      <select name="aiThinkingLevel">
        ${["off", "minimal", "low", "medium", "high", "xhigh"].map((level) => `<option value="${level}" ${settings.ai.thinkingLevel === level ? "selected" : ""}>${level}</option>`).join("")}
      </select>

      <h2>Conversation Memory</h2>
      <label><input name="memoryEnabled" type="checkbox" value="true" ${settings.memory.enabled ? "checked" : ""} style="width:auto"> Enable conversation memory</label>
      <label>Memory Scope</label>
      <select name="memoryScope">
        <option value="channel_user" ${settings.memory.scope === "channel_user" ? "selected" : ""}>Channel/thread + user</option>
        <option value="channel" ${settings.memory.scope === "channel" ? "selected" : ""}>Shared channel/thread</option>
      </select>
      <label>Max Messages To Remember</label>
      <input name="memoryMaxMessages" type="number" min="0" max="50" value="${settings.memory.maxMessages}">
      <label>Memory TTL Hours</label>
      <input name="memoryTtlHours" type="number" min="1" max="720" value="${settings.memory.ttlHours}">
      <label><input name="memoryIncludeBotReplies" type="checkbox" value="true" ${settings.memory.includeBotReplies ? "checked" : ""} style="width:auto"> Include bot replies in memory</label>
      <p class="muted">Discord threads use their thread channel ID, so each thread gets separate memory. Channel/thread + user is the safest default.</p>

      <h2>Repair Policy</h2>
      <label><input name="repairRequireConfirmation" type="checkbox" value="true" ${settings.repair.requireConfirmation ? "checked" : ""} style="width:auto"> Require confirmation for repair actions</label>
      <label><input name="repairAllowDestructive" type="checkbox" value="true" ${settings.repair.allowDestructive ? "checked" : ""} style="width:auto"> Allow destructive repair actions</label>

      <button type="submit">Save Settings</button>
    </form>
    <section class="panel">
      <h2>Pi Codex Auth</h2>
      <p>Use <a href="/pi-auth">Pi Auth</a> to connect ChatGPT Plus/Pro through the OpenAI Codex device-code flow.</p>
    </section>`,
  );
}

export function piAuthPage(snapshot: PiAuthSnapshot): string {
  const login = snapshot.activeLogin;
  const pending = login?.status === "pending";
  const credentialDetail = snapshot.credential
    ? `${snapshot.credential.type}${snapshot.credential.expiresAt ? `, expires ${snapshot.credential.expiresAt}` : ""}${snapshot.credential.expired ? " (expired)" : ""}`
    : "No stored OpenAI Codex credential";
  const refreshDetail = snapshot.refresh?.error
    ? `<p><strong>Refresh error:</strong> ${escapeHtml(snapshot.refresh.error)}</p>`
    : snapshot.refresh?.refreshedAt
      ? `<p class="muted">OAuth token refreshed ${escapeHtml(snapshot.refresh.refreshedAt)}.</p>`
      : "";

  return layout(
    "Pi Auth",
    `<section class="panel">
      <h2>OpenAI Codex</h2>
      <p><strong>Status:</strong> ${snapshot.configured ? "Configured" : "Not configured"}</p>
      <p class="muted">${escapeHtml(credentialDetail)}</p>
      ${refreshDetail}
      <p class="muted">Stored at <code>${escapeHtml(snapshot.authPath)}</code></p>
      <form method="post" action="/pi-auth/start" class="inline">
        <button type="submit" ${pending ? "disabled" : ""}>${snapshot.configured ? "Reconnect" : "Start Login"}</button>
      </form>
      ${pending ? `<form method="post" action="/pi-auth/cancel" class="inline"><button type="submit" class="danger">Cancel Login</button></form>` : ""}
      ${snapshot.configured ? `<form method="post" action="/pi-auth/logout" class="inline"><button type="submit" class="danger">Logout</button></form>` : ""}
    </section>
    ${login ? piAuthLoginPanel(login) : ""}
    <section class="panel">
      <h2>How It Works</h2>
      <p>Start login, open the verification URL, enter the code, and leave this page open until the status completes.</p>
      <p class="muted">This uses Pi's device-code OAuth flow, so no public callback URL is required behind your reverse proxy.</p>
    </section>`,
  );
}

function piAuthLoginPanel(login: NonNullable<PiAuthSnapshot["activeLogin"]>): string {
  const deviceCode = login.deviceCode;

  return `<section class="panel">
    <h2>Current Login</h2>
    <p><strong>Status:</strong> ${escapeHtml(login.status)}</p>
    ${login.progress ? `<p>${escapeHtml(login.progress)}</p>` : ""}
    ${login.error ? `<p><strong>Error:</strong> ${escapeHtml(login.error)}</p>` : ""}
    ${deviceCode ? `<p>Open <a href="${escapeHtml(deviceCode.verificationUri)}" target="_blank" rel="noreferrer">${escapeHtml(deviceCode.verificationUri)}</a> and enter:</p>
    <pre>${escapeHtml(deviceCode.userCode)}</pre>
    ${deviceCode.expiresAt ? `<p class="muted">Expires ${escapeHtml(deviceCode.expiresAt)}</p>` : ""}` : ""}
    ${login.status === "pending" ? `<p class="muted">Refresh this page in a few seconds after authorizing to see completion.</p>` : ""}
  </section>`;
}

function statusCard(name: string, ok: boolean, detail: string): string {
  return `<section class="panel"><h2>${escapeHtml(name)}</h2><p>${ok ? "Configured" : "Not configured"}</p><p class="muted">${escapeHtml(detail)}</p></section>`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

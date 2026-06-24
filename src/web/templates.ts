import type { PiAuthSnapshot } from "../agent/pi-auth.js";
import type { RuntimeSettings } from "../domain/settings.js";
import type { ConversationSession } from "../storage/conversation.js";

export type ServiceStatus = {
  name: string;
  state: "connected" | "configured" | "missing" | "error";
  target: string;
  detail: string;
};

export type SettingsPageData = {
  settings: RuntimeSettings;
  piAuth: PiAuthSnapshot;
  statuses: ServiceStatus[];
  sessions: ConversationSession[];
};

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Plex Repairman</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0a0d12; color: #edf2f7; }
    body { margin: 0; background: #0a0d12; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px 18px 56px; }
    header { display: flex; justify-content: space-between; gap: 18px; align-items: end; margin-bottom: 22px; border-bottom: 1px solid #2c3442; padding-bottom: 16px; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-logo { width: 52px; height: 52px; object-fit: contain; }
    h1, h2, h3 { margin: 0; line-height: 1.15; }
    h1 { font-size: clamp(1.7rem, 4vw, 2.6rem); letter-spacing: -.04em; }
    h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .11em; color: #d6deea; }
    h3 { font-size: 1rem; color: #f8fafc; }
    a { color: #8bd3ff; text-decoration-thickness: 1px; text-underline-offset: 3px; }
    .anchors { display: flex; gap: 12px; flex-wrap: wrap; color: #9aa7bb; font-size: .93rem; }
    .section { border: 1px solid #2c3442; background: #10151d; margin: 18px 0; }
    summary { cursor: pointer; }
    summary::marker { color: #8bd3ff; }
    .section-header { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 14px 16px; border-bottom: 1px solid #2c3442; background: #141a24; }
    .section-body { padding: 16px; }
    .stack { display: grid; gap: 16px; }
    .group { border-top: 1px solid #2c3442; padding-top: 16px; }
    .group:first-child { border-top: 0; padding-top: 0; }
    .group-head { display: grid; gap: 4px; margin-bottom: 12px; }
    summary.group-head { display: flex; justify-content: space-between; gap: 16px; align-items: start; }
    .group-head-row { display: flex; justify-content: space-between; gap: 16px; align-items: start; }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; }
    .model-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px 16px; }
    .span-2 { grid-column: 1 / -1; }
    .span-3 { grid-column: 1 / -1; }
    label { display: grid; gap: 6px; color: #b9c3d6; font-size: .92rem; }
    input, select { width: 100%; box-sizing: border-box; min-height: 42px; padding: 10px 11px; border: 1px solid #465368; border-radius: 0; background: #0a0d12; color: #edf2f7; font: inherit; }
    input[type="checkbox"] { width: auto; margin: 0; }
    .check { display: flex; align-items: center; gap: 9px; min-height: 38px; }
    button, .button-link { border: 1px solid #8bd3ff; border-radius: 0; padding: 10px 14px; color: #061018; background: #8bd3ff; font-weight: 700; cursor: pointer; font: inherit; }
    .button-link { display: inline-block; text-decoration: none; }
    .icon-button { width: 38px; height: 38px; display: inline-grid; place-items: center; padding: 0; font-size: 1.15rem; line-height: 1; }
    button.secondary { background: transparent; color: #8bd3ff; }
    button.danger { border-color: #ff8b8b; background: #ff8b8b; color: #240707; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #2c3442; padding: 10px 8px; text-align: left; vertical-align: top; }
    th { color: #b9c3d6; font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; background: #0d1118; }
    tr:last-child td { border-bottom: 0; }
    code, pre { background: #080b10; border: 1px solid #2c3442; }
    code { padding: 1px 4px; }
    pre { padding: 12px; overflow: auto; }
    .muted { color: #9aa7bb; }
    .subtle { color: #8190a5; font-size: .9rem; }
    .badge { display: inline-block; min-width: 82px; padding: 3px 7px; border: 1px solid #465368; text-align: center; font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; }
    .badge.connected { border-color: #76e4a6; color: #76e4a6; }
    .badge.configured { border-color: #8bd3ff; color: #8bd3ff; }
    .badge.missing { border-color: #d6a84f; color: #d6a84f; }
    .badge.error { border-color: #ff8b8b; color: #ff8b8b; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .pi-auth-panel { border: 1px solid #2c3442; background: #0d1118; padding: 14px; }
    .pi-auth-status-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
    .login-panel { border: 1px solid #2c3442; margin-top: 14px; }
    .login-panel-head { display: flex; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid #2c3442; background: #141a24; }
    .login-panel-body { padding: 14px; }
    .code-row { display: flex; gap: 10px; align-items: stretch; margin: 10px 0; }
    .device-code { flex: 1; display: flex; align-items: center; min-height: 42px; padding: 0 12px; font-size: 1.05rem; font-weight: 700; letter-spacing: .08em; }
    .copy-feedback { min-width: 52px; color: #76e4a6; align-self: center; }
    .refresh-form { margin: 0; }
    .save-row { position: sticky; bottom: 0; display: flex; justify-content: flex-end; padding: 12px 0 0; background: linear-gradient(180deg, rgba(10,13,18,0), #0a0d12 35%); }
    .empty { padding: 14px; border: 1px dashed #465368; color: #9aa7bb; }
    .nowrap { white-space: nowrap; }
    .session-table { table-layout: fixed; }
    .session-session { width: 40%; }
    .session-count { width: 86px; }
    .session-date { width: 160px; }
    .session-preview { width: auto; }
    .session-action { width: 92px; }
    .session-label, .session-key, .preview-text { overflow: hidden; text-overflow: ellipsis; }
    .session-label, .session-key { white-space: nowrap; }
    .preview-text { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow-wrap: break-word; }
    @media (max-width: 760px) {
      header { display: grid; align-items: start; }
      .form-grid { grid-template-columns: 1fr; }
      .model-grid { grid-template-columns: 1fr; }
      .span-2 { grid-column: auto; }
      .span-3 { grid-column: auto; }
      .wide-table { display: block; overflow-x: auto; }
      th, td { min-width: 130px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="brand">
          <img class="brand-logo" src="/repairman.png" alt="" width="52" height="52">
          <h1>Plex Repairman</h1>
        </div>
      </div>
      <nav class="anchors">
        <a href="#status">Status</a>
        <a href="#auth-services">Auth &amp; Services</a>
        <a href="#bot-settings">Bot Settings</a>
        <a href="#memory">Memory</a>
      </nav>
    </header>
    ${body}
  </main>
  <script>
    let piAuthPollTimer;

    document.addEventListener("submit", async (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;

      if (form.dataset.piAuthAction === "true") {
        event.preventDefault();
        await submitPiAuthForm(form);
        return;
      }

      if (form.dataset.refreshSessions !== "true") return;

      event.preventDefault();
      const button = form.querySelector("button");
      const target = document.getElementById("active-sessions-content");
      if (!target) return;

      if (button) button.disabled = true;
      try {
        const response = await fetch(form.action, { method: "POST" });
        if (!response.ok) throw new Error("Refresh failed: " + response.status);
        target.innerHTML = await response.text();
      } catch (error) {
        target.innerHTML = '<div class="empty">' + escapeClientHtml(error instanceof Error ? error.message : String(error)) + '</div>';
      } finally {
        if (button) button.disabled = false;
      }
    });

    document.addEventListener("click", async (event) => {
      const button = event.target instanceof Element ? event.target.closest("[data-copy-code]") : null;
      if (!(button instanceof HTMLButtonElement)) return;

      event.preventDefault();
      event.stopPropagation();

      const code = button.dataset.copyCode || "";
      const feedback = button.parentElement?.querySelector("[data-copy-feedback]");
      try {
        await copyText(code);
        if (feedback) feedback.textContent = "Copied";
      } catch {
        if (feedback) feedback.textContent = "Copy failed";
      }
      setTimeout(() => {
        if (feedback) feedback.textContent = "";
      }, 1600);
    });

    async function submitPiAuthForm(form) {
      const button = form.querySelector("button");
      let authWindow = null;
      if (form.dataset.piAuthStart === "true") {
        authWindow = window.open("about:blank", "_blank");
        if (authWindow) authWindow.document.write("Waiting for OpenAI auth link...");
      }

      if (button) button.disabled = true;
      try {
        const response = await fetch(form.action, { method: "POST", headers: { "X-Requested-With": "fetch" } });
        if (!response.ok) throw new Error("Pi auth request failed: " + response.status);
        const panel = replacePiAuthPanel(await response.text());
        const verificationUri = panel?.dataset.verificationUri;
        if (authWindow && verificationUri) {
          authWindow.location.href = verificationUri;
        } else if (authWindow) {
          authWindow.close();
        }
        await refreshStatusTable();
        updatePiAuthPolling();
      } catch (error) {
        if (authWindow) authWindow.close();
        alert(error instanceof Error ? error.message : String(error));
      } finally {
        if (button) button.disabled = false;
      }
    }

    function replacePiAuthPanel(html) {
      const current = document.getElementById("pi-auth-panel");
      if (!current) return null;
      current.outerHTML = html;
      return document.getElementById("pi-auth-panel");
    }

    async function refreshPiAuthStatus() {
      const response = await fetch("/pi-auth/status", { method: "POST", headers: { "X-Requested-With": "fetch" } });
      if (!response.ok) return;
      replacePiAuthPanel(await response.text());
      await refreshStatusTable();
      updatePiAuthPolling();
    }

    async function refreshStatusTable() {
      const target = document.getElementById("status-content");
      if (!target) return;
      const response = await fetch("/status/table", { method: "POST", headers: { "X-Requested-With": "fetch" } });
      if (response.ok) target.innerHTML = await response.text();
    }

    function updatePiAuthPolling() {
      if (piAuthPollTimer) clearTimeout(piAuthPollTimer);
      const panel = document.getElementById("pi-auth-panel");
      if (panel?.dataset.pending === "true") {
        piAuthPollTimer = setTimeout(refreshPiAuthStatus, 2500);
      }
    }

    updatePiAuthPolling();

    function escapeClientHtml(value) {
      return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
    }

    async function copyText(value) {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(value);
          return;
        } catch {
          // Fall back for browsers that reject clipboard writes after async UI updates.
        }
      }

      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, value.length);
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error("Copy failed");
    }
  </script>
</body>
</html>`;
}

export function settingsPage(data: SettingsPageData): string {
  const { settings, piAuth, statuses, sessions } = data;

  return layout(
    "Settings",
    `<form id="settings-form" method="post" action="/settings"></form>
    <details id="status" class="section" open>
      <summary class="section-header">
        <h2>Status</h2>
        <span class="subtle">Live checks run when this page loads.</span>
      </summary>
      <div class="section-body">
        <div id="status-content">${statusTable(statuses)}</div>
      </div>
    </details>

    <details id="auth-services" class="section" open>
      <summary class="section-header">
        <h2>Auth &amp; Services</h2>
        <span class="subtle">Credentials and endpoints for systems the bot talks to.</span>
      </summary>
      <div class="section-body stack">
        ${discordAuthGroup(settings)}
        ${piAuthGroup(settings, piAuth)}
        ${arrGroup("Sonarr", "sonarr", settings.sonarr.url ?? "")}
        ${arrGroup("Radarr", "radarr", settings.radarr.url ?? "")}
        ${plexGroup(settings.plex.url ?? "")}
      </div>
    </details>

    <details id="bot-settings" class="section" open>
      <summary class="section-header">
        <h2>Bot Settings</h2>
        <span class="subtle">Access rules and behavior.</span>
      </summary>
      <div class="section-body stack">
        ${discordAccessGroup(settings)}
        ${messageBehaviorGroup(settings)}
        ${repairPolicyGroup(settings)}
      </div>
    </details>

    <details id="memory" class="section" open>
      <summary class="section-header">
        <h2>Memory</h2>
        <span class="subtle">Conversation retention and currently active sessions.</span>
      </summary>
      <div class="section-body stack">
        ${memorySettingsGroup(settings)}
        ${memorySessions(sessions)}
      </div>
    </details>

    <div class="save-row">
      <button type="submit" form="settings-form">Save Settings</button>
    </div>`,
  );
}

export function statusTable(statuses: ServiceStatus[]): string {
  return `<div class="wide-table"><table>
    <thead><tr><th>Service</th><th>Status</th><th>Configured As / URL</th><th>Detail</th></tr></thead>
    <tbody>
      ${statuses
        .map(
          (status) => `<tr>
            <td>${escapeHtml(status.name)}</td>
            <td>${statusBadge(status.state)}</td>
            <td>${escapeHtml(status.target)}</td>
            <td>${escapeHtml(status.detail)}</td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table></div>`;
}

function discordAuthGroup(settings: RuntimeSettings): string {
  return `<section class="group">
    <div class="group-head group-head-row">
      <h3>Discord Bot Auth</h3>
      <p class="subtle">The token controls whether the Discord bot can connect. Application ID enables slash command registration.</p>
    </div>
    <div class="form-grid">
      ${input("Bot Token", "discordToken", "", "password", "Leave blank to keep existing token")}
      ${input("Application ID", "discordApplicationId", settings.discord.applicationId ?? "")}
    </div>
  </section>`;
}

function piAuthGroup(settings: RuntimeSettings, snapshot: PiAuthSnapshot): string {
  return `<section class="group">
    <div class="group-head">
      <h3>Pi / OpenAI Codex Auth</h3>
      <p class="subtle">Model behavior and Codex device-code authentication</p>
    </div>
    <div class="model-grid">
      ${input("Model Provider", "aiModelProvider", settings.ai.modelProvider, "text", "openai-codex")}
      ${input("Model ID", "aiModelId", settings.ai.modelId, "text", "Leave blank for Pi default")}
      <label>Thinking Level
        <select name="aiThinkingLevel" form="settings-form">
          ${["off", "minimal", "low", "medium", "high", "xhigh"].map((level) => `<option value="${level}" ${settings.ai.thinkingLevel === level ? "selected" : ""}>${level}</option>`).join("")}
        </select>
      </label>
      <div class="span-3">${piAuthPanel(snapshot)}</div>
    </div>
  </section>`;
}

export function piAuthPanel(snapshot: PiAuthSnapshot): string {
  const login = snapshot.activeLogin;
  const pending = login?.status === "pending";
  const deviceCode = login?.deviceCode;
  const state = pending ? "pending" : snapshot.configured ? "configured" : login?.status === "error" ? "error" : "missing";
  const credentialDetail = snapshot.credential
    ? `${snapshot.credential.type}${snapshot.credential.expiresAt ? `, expires ${formatDate(snapshot.credential.expiresAt)}` : ""}${snapshot.credential.expired ? " (expired)" : ""}`
    : "No OpenAI Codex credential";
  const refreshDetail = snapshot.refresh?.error
    ? `<p><strong>Refresh error:</strong> ${escapeHtml(snapshot.refresh.error)}</p>`
    : snapshot.refresh?.refreshedAt
      ? `<p class="subtle">OAuth token refreshed ${escapeHtml(formatDate(snapshot.refresh.refreshedAt))}.</p>`
      : "";

  return `<div id="pi-auth-panel" class="pi-auth-panel" data-pending="${pending ? "true" : "false"}"${deviceCode ? ` data-verification-uri="${escapeAttribute(deviceCode.verificationUri)}"` : ""}>
    <div class="pi-auth-status-row">
      <span class="subtle">Pi Auth Status</span>
      ${authBadge(state)}
      <span>${escapeHtml(pending ? "Waiting for OpenAI authorization" : credentialDetail)}</span>
    </div>
    ${refreshDetail}
    <div class="actions">
      <form method="post" action="/pi-auth/start" data-pi-auth-action="true" data-pi-auth-start="true"><button type="submit" class="secondary" ${pending ? "disabled" : ""}>${snapshot.configured ? "Reconnect" : "Start Login"}</button></form>
      ${pending ? `<form method="post" action="/pi-auth/cancel" data-pi-auth-action="true"><button type="submit" class="danger">Cancel Login</button></form>` : ""}
      ${snapshot.configured ? `<form method="post" action="/pi-auth/logout" data-pi-auth-action="true"><button type="submit" class="danger">Logout</button></form>` : ""}
    </div>
    ${pending || login?.status === "error" ? piAuthLoginPanel(login) : ""}
  </div>`;
}

function arrGroup(label: "Sonarr" | "Radarr", key: "sonarr" | "radarr", url: string): string {
  return `<section class="group">
    <div class="group-head">
      <h3>${label}</h3>
      <p class="subtle">${label} endpoint and API key used for library lookup and repair actions.</p>
    </div>
    <div class="form-grid">
      ${input("URL", `${key}Url`, url, "text", key === "sonarr" ? "http://sonarr:8989" : "http://radarr:7878")}
      ${input("API Key", `${key}ApiKey`, "", "password", "Leave blank to keep existing key")}
    </div>
  </section>`;
}

function plexGroup(url: string): string {
  return `<section class="group">
    <div class="group-head">
      <h3>Plex</h3>
      <p class="subtle">Plex server URL and token used for library search and refresh operations.</p>
    </div>
    <div class="form-grid">
      ${input("URL", "plexUrl", url, "text", "http://plex:32400")}
      ${input("Token", "plexToken", "", "password", "Leave blank to keep existing token")}
    </div>
  </section>`;
}

function discordAccessGroup(settings: RuntimeSettings): string {
  return `<section class="group">
    <div class="group-head">
      <h3>Discord Access</h3>
      <p class="subtle">Limit where the bot responds and who can trigger repair actions.</p>
    </div>
    <div class="form-grid">
      ${input("Allowed Guild IDs", "discordAllowedGuildIds", settings.discord.allowedGuildIds, "text", "Comma separated, blank allows all")}
      ${input("Allowed Channel IDs", "discordAllowedChannelIds", settings.discord.allowedChannelIds, "text", "Comma separated, blank allows all")}
      ${input("Repair Role IDs", "discordRepairRoleIds", settings.discord.repairRoleIds, "text", "Comma separated")}
      ${checkbox("discordAllowDirectMessages", "Allow Direct Messages", settings.discord.allowDirectMessages)}
    </div>
  </section>`;
}

function messageBehaviorGroup(settings: RuntimeSettings): string {
  return `<section class="group">
    <div class="group-head">
      <h3>Message Behavior</h3>
      <p class="subtle">Presentation choices for Discord replies.</p>
    </div>
    <div class="form-grid">
      ${checkbox("discordReactionsEnabled", "Enable message reactions", settings.discord.reactionsEnabled)}
    </div>
  </section>`;
}

function repairPolicyGroup(settings: RuntimeSettings): string {
  return `<section class="group">
    <div class="group-head">
      <h3>Repair Policy</h3>
      <p class="subtle">Safety controls for actions that change media server state.</p>
    </div>
    <div class="form-grid">
      ${checkbox("repairRequireConfirmation", "Require confirmation for repair actions", settings.repair.requireConfirmation)}
      ${checkbox("repairAllowDestructive", "Allow destructive repair actions", settings.repair.allowDestructive)}
    </div>
  </section>`;
}

function memorySettingsGroup(settings: RuntimeSettings): string {
  return `<section class="group">
    <div class="group-head">
      <h3>Memory Settings</h3>
      <p class="subtle">Discord threads use their thread channel ID, so each thread gets separate memory.</p>
    </div>
    <div class="form-grid">
      ${checkbox("memoryEnabled", "Enable conversation memory", settings.memory.enabled)}
      <label>Memory Scope
        <select name="memoryScope" form="settings-form">
          <option value="channel_user" ${settings.memory.scope === "channel_user" ? "selected" : ""}>Channel/thread + user</option>
          <option value="channel" ${settings.memory.scope === "channel" ? "selected" : ""}>Shared channel/thread</option>
        </select>
      </label>
      ${input("Max Messages To Remember", "memoryMaxMessages", String(settings.memory.maxMessages), "number", "", " min=\"0\" max=\"50\"")}
      ${input("Memory TTL Hours", "memoryTtlHours", String(settings.memory.ttlHours), "number", "", " min=\"1\" max=\"720\"")}
      ${checkbox("memoryIncludeBotReplies", "Include bot replies in memory", settings.memory.includeBotReplies)}
    </div>
  </section>`;
}

function memorySessions(sessions: ConversationSession[]): string {
  return `<section class="group">
    <div class="group-head group-head-row">
      <div>
        <h3>Active Sessions</h3>
        <p class="subtle">Sessions shown here still have messages inside the configured memory TTL window.</p>
      </div>
      <form class="refresh-form" method="post" action="/memory/sessions" data-refresh-sessions="true">
        <button class="icon-button" type="submit" name="refresh" value="sessions" aria-label="Refresh active sessions" title="Refresh active sessions">&#8635;</button>
      </form>
    </div>
    <div id="active-sessions-content">${memorySessionsTable(sessions)}</div>
  </section>`;
}

export function memorySessionsTable(sessions: ConversationSession[]): string {
  return sessions.length === 0 ? `<div class="empty">No active memory sessions.</div>` : `<div class="wide-table"><table class="session-table">
      <thead><tr><th class="session-session">Session</th><th class="session-count">Messages</th><th class="session-date">First</th><th class="session-date">Last</th><th class="session-preview">Latest</th><th class="session-action">Action</th></tr></thead>
      <tbody>
        ${sessions.map(sessionRow).join("")}
      </tbody>
    </table></div>`;
}

function sessionRow(session: ConversationSession): string {
  return `<tr>
    <td><div class="session-label">${escapeHtml(formatConversationKey(session.conversationKey))}</div><div class="subtle session-key">${escapeHtml(session.conversationKey)}</div></td>
    <td>${session.messageCount}</td>
    <td>${escapeHtml(formatDate(session.firstMessageAt))}</td>
    <td>${escapeHtml(formatDate(session.lastMessageAt))}</td>
    <td><div class="preview-text"><span class="subtle">${escapeHtml(session.latestRole)}:</span> ${escapeHtml(truncate(session.latestContent, 220))}</div></td>
    <td>
      <form method="post" action="/memory/delete">
        <input type="hidden" name="conversationKey" value="${escapeAttribute(session.conversationKey)}">
        <button type="submit" class="danger">Delete</button>
      </form>
    </td>
  </tr>`;
}

function piAuthLoginPanel(login: NonNullable<PiAuthSnapshot["activeLogin"]>): string {
  const deviceCode = login.deviceCode;

  return `<div class="login-panel">
    <div class="login-panel-head"><h3>Current Login</h3><span class="subtle">${escapeHtml(login.status)}</span></div>
    <div class="login-panel-body">
      ${login.progress ? `<p>${escapeHtml(login.progress)}</p>` : ""}
      ${login.error ? `<p><strong>Error:</strong> ${escapeHtml(login.error)}</p>` : ""}
      ${deviceCode ? `<p>Open <a href="${escapeAttribute(deviceCode.verificationUri)}" target="_blank" rel="noreferrer">OpenAI Codex device auth</a> and enter this code:</p>
      <div class="code-row">
        <code class="device-code">${escapeHtml(deviceCode.userCode)}</code>
        <button type="button" class="icon-button" data-copy-code="${escapeAttribute(deviceCode.userCode)}" aria-label="Copy device code" title="Copy device code">&#x2398;</button>
        <span class="copy-feedback" data-copy-feedback></span>
      </div>
      ${deviceCode.expiresAt ? `<p class="subtle">Expires ${escapeHtml(deviceCode.expiresAt)}</p>` : ""}` : ""}
      ${login.status === "pending" ? `<p class="subtle">This panel will update automatically after authorization completes.</p>` : ""}
    </div>
  </div>`;
}

function input(labelText: string, name: string, value: string, type = "text", placeholder = "", attrs = ""): string {
  return `<label>${escapeHtml(labelText)}
    <input name="${escapeAttribute(name)}" type="${escapeAttribute(type)}" value="${escapeAttribute(value)}" placeholder="${escapeAttribute(placeholder)}" form="settings-form"${attrs}>
  </label>`;
}

function checkbox(name: string, labelText: string, checked: boolean): string {
  return `<label class="check"><input name="${escapeAttribute(name)}" type="checkbox" value="true" form="settings-form" ${checked ? "checked" : ""}> ${escapeHtml(labelText)}</label>`;
}

function statusBadge(state: ServiceStatus["state"]): string {
  return `<span class="badge ${state}">${state}</span>`;
}

function authBadge(state: "configured" | "missing" | "pending" | "error"): string {
  const badgeState = state === "pending" ? "configured" : state;
  return `<span class="badge ${badgeState}">${state}</span>`;
}

function formatConversationKey(key: string): string {
  const guild = /guild:([^:]+):channel:([^:]+)(?::user:([^:]+))?/.exec(key);
  if (guild) {
    return guild[3] ? `Guild ${guild[1]} / Channel ${guild[2]} / User ${guild[3]}` : `Guild ${guild[1]} / Channel ${guild[2]}`;
  }

  const dm = /dm:([^:]+)/.exec(key);
  return dm ? `DM ${dm[1]}` : key;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 3)}...`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

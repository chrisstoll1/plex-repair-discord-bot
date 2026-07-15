export type SecretValue = { configured: boolean; value?: string; clear?: boolean };

export type Settings = {
  discord: {
    token: SecretValue;
    applicationId: string;
    allowedGuildIds: string;
    allowedChannelIds: string;
    repairRoleIds: string;
    allowDirectMessages: boolean;
    reactionsEnabled: boolean;
  };
  sonarr: { url: string; apiKey: SecretValue };
  radarr: { url: string; apiKey: SecretValue };
  plex: { url: string; token: SecretValue };
  ai: {
    modelProvider: string;
    modelId: string;
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    serviceTier: "default" | "priority";
  };
  timeouts: { standardSeconds: number; releaseLookupSeconds: number };
  repair: { requireConfirmation: boolean; allowDestructive: boolean };
};

type SecretUpdate = { action: "keep" } | { action: "clear" } | { action: "replace"; value: string };
type SettingsUpdate = Omit<Settings, "discord" | "sonarr" | "radarr" | "plex"> & {
  discord: Omit<Settings["discord"], "token"> & { token: SecretUpdate };
  sonarr: Omit<Settings["sonarr"], "apiKey"> & { apiKey: SecretUpdate };
  radarr: Omit<Settings["radarr"], "apiKey"> & { apiKey: SecretUpdate };
  plex: Omit<Settings["plex"], "token"> & { token: SecretUpdate };
};
export type ServiceState = "connected" | "configured" | "missing" | "error" | "unknown";
export type ServiceStatus = { name: string; state: ServiceState; detail?: string; latencyMs?: number; checkedAt?: string };
export type StatusResponse = { services: ServiceStatus[]; checkedAt?: string; version?: string; uptimeSeconds?: number; startedAt?: string };

export type AgentTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type AgentTask = {
  id: string;
  parentTaskId?: string;
  conversationKey?: string;
  guildId?: string;
  channelId: string;
  userId: string;
  sourceMessageId?: string;
  status: AgentTaskStatus;
  title: string;
  toolProfile: string;
  prompt: string;
  input?: unknown;
  resultText?: string;
  result?: unknown;
  error?: string;
  attempts: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
};

export type RepairCaseStatus = "working" | "waiting" | "ready" | "verifying" | "resolved" | "needs_input" | "blocked" | "exhausted" | "cancelled";
export type RepairCase = {
  id: string;
  status: RepairCaseStatus;
  title: string;
  latestUpdate?: string;
  nextWakeAt?: string;
  threadUrl?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  resolvedAt?: string;
  cancelledAt?: string;
};

export type RepairCaseActivity = {
  id: string;
  repairId?: string;
  type: string;
  source?: "user" | "bot" | "agent" | "system";
  actor?: string;
  message?: string;
  status?: RepairCaseStatus;
  details?: unknown;
  createdAt: string;
};

export type WebhookConfig = {
  publicBaseUrl: string;
  sonarrEnabled: boolean;
  radarrEnabled: boolean;
  sonarrUrl?: string;
  radarrUrl?: string;
  sonarrLastReceivedAt?: string;
  radarrLastReceivedAt?: string;
};

export type PiAuthSnapshot = {
  configured: boolean;
  status: { configured: boolean; source?: string; label?: string };
  credential?: { type: string; expiresAt?: string; expired?: boolean };
  refresh?: { attemptedAt?: string; refreshedAt?: string; error?: string };
  activeLogin?: {
    status: "pending" | "complete" | "cancelled" | "error";
    startedAt: string;
    completedAt?: string;
    deviceCode?: { userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number; expiresAt?: string };
    progress?: string;
    error?: string;
  };
};

export class ApiError extends Error {
  constructor(message: string, public status: number, public details?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    let details: unknown;
    try { details = await response.json(); } catch { details = await response.text(); }
    const message = getErrorMessage(details) ?? `Request failed (${response.status})`;
    throw new ApiError(message, response.status, details);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  getSettings: () => request<{ settings: Settings }>("/api/settings").then((response) => response.settings),
  updateSettings: (settings: Settings) => request<{ settings: Settings }>("/api/settings", { method: "PUT", body: JSON.stringify(toSettingsUpdate(settings)) }).then((response) => response.settings),
  getStatus: () => request<StatusResponse>("/api/status"),
  getTasks: () => request<{ tasks: AgentTask[] }>("/api/tasks").then((response) => response.tasks),
  cancelTask: (id: string) => request<{ task: AgentTask }>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" }).then((response) => response.task),
  clearTaskHistory: () => request<{ deleted: number }>("/api/tasks/history", { method: "DELETE" }),
  getRepairs: () => request<{ repairs: RepairCase[] }>("/api/repairs").then((response) => response.repairs),
  clearRepairs: () => request<{ deleted: number }>("/api/repairs", { method: "DELETE" }),
  cancelRepair: (id: string) => request<{ repair: RepairCase }>(`/api/repairs/${encodeURIComponent(id)}/cancel`, { method: "POST" }).then((response) => response.repair),
  resumeRepair: (id: string) => request<{ repair: RepairCase }>(`/api/repairs/${encodeURIComponent(id)}/resume`, { method: "POST" }).then((response) => response.repair),
  getRepairActivity: (id: string) => request<{ timeline: RepairCaseActivity[] }>(`/api/repairs/${encodeURIComponent(id)}/timeline`).then((response) => response.timeline),
  getWebhookConfig: () => request<WebhookConfig>("/api/webhooks/config"),
  updateWebhookConfig: (config: Pick<WebhookConfig, "publicBaseUrl" | "sonarrEnabled" | "radarrEnabled">) => request<WebhookConfig>("/api/webhooks/config", { method: "PUT", body: JSON.stringify(config) }),
  rotateWebhookSecret: () => request<WebhookConfig>("/api/webhooks/rotate-secret", { method: "POST" }),
  getPiAuth: () => request<{ piAuth: PiAuthSnapshot }>("/api/pi-auth").then((response) => response.piAuth),
  startPiAuth: () => request<{ piAuth: PiAuthSnapshot }>("/api/pi-auth/start", { method: "POST" }).then((response) => response.piAuth),
  cancelPiAuth: () => request<{ piAuth: PiAuthSnapshot }>("/api/pi-auth/cancel", { method: "POST" }).then((response) => response.piAuth),
  logoutPiAuth: () => request<{ piAuth: PiAuthSnapshot }>("/api/pi-auth/logout", { method: "POST" }).then((response) => response.piAuth),
};

function toSettingsUpdate(settings: Settings): SettingsUpdate {
  return {
    ...settings,
    discord: { ...settings.discord, token: toSecretUpdate(settings.discord.token) },
    sonarr: { ...settings.sonarr, apiKey: toSecretUpdate(settings.sonarr.apiKey) },
    radarr: { ...settings.radarr, apiKey: toSecretUpdate(settings.radarr.apiKey) },
    plex: { ...settings.plex, token: toSecretUpdate(settings.plex.token) },
  };
}

function toSecretUpdate(secret: SecretValue): SecretUpdate {
  if (secret.clear) return { action: "clear" };
  const value = secret.value?.trim();
  return value ? { action: "replace", value } : { action: "keep" };
}

function getErrorMessage(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  if ("message" in details && typeof details.message === "string") return details.message;
  if ("error" in details && details.error && typeof details.error === "object" && "message" in details.error && typeof details.error.message === "string") {
    return details.error.message;
  }
  return undefined;
}

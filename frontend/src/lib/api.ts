export type SecretValue = { configured: boolean; value?: string; clear?: boolean };
export type PortalAuthSettings = { enabled: boolean; username: string; passwordConfigured: boolean };
export type PortalSession = { enabled: boolean; authenticated: boolean; username?: string; csrfToken?: string };
let csrfToken: string | undefined;
export function setPortalSession(session: PortalSession) { csrfToken = session.csrfToken; }

export type AiFallbackTarget = {
  modelProvider: string;
  modelId: string;
};

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
  seerr: { url: string; apiKey: SecretValue; preferForRequests: boolean; userMappings: string; defaultUserId: number };
  ai: {
    modelProvider: string;
    modelId: string;
    fallbacks: AiFallbackTarget[];
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    serviceTier: "default" | "priority";
  };
  timeouts: { standardSeconds: number; releaseLookupSeconds: number };
  repair: { requireConfirmation: boolean; allowDestructive: boolean; allowDirectAdd: boolean };
};

type SecretUpdate = { action: "keep" } | { action: "clear" } | { action: "replace"; value: string };
type SettingsUpdate = Omit<Settings, "discord" | "sonarr" | "radarr" | "plex" | "seerr"> & {
  discord: Omit<Settings["discord"], "token"> & { token: SecretUpdate };
  sonarr: Omit<Settings["sonarr"], "apiKey"> & { apiKey: SecretUpdate };
  radarr: Omit<Settings["radarr"], "apiKey"> & { apiKey: SecretUpdate };
  plex: Omit<Settings["plex"], "token"> & { token: SecretUpdate };
  seerr: Omit<Settings["seerr"], "apiKey"> & { apiKey: SecretUpdate };
};
export type ServiceState = "connected" | "configured" | "missing" | "error" | "unknown";
export type ServiceStatus = { name: string; state: ServiceState; detail?: string; latencyMs?: number; checkedAt?: string };
export type StatusResponse = { services: ServiceStatus[]; checkedAt?: string; version?: string; uptimeSeconds?: number; startedAt?: string };

export type PageInfo = { total: number; offset: number; limit: number };
export type AgentTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type TaskPage = { tasks: AgentTask[]; counts: Record<AgentTaskStatus, number>; pagination: PageInfo };
export type RepairFilter = "all" | "working" | "waiting" | "attention" | "completed";
export type RepairPage = { repairs: RepairCase[]; counts: Record<RepairCaseStatus, number>; pagination: PageInfo };
export type TimelinePage = { timeline: RepairCaseActivity[]; pagination: PageInfo };
export type AiUsedModel = {
  provider: string;
  modelId: string;
  fallback?: boolean;
  attempted?: string[];
};

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
  model?: AiUsedModel;
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
  model?: AiUsedModel;
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
  model?: AiUsedModel;
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

export type CustomProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";

export type CustomModelConfig = {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

export type CustomProviderInput = {
  id: string;
  name: string;
  baseUrl: string;
  api: CustomProviderApi;
  requiresApiKey: boolean;
  apiKey?: SecretUpdate;
  models: CustomModelConfig[];
};

export type AiProviderAuthSummary = {
  id: string;
  name: string;
  kind: "builtin" | "custom";
  description?: string;
  configured: boolean;
  authType?: "oauth" | "api_key" | "env" | "none";
  source?: string;
  label?: string;
  supportsOAuth: boolean;
  oauthFlow?: "device_code" | "copy_code";
  oauthLabel?: string;
  supportsEnterpriseDomain?: boolean;
  supportsApiKey: boolean;
  apiKeyLabel?: string;
  modelCount: number;
  credential?: { type: string; expiresAt?: string; expired?: boolean };
  refresh?: { attemptedAt?: string; refreshedAt?: string; error?: string };
  custom?: {
    baseUrl: string;
    api: CustomProviderApi;
    requiresApiKey: boolean;
    apiKeyConfigured: boolean;
    models: CustomModelConfig[];
  };
};

export type PiAuthSnapshot = {
  configured: boolean;
  status: { configured: boolean; source?: string; label?: string };
  credential?: { type: string; expiresAt?: string; expired?: boolean };
  refresh?: { attemptedAt?: string; refreshedAt?: string; error?: string };
  activeLogin?: {
    providerId: string;
    providerName: string;
    status: "pending" | "complete" | "cancelled" | "error";
    startedAt: string;
    completedAt?: string;
    deviceCode?: { userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number; expiresAt?: string };
    authUrl?: { url: string; instructions?: string };
    inputPrompt?: { type: "manual_code" | "text"; message: string; placeholder?: string };
    progress?: string;
    error?: string;
  };
  providers: AiProviderAuthSummary[];
};

export type AiModel = {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
};

export type PiModelTestResult = {
  ok: boolean;
  provider: string;
  modelId: string;
  latencyMs: number;
  reply?: string;
  error?: string;
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
    credentials: "same-origin",
    headers: { Accept: "application/json", "X-Repairman-Request": "1", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}), ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    let details: unknown;
    try { details = await response.json(); } catch { details = await response.text(); }
    const message = getErrorMessage(details) ?? `Request failed (${response.status})`;
    if (response.status === 401 && details && typeof details === "object" && "error" in details && details.error && typeof details.error === "object" && "code" in details.error && details.error.code === "authentication_required") {
      csrfToken = undefined;
      window.dispatchEvent(new Event("portal-session-expired"));
    }
    throw new ApiError(message, response.status, details);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  getPortalSession: () => request<PortalSession>("/api/auth/session"),
  login: async (credentials: { username: string; password: string }) => { const session = await request<PortalSession>("/api/auth/login", { method: "POST", body: JSON.stringify(credentials) }); setPortalSession(session); return session; },
  logout: async () => { await request("/api/auth/logout", { method: "POST" }); csrfToken = undefined; },
  getPortalAuth: () => request<PortalAuthSettings>("/api/portal-auth"),
  updatePortalAuth: async (settings: { enabled: boolean; username: string; password?: string; currentPassword?: string }) => {
    const result = await request<PortalAuthSettings & { session: PortalSession }>("/api/portal-auth", { method: "PUT", body: JSON.stringify(settings) });
    setPortalSession(result.session);
    window.dispatchEvent(new CustomEvent("portal-session-updated", { detail: result.session }));
    const { session: _, ...value } = result;
    return value;
  },
  getSettings: () => request<{ settings: Settings }>("/api/settings").then((response) => response.settings),
  updateSettings: (settings: Settings) => request<{ settings: Settings }>("/api/settings", { method: "PUT", body: JSON.stringify(toSettingsUpdate(settings)) }).then((response) => response.settings),
  getStatus: () => request<StatusResponse>("/api/status"),
  getTasks: () => request<{ tasks: AgentTask[] }>("/api/tasks").then((response) => response.tasks),
  getTaskPage: (offset: number, limit: number) => request<TaskPage>(`/api/tasks?offset=${offset}&limit=${limit}`),
  cancelTask: (id: string) => request<{ task: AgentTask }>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" }).then((response) => response.task),
  clearTaskHistory: () => request<{ deleted: number }>("/api/tasks/history", { method: "DELETE" }),
  getRepairs: () => request<{ repairs: RepairCase[] }>("/api/repairs").then((response) => response.repairs),
  getRepairPage: (offset: number, limit: number, group: RepairFilter) => request<RepairPage>(`/api/repairs?offset=${offset}&limit=${limit}&group=${group}`),
  clearRepairs: () => request<{ deleted: number }>("/api/repairs", { method: "DELETE" }),
  cancelRepair: (id: string) => request<{ repair: RepairCase }>(`/api/repairs/${encodeURIComponent(id)}/cancel`, { method: "POST" }).then((response) => response.repair),
  resumeRepair: (id: string) => request<{ repair: RepairCase }>(`/api/repairs/${encodeURIComponent(id)}/resume`, { method: "POST" }).then((response) => response.repair),
  getRepairActivity: (id: string) => request<{ timeline: RepairCaseActivity[] }>(`/api/repairs/${encodeURIComponent(id)}/timeline`).then((response) => response.timeline),
  getRepairTimelinePage: (id: string, offset: number, limit: number) => request<TimelinePage>(`/api/repairs/${encodeURIComponent(id)}/timeline?offset=${offset}&limit=${limit}`),
  getWebhookConfig: () => request<WebhookConfig>("/api/webhooks/config"),
  updateWebhookConfig: (config: Pick<WebhookConfig, "publicBaseUrl" | "sonarrEnabled" | "radarrEnabled">) => request<WebhookConfig>("/api/webhooks/config", { method: "PUT", body: JSON.stringify(config) }),
  rotateWebhookSecret: () => request<WebhookConfig>("/api/webhooks/rotate-secret", { method: "POST" }),
  getPiAuth: () => request<{ piAuth: PiAuthSnapshot }>("/api/pi-auth").then((response) => response.piAuth),
  getAiModels: () => request<{ models: AiModel[] }>("/api/pi-models").then((response) => response.models),
  startPiAuth: (params?: { providerId?: string; enterpriseDomain?: string }) =>
    request<{ piAuth: PiAuthSnapshot }>("/api/pi-auth/start", {
      method: "POST",
      ...(params ? { body: JSON.stringify(params) } : {}),
    }).then((response) => response.piAuth),
  submitPiAuthInput: (params: { providerId?: string; value: string }) =>
    request<{ piAuth: PiAuthSnapshot }>("/api/pi-auth/input", {
      method: "POST",
      body: JSON.stringify(params),
    }).then((response) => response.piAuth),
  cancelPiAuth: () => request<{ piAuth: PiAuthSnapshot }>("/api/pi-auth/cancel", { method: "POST" }).then((response) => response.piAuth),
  logoutPiAuth: (providerId?: string) =>
    request<{ piAuth: PiAuthSnapshot }>("/api/pi-auth/logout", {
      method: "POST",
      ...(providerId ? { body: JSON.stringify({ providerId }) } : {}),
    }).then((response) => response.piAuth),
  savePiApiKey: (providerId: string, apiKey: string) =>
    request<{ piAuth: PiAuthSnapshot }>("/api/pi-auth/api-key", {
      method: "POST",
      body: JSON.stringify({ providerId, apiKey }),
    }).then((response) => response.piAuth),
  saveCustomAiProvider: (input: CustomProviderInput) =>
    request<{ piAuth: PiAuthSnapshot }>("/api/pi-auth/custom", {
      method: "PUT",
      body: JSON.stringify(input),
    }).then((response) => response.piAuth),
  deleteCustomAiProvider: (providerId: string) =>
    request<{ piAuth: PiAuthSnapshot }>(`/api/pi-auth/custom/${encodeURIComponent(providerId)}`, {
      method: "DELETE",
    }).then((response) => response.piAuth),
  discoverCustomAiModels: (params: { baseUrl: string; apiKey?: string; providerId?: string }) =>
    request<{ models: CustomModelConfig[] }>("/api/pi-auth/custom/discover", {
      method: "POST",
      body: JSON.stringify(params),
    }).then((response) => response.models),
  testPiModel: (params: { providerId: string; modelId?: string }) =>
    request<{ result: PiModelTestResult }>("/api/pi-auth/test", {
      method: "POST",
      body: JSON.stringify(params),
    }).then((response) => response.result),
};

function toSettingsUpdate(settings: Settings): SettingsUpdate {
  return {
    ...settings,
    discord: { ...settings.discord, token: toSecretUpdate(settings.discord.token) },
    sonarr: { ...settings.sonarr, apiKey: toSecretUpdate(settings.sonarr.apiKey) },
    radarr: { ...settings.radarr, apiKey: toSecretUpdate(settings.radarr.apiKey) },
    plex: { ...settings.plex, token: toSecretUpdate(settings.plex.token) },
    seerr: { ...settings.seerr, apiKey: toSecretUpdate(settings.seerr.apiKey) },
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

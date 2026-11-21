import fs from "node:fs";
import path from "node:path";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const NO_KEY_SENTINEL = "not-required";

export type CustomProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";

export type CustomModelConfig = {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

export type CustomProviderSecretAction =
  | { action: "keep" }
  | { action: "clear" }
  | { action: "replace"; value: string };

export type CustomProviderInput = {
  id: string;
  name: string;
  baseUrl: string;
  api: CustomProviderApi;
  requiresApiKey: boolean;
  apiKey?: CustomProviderSecretAction;
  models: CustomModelConfig[];
};

export type CuratedProviderMeta = {
  id: string;
  name: string;
  description: string;
  supportsOAuth: boolean;
  oauthFlow?: "device_code" | "copy_code";
  oauthLabel?: string;
  supportsEnterpriseDomain?: boolean;
  supportsApiKey: boolean;
  apiKeyLabel?: string;
};

export const CURATED_AI_PROVIDERS: readonly CuratedProviderMeta[] = [
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    description: "ChatGPT Plus/Pro subscription via device-code sign-in.",
    supportsOAuth: true,
    oauthFlow: "device_code",
    oauthLabel: "Sign in with ChatGPT (device code)",
    supportsApiKey: false,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude models via Claude Pro/Max OAuth or an Anthropic API key.",
    supportsOAuth: true,
    oauthFlow: "copy_code",
    oauthLabel: "Sign in with Claude Pro/Max (copy code)",
    supportsApiKey: true,
    apiKeyLabel: "Anthropic API key",
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "OpenAI API models with a standard API key.",
    supportsOAuth: false,
    supportsApiKey: true,
    apiKeyLabel: "OpenAI API key",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    description: "Copilot subscription via device-code sign-in or token.",
    supportsOAuth: true,
    oauthFlow: "device_code",
    oauthLabel: "Sign in with GitHub Copilot",
    supportsEnterpriseDomain: true,
    supportsApiKey: true,
    apiKeyLabel: "GitHub Copilot token",
  },
  {
    id: "google",
    name: "Google Gemini",
    description: "Gemini models using a Google AI Studio API key.",
    supportsOAuth: false,
    supportsApiKey: true,
    apiKeyLabel: "Gemini API key",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Access hundreds of models from one OpenRouter API key.",
    supportsOAuth: false,
    supportsApiKey: true,
    apiKeyLabel: "OpenRouter API key",
  },
  {
    id: "xai",
    name: "xAI",
    description: "Grok models via SuperGrok / X Premium device code or API key.",
    supportsOAuth: true,
    oauthFlow: "device_code",
    oauthLabel: "Sign in with SuperGrok / X Premium",
    supportsApiKey: true,
    apiKeyLabel: "xAI API key",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek models with a DeepSeek API key.",
    supportsOAuth: false,
    supportsApiKey: true,
    apiKeyLabel: "DeepSeek API key",
  },
  {
    id: "groq",
    name: "Groq",
    description: "Fast hosted open-weight models via Groq API key.",
    supportsOAuth: false,
    supportsApiKey: true,
    apiKeyLabel: "Groq API key",
  },
  {
    id: "mistral",
    name: "Mistral",
    description: "Mistral models with a Mistral API key.",
    supportsOAuth: false,
    supportsApiKey: true,
    apiKeyLabel: "Mistral API key",
  },
  {
    id: "kimi-coding",
    name: "Kimi Code",
    description: "Kimi Code subscription via device-code sign-in or API key.",
    supportsOAuth: true,
    oauthFlow: "device_code",
    oauthLabel: "Sign in with Kimi Code",
    supportsApiKey: true,
    apiKeyLabel: "Kimi API key",
  },
];

const CURATED_BY_ID = new Map(CURATED_AI_PROVIDERS.map((provider) => [provider.id, provider]));

type ActiveLogin = {
  providerId: string;
  providerName: string;
  status: "pending" | "complete" | "cancelled" | "error";
  startedAt: string;
  completedAt?: string;
  deviceCode?: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
    expiresAt?: string;
  };
  authUrl?: {
    url: string;
    instructions?: string;
  };
  inputPrompt?: {
    type: "manual_code" | "text";
    message: string;
    placeholder?: string;
  };
  progress?: string;
  error?: string;
  abort: AbortController;
  submitInput?: (value: string) => void;
  rejectInput?: (error: Error) => void;
};

export type ProviderRefreshState = {
  attemptedAt?: string;
  refreshedAt?: string;
  error?: string;
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
  credential?: {
    type: string;
    expiresAt?: string;
    expired?: boolean;
  };
  refresh?: ProviderRefreshState;
  custom?: {
    baseUrl: string;
    api: CustomProviderApi;
    requiresApiKey: boolean;
    apiKeyConfigured: boolean;
    models: CustomModelConfig[];
  };
};

export type PiAuthSnapshot = {
  authPath: string;
  configured: boolean;
  status: {
    configured: boolean;
    source?: string;
    label?: string;
  };
  credential?: {
    type: string;
    expiresAt?: string;
    expired?: boolean;
  };
  refresh?: ProviderRefreshState;
  activeLogin?: Omit<ActiveLogin, "abort" | "submitInput" | "rejectInput">;
  providers: AiProviderAuthSummary[];
};

export type PiModelSummary = {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
};

type StoredModelsFile = {
  providers?: Record<string, StoredCustomProviderConfig>;
  [key: string]: unknown;
};

type StoredCustomProviderConfig = {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  authHeader?: boolean;
  models?: Array<{
    id: string;
    name?: string;
    reasoning?: boolean;
    contextWindow?: number;
    maxTokens?: number;
  }>;
  [key: string]: unknown;
};

export class PiAuthService {
  private readonly authPath: string;
  private readonly modelsPath: string;
  private modelRuntime: Promise<ModelRuntime>;
  private activeLogin?: ActiveLogin;
  private readonly refreshByProvider = new Map<string, ProviderRefreshState>();

  constructor(config: AppConfig) {
    fs.mkdirSync(config.piAgentDir, { recursive: true });
    this.authPath = path.join(config.piAgentDir, "auth.json");
    this.modelsPath = path.join(config.piAgentDir, "models.json");
    this.modelRuntime = this.createRuntime();
  }

  private createRuntime(): Promise<ModelRuntime> {
    return ModelRuntime.create({ authPath: this.authPath, modelsPath: this.modelsPath });
  }

  private async reloadRuntime(): Promise<ModelRuntime> {
    this.modelRuntime = this.createRuntime();
    return this.modelRuntime;
  }

  async listAvailableModels(): Promise<PiModelSummary[]> {
    const runtime = await this.modelRuntime;
    return (await runtime.getAvailable())
      .map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  async getSnapshot(): Promise<PiAuthSnapshot> {
    const runtime = await this.modelRuntime;
    await runtime.getAvailable();
    const providers = await this.buildProviderSummaries(runtime);
    const primary = providers.find((provider) => provider.id === OPENAI_CODEX_PROVIDER) ?? providers.find((provider) => provider.configured);
    const configured = providers.some((provider) => provider.configured);
    const codexStatus = runtime.getProviderAuthStatus(OPENAI_CODEX_PROVIDER);

    return {
      authPath: this.authPath,
      configured,
      status: primary?.configured
        ? { configured: true, source: primary.source, label: primary.label }
        : codexStatus,
      credential: primary?.credential,
      refresh: primary?.refresh,
      activeLogin: this.publicActiveLogin(),
      providers,
    };
  }

  async refreshExpiredCredential(): Promise<PiAuthSnapshot> {
    const runtime = await this.modelRuntime;
    const storedIds = this.listStoredProviderIds();
    const providerIds = new Set([OPENAI_CODEX_PROVIDER, ...storedIds]);

    for (const providerId of providerIds) {
      const credential = readStoredCredential(providerId, this.authPath);
      if (credential?.type !== "oauth" || Date.now() < credential.expires) continue;

      const attemptedAt = new Date().toISOString();
      this.refreshByProvider.set(providerId, { attemptedAt });

      let resolution;
      let refreshError: unknown;
      try {
        resolution = await runtime.getAuth(providerId);
      } catch (error) {
        refreshError = error;
      }
      const refreshedCredential = readStoredCredential(providerId, this.authPath);
      const providerName = this.providerDisplayName(runtime, providerId);

      if (resolution && refreshedCredential?.type === "oauth" && Date.now() < refreshedCredential.expires) {
        this.refreshByProvider.set(providerId, { attemptedAt, refreshedAt: new Date().toISOString() });
      } else {
        this.refreshByProvider.set(providerId, {
          attemptedAt,
          error: refreshError instanceof Error ? refreshError.message : `${providerName} OAuth refresh failed. Reconnect to continue.`,
        });
      }
    }

    return this.getSnapshot();
  }

  async startLogin(providerId = OPENAI_CODEX_PROVIDER, options?: { enterpriseDomain?: string }): Promise<PiAuthSnapshot> {
    const runtime = await this.modelRuntime;
    const provider = runtime.getProvider(providerId);
    const curated = CURATED_BY_ID.get(providerId);
    if (!provider || !provider.auth.oauth) {
      throw Object.assign(new Error(`OAuth sign-in is not supported for provider "${providerId}".`), { statusCode: 400 });
    }
    if (curated && !curated.supportsOAuth) {
      throw Object.assign(new Error(`OAuth sign-in is not enabled in the portal for "${curated.name}". Use an API key instead.`), { statusCode: 400 });
    }

    if (this.activeLogin?.status === "pending") {
      if (this.activeLogin.providerId === providerId) {
        return this.getSnapshot();
      }
      this.abortActiveLogin();
    }

    const providerName = curated?.name ?? provider.name ?? providerId;
    const activeLogin: ActiveLogin = {
      providerId,
      providerName,
      status: "pending",
      startedAt: new Date().toISOString(),
      abort: new AbortController(),
    };
    this.activeLogin = activeLogin;

    const enterpriseDomain = options?.enterpriseDomain?.trim() ?? "";

    void runtime
      .login(providerId, "oauth", {
        signal: activeLogin.abort.signal,
        prompt: async (prompt) => {
          if (prompt.type === "select") {
            const preferredIds = ["device_code", "copy_code", "device-code"];
            for (const candidate of preferredIds) {
              if (prompt.options.some((option) => option.id === candidate)) return candidate;
            }
            throw new Error(`Portal auth does not support any interactive login flow for ${providerName}.`);
          }
          if (prompt.type === "text" && providerId === "github-copilot") {
            return enterpriseDomain;
          }
          if (prompt.type === "manual_code" || prompt.type === "text") {
            return this.waitForManualInput(activeLogin, {
              type: prompt.type,
              message: prompt.message,
              placeholder: prompt.placeholder,
            }, prompt.signal);
          }
          throw new Error(`Portal auth does not support "${prompt.type}" prompts for ${providerName}.`);
        },
        notify: (info) => {
          if (info.type === "device_code") {
            activeLogin.deviceCode = {
              userCode: info.userCode,
              verificationUri: info.verificationUri,
              intervalSeconds: info.intervalSeconds,
              expiresInSeconds: info.expiresInSeconds,
              expiresAt: info.expiresInSeconds ? new Date(Date.now() + info.expiresInSeconds * 1000).toISOString() : undefined,
            };
            activeLogin.progress = `Waiting for ${providerName} authorization.`;
          } else if (info.type === "auth_url") {
            activeLogin.authUrl = {
              url: info.url,
              instructions: info.instructions,
            };
            activeLogin.progress = info.instructions ?? `Open the login page to authorize ${providerName}.`;
          } else {
            activeLogin.progress = info.message;
          }
        },
      })
      .then(async () => {
        this.restrictAuthFilePermissions();
        activeLogin.status = "complete";
        activeLogin.completedAt = new Date().toISOString();
        activeLogin.inputPrompt = undefined;
        activeLogin.progress = `${providerName} auth is configured.`;
        this.refreshByProvider.delete(providerId);
        await this.refreshProviderCatalogBestEffort(runtime, providerId);
        if (this.activeLogin === activeLogin) {
          this.activeLogin = undefined;
        }
      })
      .catch((error) => {
        activeLogin.completedAt = new Date().toISOString();
        activeLogin.inputPrompt = undefined;
        activeLogin.status = activeLogin.abort.signal.aborted ? "cancelled" : "error";
        activeLogin.error = error instanceof Error ? error.message : String(error);
        if (activeLogin.abort.signal.aborted && this.activeLogin === activeLogin) {
          this.activeLogin = undefined;
        }
      });

    return this.getSnapshot();
  }

  async startLoginAndWaitForDeviceCode(
    providerId = OPENAI_CODEX_PROVIDER,
    options?: { enterpriseDomain?: string },
    timeoutMs = 5000,
  ): Promise<PiAuthSnapshot> {
    await this.startLogin(providerId, options);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const snapshot = await this.getSnapshot();
      const login = snapshot.activeLogin;
      if (!login || login.deviceCode || login.authUrl || login.inputPrompt || login.status !== "pending") {
        return snapshot;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return this.getSnapshot();
  }

  async submitLoginInput(value: string, providerId?: string, timeoutMs = 15_000): Promise<PiAuthSnapshot> {
    const active = this.activeLogin;
    if (!active || active.status !== "pending" || !active.submitInput) {
      throw Object.assign(new Error("No active login is waiting for input."), { statusCode: 409 });
    }
    if (providerId && active.providerId !== providerId) {
      throw Object.assign(new Error(`Active login belongs to "${active.providerId}", not "${providerId}".`), { statusCode: 409 });
    }

    const submit = active.submitInput;
    active.submitInput = undefined;
    active.rejectInput = undefined;
    active.inputPrompt = undefined;
    active.progress = "Completing sign-in...";
    submit(value.trim());

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (this.activeLogin !== active || active.status !== "pending" || active.inputPrompt) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return this.getSnapshot();
  }

  async setApiKey(providerId: string, apiKey: string): Promise<PiAuthSnapshot> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw Object.assign(new Error("API key is required."), { statusCode: 400 });
    }

    const runtime = await this.modelRuntime;
    const provider = runtime.getProvider(providerId);
    if (!provider || !provider.auth.apiKey?.login) {
      throw Object.assign(new Error(`API key authentication is not supported for provider "${providerId}".`), { statusCode: 400 });
    }

    const controller = new AbortController();
    await runtime.login(providerId, "api_key", {
      signal: controller.signal,
      prompt: async (prompt) => {
        if (prompt.type === "secret" || prompt.type === "text") return trimmed;
        throw new Error(`Unsupported API key prompt "${prompt.type}" for provider "${providerId}".`);
      },
      notify: () => undefined,
    });
    this.restrictAuthFilePermissions();
    this.refreshByProvider.delete(providerId);
    await this.refreshProviderCatalogBestEffort(runtime, providerId);
    return this.getSnapshot();
  }

  async saveCustomProvider(input: CustomProviderInput): Promise<PiAuthSnapshot> {
    const id = input.id.trim().toLowerCase();
    const name = input.name.trim();
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");

    if (!CUSTOM_PROVIDER_ID_PATTERN.test(id)) {
      throw Object.assign(new Error("Provider ID must use lowercase letters, numbers, and hyphens."), { statusCode: 400 });
    }
    if (!name) {
      throw Object.assign(new Error("Provider display name is required."), { statusCode: 400 });
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      throw Object.assign(new Error("Enter a valid http:// or https:// base URL."), { statusCode: 400 });
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw Object.assign(new Error("Base URL must use http:// or https://."), { statusCode: 400 });
    }

    const models = deduplicateModels(input.models);
    if (models.length === 0) {
      throw Object.assign(new Error("Add at least one model ID for the custom provider."), { statusCode: 400 });
    }

    const runtime = await this.modelRuntime;
    const existingCustom = this.readCustomProviders();
    if (!existingCustom[id] && runtime.getProvider(id)) {
      throw Object.assign(new Error(`Provider ID "${id}" conflicts with a built-in provider. Choose a different ID.`), { statusCode: 400 });
    }

    const storedModels = this.readModelsFile();
    const nextProviders: Record<string, StoredCustomProviderConfig> = { ...(storedModels.providers ?? {}) };
    const providerEntry: StoredCustomProviderConfig = {
      name,
      baseUrl,
      api: input.api,
      authHeader: input.requiresApiKey,
      ...(input.requiresApiKey ? {} : { apiKey: NO_KEY_SENTINEL }),
      models: models.map((model) => ({
        id: model.id,
        name: model.name || model.id,
        reasoning: model.reasoning ?? false,
        contextWindow: model.contextWindow ?? 128_000,
        maxTokens: model.maxTokens ?? 16_384,
      })),
    };
    nextProviders[id] = providerEntry;
    this.writeModelsFile({ ...storedModels, providers: nextProviders });

    const reloaded = await this.reloadRuntime();
    if (!input.requiresApiKey || input.apiKey?.action === "clear") {
      await reloaded.logout(id).catch(() => undefined);
    } else if (input.apiKey?.action === "replace") {
      const keyValue = input.apiKey.value.trim();
      if (!keyValue) {
        throw Object.assign(new Error("API key cannot be blank."), { statusCode: 400 });
      }
      await reloaded.login(id, "api_key", {
        signal: new AbortController().signal,
        prompt: async () => keyValue,
        notify: () => undefined,
      });
      this.restrictAuthFilePermissions();
    }

    this.refreshByProvider.delete(id);
    return this.getSnapshot();
  }

  async deleteCustomProvider(providerId: string): Promise<PiAuthSnapshot> {
    const id = providerId.trim().toLowerCase();
    const storedModels = this.readModelsFile();
    const existing = storedModels.providers ?? {};
    if (!Object.hasOwn(existing, id)) {
      throw Object.assign(new Error(`Custom provider "${id}" was not found.`), { statusCode: 404 });
    }

    const nextProviders = { ...existing };
    delete nextProviders[id];
    this.writeModelsFile({ ...storedModels, providers: nextProviders });

    const runtime = await this.modelRuntime;
    await runtime.logout(id).catch(() => undefined);
    this.refreshByProvider.delete(id);
    await this.reloadRuntime();
    return this.getSnapshot();
  }

  async discoverCustomProviderModels(params: { baseUrl: string; apiKey?: string; providerId?: string }): Promise<CustomModelConfig[]> {
    const baseUrl = params.baseUrl.trim().replace(/\/+$/, "");
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      throw Object.assign(new Error("Enter a valid http:// or https:// base URL."), { statusCode: 400 });
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw Object.assign(new Error("Base URL must use http:// or https://."), { statusCode: 400 });
    }

    let token = params.apiKey?.trim();
    if (!token && params.providerId) {
      const stored = readStoredCredential(params.providerId, this.authPath);
      if (stored?.type === "api_key" && typeof stored.key === "string") {
        token = stored.key;
      }
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw Object.assign(
        new Error(`Endpoint returned HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`),
        { statusCode: 400 },
      );
    }

    const json = (await response.json()) as {
      data?: Array<{ id?: unknown; name?: unknown }>;
      models?: Array<{ id?: unknown; name?: unknown }>;
    };
    const rawItems = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    const discovered: CustomModelConfig[] = [];
    for (const item of rawItems) {
      const id = typeof item?.id === "string" && item.id.trim()
        ? item.id.trim()
        : typeof item?.name === "string" && item.name.trim()
          ? item.name.trim()
          : undefined;
      if (!id) continue;
      const name = typeof item?.name === "string" && item.name.trim() ? item.name.trim() : id;
      discovered.push({ id, name });
    }
    return deduplicateModels(discovered);
  }

  async cancelLogin(): Promise<PiAuthSnapshot> {
    this.abortActiveLogin();
    return this.getSnapshot();
  }

  async logout(providerId = OPENAI_CODEX_PROVIDER): Promise<PiAuthSnapshot> {
    if (this.activeLogin?.providerId === providerId) {
      this.abortActiveLogin();
    }
    await (await this.modelRuntime).logout(providerId);
    this.refreshByProvider.delete(providerId);
    return this.getSnapshot();
  }

  private abortActiveLogin(): void {
    if (this.activeLogin?.status === "pending") {
      this.activeLogin.rejectInput?.(new Error("Login cancelled"));
      this.activeLogin.abort.abort();
    }
    this.activeLogin = undefined;
  }

  private waitForManualInput(
    activeLogin: ActiveLogin,
    promptInfo: { type: "manual_code" | "text"; message: string; placeholder?: string },
    promptSignal?: AbortSignal,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const combined = promptSignal ? AbortSignal.any([activeLogin.abort.signal, promptSignal]) : activeLogin.abort.signal;
      if (combined.aborted) {
        reject(new Error("Login cancelled"));
        return;
      }
      const onAbort = () => {
        activeLogin.submitInput = undefined;
        activeLogin.rejectInput = undefined;
        activeLogin.inputPrompt = undefined;
        reject(new Error("Login cancelled"));
      };
      combined.addEventListener("abort", onAbort, { once: true });
      activeLogin.inputPrompt = promptInfo;
      activeLogin.submitInput = (value: string) => {
        combined.removeEventListener("abort", onAbort);
        resolve(value);
      };
      activeLogin.rejectInput = (error: Error) => {
        combined.removeEventListener("abort", onAbort);
        reject(error);
      };
    });
  }

  private publicActiveLogin(): PiAuthSnapshot["activeLogin"] {
    if (!this.activeLogin) return undefined;
    return {
      providerId: this.activeLogin.providerId,
      providerName: this.activeLogin.providerName,
      status: this.activeLogin.status,
      startedAt: this.activeLogin.startedAt,
      completedAt: this.activeLogin.completedAt,
      deviceCode: this.activeLogin.deviceCode,
      authUrl: this.activeLogin.authUrl,
      inputPrompt: this.activeLogin.inputPrompt,
      progress: this.activeLogin.progress,
      error: this.activeLogin.error,
    };
  }

  private async buildProviderSummaries(runtime: ModelRuntime): Promise<AiProviderAuthSummary[]> {
    const customProviders = this.readCustomProviders();
    const availableModels = await runtime.getAvailable();
    const availableCounts = new Map<string, number>();
    for (const model of availableModels) {
      availableCounts.set(model.provider, (availableCounts.get(model.provider) ?? 0) + 1);
    }

    const orderedIds: string[] = [];
    const seen = new Set<string>();
    const addId = (id: string) => {
      if (!seen.has(id)) {
        seen.add(id);
        orderedIds.push(id);
      }
    };

    for (const curated of CURATED_AI_PROVIDERS) addId(curated.id);
    for (const customId of Object.keys(customProviders).sort()) addId(customId);
    for (const provider of runtime.getProviders()) {
      if (runtime.getProviderAuthStatus(provider.id).configured) addId(provider.id);
    }

    const summaries: AiProviderAuthSummary[] = [];
    for (const id of orderedIds) {
      const customConfig = customProviders[id];
      const runtimeProvider = runtime.getProvider(id);
      const curated = CURATED_BY_ID.get(id);
      if (!customConfig && !runtimeProvider) continue;

      const authStatus = runtime.getProviderAuthStatus(id);
      const credential = readStoredCredential(id, this.authPath);
      const modelCount = authStatus.configured
        ? (availableCounts.get(id) ?? runtime.getModels(id).length)
        : (customConfig?.models?.length ?? runtime.getModels(id).length);

      const isCustom = Boolean(customConfig);
      const requiresApiKey = isCustom ? customConfig!.authHeader !== false && customConfig!.apiKey !== NO_KEY_SENTINEL : true;
      const apiKeyConfigured = credential?.type === "api_key" || (authStatus.configured && authStatus.source !== "models_json_key");

      let authType: AiProviderAuthSummary["authType"];
      if (!authStatus.configured) {
        authType = undefined;
      } else if (credential?.type === "oauth") {
        authType = "oauth";
      } else if (credential?.type === "api_key") {
        authType = "api_key";
      } else if (isCustom && !requiresApiKey) {
        authType = "none";
      } else if (authStatus.source === "environment") {
        authType = "env";
      } else {
        authType = "api_key";
      }

      summaries.push({
        id,
        name: customConfig?.name || curated?.name || runtimeProvider?.name || id,
        kind: isCustom ? "custom" : "builtin",
        description: curated?.description ?? (isCustom ? `Custom ${customConfig!.api || "openai-completions"} endpoint at ${customConfig!.baseUrl}` : undefined),
        configured: authStatus.configured,
        authType,
        source: authStatus.source,
        label: authStatus.label,
        supportsOAuth: !isCustom && Boolean(curated ? curated.supportsOAuth : runtimeProvider?.auth.oauth),
        oauthFlow: curated?.oauthFlow,
        oauthLabel: curated?.oauthLabel ?? runtimeProvider?.auth.oauth?.loginLabel ?? runtimeProvider?.auth.oauth?.name,
        supportsEnterpriseDomain: curated?.supportsEnterpriseDomain,
        supportsApiKey: isCustom ? true : Boolean(curated ? curated.supportsApiKey : runtimeProvider?.auth.apiKey?.login),
        apiKeyLabel: curated?.apiKeyLabel ?? runtimeProvider?.auth.apiKey?.name,
        modelCount,
        credential: credential
          ? {
              type: credential.type,
              expiresAt: credential.type === "oauth" ? new Date(credential.expires).toISOString() : undefined,
              expired: credential.type === "oauth" ? Date.now() >= credential.expires : undefined,
            }
          : undefined,
        refresh: this.refreshByProvider.get(id),
        custom: isCustom && customConfig
          ? {
              baseUrl: customConfig.baseUrl ?? "",
              api: normalizeCustomApi(customConfig.api),
              requiresApiKey,
              apiKeyConfigured,
              models: (customConfig.models ?? []).map((model) => ({
                id: model.id,
                name: model.name,
                reasoning: model.reasoning,
                contextWindow: model.contextWindow,
                maxTokens: model.maxTokens,
              })),
            }
          : undefined,
      });
    }

    return summaries;
  }

  private providerDisplayName(runtime: ModelRuntime, providerId: string): string {
    return CURATED_BY_ID.get(providerId)?.name ?? runtime.getProvider(providerId)?.name ?? providerId;
  }

  private listStoredProviderIds(): string[] {
    try {
      if (!fs.existsSync(this.authPath)) return [];
      const raw = JSON.parse(fs.readFileSync(this.authPath, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      return Object.keys(raw);
    } catch {
      return [];
    }
  }

  private readModelsFile(): StoredModelsFile {
    try {
      if (!fs.existsSync(this.modelsPath)) return {};
      const raw = JSON.parse(fs.readFileSync(this.modelsPath, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      return raw as StoredModelsFile;
    } catch {
      return {};
    }
  }

  private readCustomProviders(): Record<string, StoredCustomProviderConfig> {
    const file = this.readModelsFile();
    if (!file.providers || typeof file.providers !== "object" || Array.isArray(file.providers)) {
      return {};
    }
    return file.providers;
  }

  private writeModelsFile(data: StoredModelsFile): void {
    fs.mkdirSync(path.dirname(this.modelsPath), { recursive: true });
    const tempPath = `${this.modelsPath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, this.modelsPath);
  }

  private restrictAuthFilePermissions(): void {
    try {
      if (fs.existsSync(this.authPath)) {
        fs.chmodSync(this.authPath, 0o600);
      }
    } catch {
      return;
    }
  }

  private async refreshProviderCatalogBestEffort(runtime: ModelRuntime, providerId: string): Promise<void> {
    try {
      await runtime.refresh({
        providers: [providerId],
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return;
    }
  }
}

function normalizeCustomApi(value: string | undefined): CustomProviderApi {
  if (value === "openai-responses" || value === "anthropic-messages") return value;
  return "openai-completions";
}

function deduplicateModels(models: CustomModelConfig[]): CustomModelConfig[] {
  const seen = new Set<string>();
  const result: CustomModelConfig[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      name: model.name?.trim() || id,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    });
  }
  return result;
}

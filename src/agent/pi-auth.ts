import fs from "node:fs";
import path from "node:path";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const DEVICE_CODE_METHOD = "device_code";

type ActiveLogin = {
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
  progress?: string;
  error?: string;
  abort: AbortController;
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
  refresh?: {
    attemptedAt?: string;
    refreshedAt?: string;
    error?: string;
  };
  activeLogin?: Omit<ActiveLogin, "abort">;
};

export type PiModelSummary = {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
};

export class PiAuthService {
  private readonly authPath: string;
  private readonly modelRuntime: Promise<ModelRuntime>;
  private activeLogin?: ActiveLogin;
  private refresh?: PiAuthSnapshot["refresh"];

  constructor(config: AppConfig) {
    fs.mkdirSync(config.piAgentDir, { recursive: true });
    this.authPath = path.join(config.piAgentDir, "auth.json");
    this.modelRuntime = ModelRuntime.create({ authPath: this.authPath, modelsPath: path.join(config.piAgentDir, "models.json") });
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
    const authStatus = runtime.getProviderAuthStatus(OPENAI_CODEX_PROVIDER);
    const credential = readStoredCredential(OPENAI_CODEX_PROVIDER, this.authPath);

    return {
      authPath: this.authPath,
      configured: authStatus.configured,
      status: authStatus,
      credential: credential
        ? {
            type: credential.type,
            expiresAt: credential.type === "oauth" ? new Date(credential.expires).toISOString() : undefined,
            expired: credential.type === "oauth" ? Date.now() >= credential.expires : undefined,
          }
        : undefined,
      refresh: this.refresh,
      activeLogin: this.activeLogin
        ? {
            status: this.activeLogin.status,
            startedAt: this.activeLogin.startedAt,
            completedAt: this.activeLogin.completedAt,
            deviceCode: this.activeLogin.deviceCode,
            progress: this.activeLogin.progress,
            error: this.activeLogin.error,
          }
        : undefined,
    };
  }

  async refreshExpiredCredential(): Promise<PiAuthSnapshot> {
    const runtime = await this.modelRuntime;
    const credential = readStoredCredential(OPENAI_CODEX_PROVIDER, this.authPath);
    if (credential?.type !== "oauth" || Date.now() < credential.expires) {
      return this.getSnapshot();
    }

    const attemptedAt = new Date().toISOString();
    this.refresh = { attemptedAt };

    let resolution;
    let refreshError: unknown;
    try {
      resolution = await runtime.getAuth(OPENAI_CODEX_PROVIDER);
    } catch (error) {
      refreshError = error;
    }
    const refreshedCredential = readStoredCredential(OPENAI_CODEX_PROVIDER, this.authPath);

    if (resolution && refreshedCredential?.type === "oauth" && Date.now() < refreshedCredential.expires) {
      this.refresh = { attemptedAt, refreshedAt: new Date().toISOString() };
    } else {
      this.refresh = {
        attemptedAt,
        error: refreshError instanceof Error ? refreshError.message : "OpenAI OAuth refresh failed. Reconnect Pi Auth to continue.",
      };
    }

    return this.getSnapshot();
  }

  async startLogin(): Promise<PiAuthSnapshot> {
    const runtime = await this.modelRuntime;
    if (this.activeLogin?.status === "pending") {
      return this.getSnapshot();
    }

    const activeLogin: ActiveLogin = {
      status: "pending",
      startedAt: new Date().toISOString(),
      abort: new AbortController(),
    };
    this.activeLogin = activeLogin;

    void runtime
      .login(OPENAI_CODEX_PROVIDER, "oauth", {
        signal: activeLogin.abort.signal,
        prompt: async (prompt) => {
          if (prompt.type === "select" && prompt.options.some((option) => option.id === DEVICE_CODE_METHOD)) return DEVICE_CODE_METHOD;
          throw new Error("Portal auth only supports the device-code login flow.");
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
            activeLogin.progress = "Waiting for OpenAI authorization.";
          } else if (info.type === "auth_url") {
            activeLogin.progress = info.instructions ?? `Open ${info.url} to continue.`;
          } else {
            activeLogin.progress = info.message;
          }
        },
      })
      .then(() => {
        activeLogin.status = "complete";
        activeLogin.completedAt = new Date().toISOString();
        activeLogin.progress = "OpenAI Codex auth is configured.";
        if (this.activeLogin === activeLogin) {
          this.activeLogin = undefined;
        }
      })
      .catch((error) => {
        activeLogin.completedAt = new Date().toISOString();
        activeLogin.status = activeLogin.abort.signal.aborted ? "cancelled" : "error";
        activeLogin.error = error instanceof Error ? error.message : String(error);
        if (activeLogin.abort.signal.aborted && this.activeLogin === activeLogin) {
          this.activeLogin = undefined;
        }
      });

    return this.getSnapshot();
  }

  async startLoginAndWaitForDeviceCode(timeoutMs = 5000): Promise<PiAuthSnapshot> {
    await this.startLogin();
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const snapshot = await this.getSnapshot();
      if (snapshot.activeLogin?.deviceCode || snapshot.activeLogin?.status !== "pending") {
        return snapshot;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return this.getSnapshot();
  }

  async cancelLogin(): Promise<PiAuthSnapshot> {
    if (this.activeLogin?.status === "pending") {
      this.activeLogin.abort.abort();
    }

    this.activeLogin = undefined;

    return this.getSnapshot();
  }

  async logout(): Promise<PiAuthSnapshot> {
    await this.cancelLogin();
    await (await this.modelRuntime).logout(OPENAI_CODEX_PROVIDER);
    this.activeLogin = undefined;
    return this.getSnapshot();
  }
}

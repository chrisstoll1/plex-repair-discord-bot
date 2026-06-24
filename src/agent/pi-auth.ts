import fs from "node:fs";
import path from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
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
  activeLogin?: Omit<ActiveLogin, "abort">;
};

export class PiAuthService {
  private readonly authPath: string;
  private readonly authStorage: AuthStorage;
  private activeLogin?: ActiveLogin;

  constructor(config: AppConfig) {
    fs.mkdirSync(config.piAgentDir, { recursive: true });
    this.authPath = path.join(config.piAgentDir, "auth.json");
    this.authStorage = AuthStorage.create(this.authPath);
  }

  getSnapshot(): PiAuthSnapshot {
    this.authStorage.reload();
    const authStatus = this.authStorage.getAuthStatus(OPENAI_CODEX_PROVIDER);
    const credential = this.authStorage.get(OPENAI_CODEX_PROVIDER);

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

  startLogin(): PiAuthSnapshot {
    if (this.activeLogin?.status === "pending") {
      return this.getSnapshot();
    }

    const activeLogin: ActiveLogin = {
      status: "pending",
      startedAt: new Date().toISOString(),
      abort: new AbortController(),
    };
    this.activeLogin = activeLogin;

    void this.authStorage
      .login(OPENAI_CODEX_PROVIDER, {
        onSelect: async () => DEVICE_CODE_METHOD,
        onDeviceCode: (info) => {
          activeLogin.deviceCode = {
            userCode: info.userCode,
            verificationUri: info.verificationUri,
            intervalSeconds: info.intervalSeconds,
            expiresInSeconds: info.expiresInSeconds,
            expiresAt: info.expiresInSeconds ? new Date(Date.now() + info.expiresInSeconds * 1000).toISOString() : undefined,
          };
          activeLogin.progress = "Waiting for OpenAI authorization.";
        },
        onAuth: (info) => {
          activeLogin.progress = info.instructions ?? `Open ${info.url} to continue.`;
        },
        onPrompt: async () => {
          throw new Error("Portal auth only supports the device-code login flow.");
        },
        onProgress: (message) => {
          activeLogin.progress = message;
        },
        onManualCodeInput: async () => {
          throw new Error("Manual browser callback login is not supported in the portal.");
        },
        signal: activeLogin.abort.signal,
      })
      .then(() => {
        activeLogin.status = "complete";
        activeLogin.completedAt = new Date().toISOString();
        activeLogin.progress = "OpenAI Codex auth is configured.";
        this.authStorage.reload();
      })
      .catch((error) => {
        activeLogin.completedAt = new Date().toISOString();
        activeLogin.status = activeLogin.abort.signal.aborted ? "cancelled" : "error";
        activeLogin.error = error instanceof Error ? error.message : String(error);
      });

    return this.getSnapshot();
  }

  cancelLogin(): PiAuthSnapshot {
    if (this.activeLogin?.status === "pending") {
      this.activeLogin.abort.abort();
      this.activeLogin.status = "cancelled";
      this.activeLogin.completedAt = new Date().toISOString();
    }

    return this.getSnapshot();
  }

  logout(): PiAuthSnapshot {
    this.cancelLogin();
    this.authStorage.logout(OPENAI_CODEX_PROVIDER);
    this.authStorage.reload();
    return this.getSnapshot();
  }
}

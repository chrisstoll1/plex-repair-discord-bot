import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type PiAuthSnapshot } from "../lib/api";
import { PiAuthPanel } from "./ai-providers-panel";
import { ToastProvider } from "./toast";

const baseSnapshot: PiAuthSnapshot = {
  configured: true,
  status: { configured: true },
  providers: [
    {
      id: "openai-codex",
      name: "OpenAI Codex",
      kind: "builtin",
      description: "ChatGPT Plus/Pro subscription",
      configured: true,
      authType: "oauth",
      supportsOAuth: true,
      oauthFlow: "device_code",
      supportsApiKey: false,
      modelCount: 8,
    },
    {
      id: "anthropic",
      name: "Anthropic",
      kind: "builtin",
      description: "Claude models",
      configured: false,
      supportsOAuth: true,
      oauthFlow: "copy_code",
      supportsApiKey: true,
      apiKeyLabel: "Anthropic API key",
      modelCount: 18,
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <PiAuthPanel />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("PiAuthPanel", () => {
  it("saves an API key for a curated provider and supports copy-code OAuth submission", async () => {
    vi.spyOn(api, "getPiAuth").mockResolvedValue(baseSnapshot);
    const saveKey = vi.spyOn(api, "savePiApiKey").mockResolvedValue({
      ...baseSnapshot,
      providers: baseSnapshot.providers.map((provider) =>
        provider.id === "anthropic" ? { ...provider, configured: true, authType: "api_key" } : provider,
      ),
    });

    renderPanel();
    expect(await screen.findByText("AI providers & authentication")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "API key / token" }));
    fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-ant-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(saveKey).toHaveBeenCalledWith("anthropic", "sk-ant-test"));
  });

  it("creates a custom OpenAI-compatible endpoint", async () => {
    vi.spyOn(api, "getPiAuth").mockResolvedValue(baseSnapshot);
    const saveCustom = vi.spyOn(api, "saveCustomAiProvider").mockResolvedValue({
      ...baseSnapshot,
      providers: [
        ...baseSnapshot.providers,
        {
          id: "local-ollama",
          name: "Local Ollama",
          kind: "custom",
          configured: true,
          authType: "none",
          supportsOAuth: false,
          supportsApiKey: true,
          modelCount: 1,
          custom: {
            baseUrl: "http://localhost:11434/v1",
            api: "openai-completions",
            requiresApiKey: false,
            apiKeyConfigured: false,
            models: [{ id: "llama3.3", name: "llama3.3" }],
          },
        },
      ],
    });

    renderPanel();
    expect(await screen.findByText("AI providers & authentication")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Custom endpoint" }));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Local Ollama" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "http://localhost:11434/v1" } });
    fireEvent.change(screen.getByLabelText("Model IDs (one per line or comma-separated)"), { target: { value: "llama3.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save custom endpoint" }));

    await waitFor(() =>
      expect(saveCustom).toHaveBeenCalledWith({
        id: "local-ollama",
        name: "Local Ollama",
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
        requiresApiKey: false,
        apiKey: { action: "clear" },
        models: [{ id: "llama3.3", name: "llama3.3" }],
      }),
    );
  });
});

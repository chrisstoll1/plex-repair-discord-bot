import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Settings } from "../lib/api";
import { ToastProvider } from "./toast";
import { SettingsEditor } from "./settings-editor";

const settings: Settings = {
  discord: { token: { configured: true }, applicationId: "123", allowedGuildIds: "", allowedChannelIds: "", repairRoleIds: "", allowDirectMessages: false, reactionsEnabled: true },
  sonarr: { url: "http://sonarr:8989", apiKey: { configured: true } },
  radarr: { url: "http://radarr:7878", apiKey: { configured: true } },
  plex: { url: "http://plex:32400", token: { configured: true } },
  ai: { modelProvider: "openai-codex", modelId: "gpt-5.1-codex", thinkingLevel: "medium", serviceTier: "default" },
  timeouts: { standardSeconds: 30, releaseLookupSeconds: 60 },
  repair: { requireConfirmation: true, allowDestructive: false },
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

describe("SettingsEditor", () => {
  it("populates bot settings after data loads during client navigation", async () => {
    vi.spyOn(api, "getSettings").mockResolvedValue(settings);
    vi.spyOn(api, "getAiModels").mockResolvedValue([
      { provider: "openai-codex", id: "gpt-5.1-codex", name: "GPT-5.1 Codex", reasoning: true, contextWindow: 200_000 },
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([{ path: "/bot-settings", element: <SettingsEditor mode="bot" /> }], { initialEntries: ["/bot-settings"] });

    render(<QueryClientProvider client={queryClient}><ToastProvider><RouterProvider router={router} /></ToastProvider></QueryClientProvider>);

    expect(await screen.findByRole("combobox", { name: "Model provider" })).toHaveValue("openai-codex");
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue("gpt-5.1-codex");
    expect(screen.getByRole("combobox", { name: "Thinking level" })).toHaveValue("medium");
  });

  it("keeps stored model values selected while authenticated models load", async () => {
    let resolveModels!: (models: Awaited<ReturnType<typeof api.getAiModels>>) => void;
    vi.spyOn(api, "getSettings").mockResolvedValue(settings);
    vi.spyOn(api, "getAiModels").mockImplementation(() => new Promise((resolve) => { resolveModels = resolve; }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([{ path: "/bot-settings", element: <SettingsEditor mode="bot" /> }], { initialEntries: ["/bot-settings"] });

    render(<QueryClientProvider client={queryClient}><ToastProvider><RouterProvider router={router} /></ToastProvider></QueryClientProvider>);

    expect(await screen.findByRole("combobox", { name: "Model provider" })).toHaveValue("openai-codex");
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue("gpt-5.1-codex");

    resolveModels([{ provider: "openai-codex", id: "gpt-5.1-codex", name: "GPT-5.1 Codex", reasoning: true, contextWindow: 200_000 }]);

    expect(await screen.findByRole("option", { name: "GPT-5.1 Codex (gpt-5.1-codex)" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Model provider" })).toHaveValue("openai-codex");
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue("gpt-5.1-codex");
  });
});

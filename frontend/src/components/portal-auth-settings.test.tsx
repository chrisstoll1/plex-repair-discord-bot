import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { PortalAuthSettings } from "./portal-auth-settings";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
function renderSettings() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PortalAuthSettings /></QueryClientProvider>);
}

describe("portal Basic auth settings", () => {
  it("starts off and lets users enable Basic auth with username and password entirely in the UI", async () => {
    vi.spyOn(api, "getPortalAuth").mockResolvedValue({ enabled: false, username: "admin", passwordConfigured: false });
    const save = vi.spyOn(api, "updatePortalAuth").mockResolvedValue({ enabled: true, username: "owner", passwordConfigured: true });
    renderSettings();
    const toggle = await screen.findByRole("switch", { name: "Enable Basic authentication" });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByLabelText("Password", { exact: true })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText("Username", { exact: true }), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("Password", { exact: true }), { target: { value: "a-new-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Save portal access" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ enabled: true, username: "owner", password: "a-new-password" }, expect.anything()));
    expect(await screen.findByRole("status")).toHaveTextContent("Basic authentication enabled");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveValue("");
  });

  it("lets authenticated users disable protection without replacing the saved credentials", async () => {
    vi.spyOn(api, "getPortalAuth").mockResolvedValue({ enabled: true, username: "owner", passwordConfigured: true });
    const save = vi.spyOn(api, "updatePortalAuth").mockResolvedValue({ enabled: false, username: "owner", passwordConfigured: true });
    renderSettings();
    fireEvent.click(await screen.findByRole("switch", { name: "Enable Basic authentication" }));
    fireEvent.click(screen.getByRole("button", { name: "Save portal access" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ enabled: false, username: "owner" }, expect.anything()));
    expect(await screen.findByRole("status")).toHaveTextContent("Basic authentication disabled");
  });

  it("keeps a failed save visible so settings can be corrected", async () => {
    vi.spyOn(api, "getPortalAuth").mockResolvedValue({ enabled: true, username: "owner", passwordConfigured: true });
    vi.spyOn(api, "updatePortalAuth").mockRejectedValue(new Error("Username cannot contain colons."));
    renderSettings();
    fireEvent.change(await screen.findByLabelText("Username", { exact: true }), { target: { value: "bad:name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save portal access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Username cannot contain colons");
    expect(screen.getByLabelText("Username", { exact: true })).toHaveValue("bad:name");
  });
});

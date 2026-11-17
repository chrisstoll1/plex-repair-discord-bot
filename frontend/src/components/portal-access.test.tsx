import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { PortalAccess } from "./portal-access";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderPortal() {
  const client = new QueryClient();
  client.setQueryData(["private-settings"], { retained: true });
  render(<QueryClientProvider client={client}><PortalAccess><p>Private administration</p></PortalAccess></QueryClientProvider>);
  return client;
}

describe("portal access", () => {
  it("keeps administration hidden until first-time setup succeeds and clears previous cached data", async () => {
    vi.spyOn(api, "getPortalSession").mockResolvedValue({ authenticated: false, setupRequired: true });
    const setup = vi.spyOn(api, "setupPortal").mockResolvedValue({ authenticated: true, setupRequired: false });
    const client = renderPortal();
    expect(screen.queryByText("Private administration")).not.toBeInTheDocument();
    await screen.findByLabelText("Setup token");
    fireEvent.change(screen.getByLabelText("Setup token"), { target: { value: "one-time-test-token" } });
    fireEvent.change(screen.getByLabelText("Administrator password"), { target: { value: "a-test-password" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "different-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "Create administrator account" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Passwords do not match");
    expect(setup).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "a-test-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "Create administrator account" }).closest("form")!);
    expect(await screen.findByText("Private administration")).toBeInTheDocument();
    expect(client.getQueryData(["private-settings"])).toBeUndefined();
    expect(setup).toHaveBeenCalledWith("one-time-test-token", "a-test-password");
  });

  it("removes administration and cached data when the server expires a session", async () => {
    const session = vi.spyOn(api, "getPortalSession").mockResolvedValueOnce({ authenticated: true, setupRequired: false }).mockResolvedValue({ authenticated: false, setupRequired: false });
    const client = renderPortal();
    await screen.findByText("Private administration");
    window.dispatchEvent(new Event("portal-signed-out"));
    await screen.findByLabelText("Administrator password");
    expect(screen.queryByText("Private administration")).not.toBeInTheDocument();
    expect(client.getQueryData(["private-settings"])).toBeUndefined();
    await waitFor(() => expect(session).toHaveBeenCalledTimes(2));
  });
});

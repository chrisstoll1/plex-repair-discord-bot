import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type PortalSession } from "../lib/api";
import { LoginForm, PortalAccountMenu, PortalSessionProvider } from "./portal-session";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const signedIn: PortalSession = { enabled: true, authenticated: true, username: "owner", csrfToken: "test-csrf" };
function renderPortal(session: PortalSession) {
  vi.spyOn(api, "getPortalSession").mockResolvedValue(session);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><PortalSessionProvider><PortalAccountMenu /><p>Private administration data</p></PortalSessionProvider></QueryClientProvider>);
  return client;
}

describe("portal form sessions", () => {
  it("gates administration content until a successful form login", async () => {
    const login = vi.spyOn(api, "login").mockResolvedValue(signedIn);
    renderPortal({ enabled: true, authenticated: false });
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByText("Private administration data")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "form-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Private administration data")).toBeInTheDocument();
    expect(login).toHaveBeenCalledWith({ username: "owner", password: "form-password" }, expect.anything());
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("signs out and removes cached private data", async () => {
    vi.spyOn(api, "logout").mockResolvedValue(undefined);
    const client = renderPortal(signedIn);
    client.setQueryData(["settings"], { secretHistory: "private" });
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(client.getQueryData(["settings"])).toBeUndefined();
    expect(screen.queryByText("Private administration data")).not.toBeInTheDocument();
  });

  it("replaces an expired session with the form without leaving administration content visible", async () => {
    const client = renderPortal(signedIn);
    expect(await screen.findByText("Private administration data")).toBeInTheDocument();
    client.setQueryData(["repairs"], ["private-repair"]);
    window.dispatchEvent(new Event("portal-session-expired"));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(client.getQueryData(["repairs"])).toBeUndefined();
  });

  it("shows failed login inline, retains username and clears the password", async () => {
    vi.spyOn(api, "login").mockRejectedValue(new Error("Incorrect username or password."));
    render(<QueryClientProvider client={new QueryClient()}><LoginForm onSuccess={vi.fn()} /></QueryClientProvider>);
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect username or password");
    await waitFor(() => expect(screen.getByLabelText("Password")).toHaveValue(""));
    expect(screen.getByLabelText("Username")).toHaveValue("owner");
  });

  it("keeps the portal open with no sign-out control when login is disabled", async () => {
    renderPortal({ enabled: false, authenticated: false });
    expect(await screen.findByText("Private administration data")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });
});

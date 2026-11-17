import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VersionLink } from "./layout";
import { AppLayout } from "./layout";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { SettingsLayout } from "../pages/settings";

describe("VersionLink", () => {
  it("links the build version to the source repository", () => {
    render(<VersionLink />);

    const link = screen.getByRole("link", { name: "dev" });
    expect(link).toHaveAttribute("href", "https://github.com/chrisstoll1/plex-repair-discord-bot");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });
});

describe("administration navigation", () => {
  it("groups security under Settings and keeps the same page names in the navigation", () => {
    const router = createMemoryRouter([{ element: <AppLayout />, children: [{ path: "/settings", element: <SettingsLayout />, children: [{ path: "security", element: <p>Security content</p> }] }] }], { initialEntries: ["/settings/security"] });
    render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Security" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Security" })).toBeInTheDocument();
    for (const name of ["Overview", "Repairs", "Agent tasks", "Connections", "Discord", "AI", "Repair policy"]) expect(screen.getByRole("link", { name })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Bot Settings" })).not.toBeInTheDocument();
    expect(screen.queryByText("Running", { exact: true })).not.toBeInTheDocument();
  });
});

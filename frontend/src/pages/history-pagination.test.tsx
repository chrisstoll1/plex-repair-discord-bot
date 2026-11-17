import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { api, type AgentTask, type RepairCase, type RepairCaseActivity, type RepairFilter, type RepairPage } from "../lib/api";
import { TasksPage } from "./tasks";
import { RepairsPage } from "./repairs";

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); vi.restoreAllMocks(); });
function renderPage(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><RouterProvider router={createMemoryRouter([{ path: "/", element }])} /></QueryClientProvider>);
}

describe("history pagination", () => {
  it("pages tasks, resets on page-size changes, and returns to the empty state after clearing", async () => {
    let rows: AgentTask[] = Array.from({ length: 31 }, (_, index) => ({ id: `task-${index}`, title: `Task ${index + 1}`, status: "succeeded", channelId: "channel", userId: "user", toolProfile: "read", prompt: "Synthetic task", attempts: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" }));
    const load = vi.spyOn(api, "getTaskPage").mockImplementation(async (offset, limit) => ({ tasks: rows.slice(offset, offset + limit), counts: { queued: 0, running: 0, succeeded: rows.length, failed: 0, cancelled: 0 }, pagination: { total: rows.length, offset, limit } }));
    vi.spyOn(api, "clearTaskHistory").mockImplementation(async () => { const deleted = rows.length; rows = []; return { deleted }; });
    renderPage(<TasksPage />);
    expect(await screen.findByRole("heading", { name: "Task 1" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Task 11" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next agent tasks page" }));
    expect(await screen.findByRole("heading", { name: "Task 11" })).toBeInTheDocument();
    expect(load).toHaveBeenLastCalledWith(10, 10);
    fireEvent.change(screen.getByRole("combobox", { name: "Agent tasks per page" }), { target: { value: "25" } });
    expect(await screen.findByRole("heading", { name: "Task 1" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Task 25" })).toBeInTheDocument();
    expect(load).toHaveBeenLastCalledWith(0, 25);
    fireEvent.click(screen.getByRole("button", { name: "Next agent tasks page" }));
    expect(await screen.findByRole("heading", { name: "Task 31" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next agent tasks page" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Clear history" }));
    expect(await screen.findByText("No agent tasks yet")).toBeInTheDocument();
    expect(load).toHaveBeenLastCalledWith(0, 25);
  });

  it("resets repair pages on filters and resets timeline pages when selecting another case", async () => {
    const rows: RepairCase[] = Array.from({ length: 31 }, (_, index) => ({ id: `repair-${index}`, title: `Case ${index + 1}`, status: index < 26 ? "resolved" : "blocked", createdAt: "2026-01-01", updatedAt: "2026-01-01" }));
    const counts: RepairPage["counts"] = { working: 0, waiting: 0, ready: 0, verifying: 0, resolved: 26, needs_input: 0, blocked: 5, exhausted: 0, cancelled: 0 };
    const load = vi.spyOn(api, "getRepairPage").mockImplementation(async (offset, limit, group: RepairFilter) => {
      const filtered = group === "attention" ? rows.filter((row) => row.status === "blocked") : group === "completed" ? rows.filter((row) => row.status === "resolved") : rows;
      return { repairs: filtered.slice(offset, offset + limit), counts, pagination: { total: filtered.length, offset, limit } };
    });
    const entries: RepairCaseActivity[] = Array.from({ length: 45 }, (_, index) => ({ id: `event-${index}`, type: "progress", message: `Update ${index + 1}`, createdAt: "2026-01-01" }));
    const timeline = vi.spyOn(api, "getRepairTimelinePage").mockImplementation(async (_id, offset, limit) => ({ timeline: entries.slice(offset, offset + limit), pagination: { total: entries.length, offset, limit } }));
    renderPage(<RepairsPage />);
    expect(await screen.findByRole("heading", { name: "Case 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next repairs page" }));
    expect(await screen.findByRole("heading", { name: "Case 11" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Needs attention 5" }));
    expect(await screen.findByRole("heading", { name: "Case 27" })).toBeInTheDocument();
    expect(load).toHaveBeenLastCalledWith(0, 10, "attention");
    expect(screen.getByRole("button", { name: "Next repairs page" })).toBeDisabled();
    fireEvent.click(screen.getByRole("heading", { name: "Case 27" }).closest("button")!);
    expect(await screen.findByText("Update 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next timeline page" }));
    expect(await screen.findByText("Update 21")).toBeInTheDocument();
    expect(timeline).toHaveBeenLastCalledWith("repair-26", 20, 20);
    fireEvent.click(screen.getByRole("heading", { name: "Case 28" }).closest("button")!);
    expect(await screen.findByText("Update 1")).toBeInTheDocument();
    await waitFor(() => expect(timeline).toHaveBeenLastCalledWith("repair-27", 0, 20));
  });
});

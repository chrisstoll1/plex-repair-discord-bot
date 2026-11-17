import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { AppLayout } from "./components/layout";
import { LoadingState } from "./components/states";
import { ToastProvider } from "./components/toast";
import { PortalSessionProvider } from "./components/portal-session";
import "./styles.css";

const OverviewPage = lazy(() => import("./pages/overview").then((module) => ({ default: module.OverviewPage })));
const ConnectionsPage = lazy(() => import("./pages/settings").then((module) => ({ default: module.ConnectionsPage })));
const SettingsLayout = lazy(() => import("./pages/settings").then((module) => ({ default: module.SettingsLayout })));
const DiscordSettingsPage = lazy(() => import("./pages/settings").then((module) => ({ default: module.DiscordSettingsPage })));
const AiSettingsPage = lazy(() => import("./pages/settings").then((module) => ({ default: module.AiSettingsPage })));
const RepairPolicyPage = lazy(() => import("./pages/settings").then((module) => ({ default: module.RepairPolicyPage })));
const SecurityPage = lazy(() => import("./pages/settings").then((module) => ({ default: module.SecurityPage })));
const TasksPage = lazy(() => import("./pages/tasks").then((module) => ({ default: module.TasksPage })));
const RepairsPage = lazy(() => import("./pages/repairs").then((module) => ({ default: module.RepairsPage })));

function RouteFallback({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<LoadingState label="Loading view" />}>{children}</Suspense>;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

const router = createBrowserRouter([{
  element: <AppLayout />,
  children: [
    { index: true, element: <RouteFallback><OverviewPage /></RouteFallback> },
    { path: "settings", element: <RouteFallback><SettingsLayout /></RouteFallback>, children: [
      { index: true, element: <Navigate to="connections" replace /> },
      { path: "connections", element: <RouteFallback><ConnectionsPage /></RouteFallback> },
      { path: "discord", element: <DiscordSettingsPage /> },
      { path: "ai", element: <AiSettingsPage /> },
      { path: "repair-policy", element: <RepairPolicyPage /> },
      { path: "security", element: <SecurityPage /> },
    ] },
    { path: "connections", element: <Navigate to="/settings/connections" replace /> },
    { path: "bot-settings", element: <Navigate to="/settings/discord" replace /> },
    { path: "tasks", element: <RouteFallback><TasksPage /></RouteFallback> },
    { path: "repairs", element: <RouteFallback><RepairsPage /></RouteFallback> },
    { path: "account", element: <Navigate to="/settings/security" replace /> },
    { path: "*", element: <Navigate to="/" replace /> },
  ],
}]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PortalSessionProvider><ToastProvider><RouterProvider router={router} /></ToastProvider></PortalSessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);

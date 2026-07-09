import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { AppLayout } from "./components/layout";
import { LoadingState } from "./components/states";
import { ToastProvider } from "./components/toast";
import "./styles.css";

const OverviewPage = lazy(() => import("./pages/overview").then((module) => ({ default: module.OverviewPage })));
const ConnectionsPage = lazy(() => import("./pages/connections").then((module) => ({ default: module.ConnectionsPage })));
const BotSettingsPage = lazy(() => import("./pages/bot-settings").then((module) => ({ default: module.BotSettingsPage })));
const MemoryPage = lazy(() => import("./pages/memory").then((module) => ({ default: module.MemoryPage })));
const TasksPage = lazy(() => import("./pages/tasks").then((module) => ({ default: module.TasksPage })));

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
    { path: "connections", element: <RouteFallback><ConnectionsPage /></RouteFallback> },
    { path: "bot-settings", element: <RouteFallback><BotSettingsPage /></RouteFallback> },
    { path: "memory", element: <RouteFallback><MemoryPage /></RouteFallback> },
    { path: "tasks", element: <RouteFallback><TasksPage /></RouteFallback> },
    { path: "*", element: <Navigate to="/" replace /> },
  ],
}]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider><RouterProvider router={router} /></ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);

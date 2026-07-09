import { useQuery } from "@tanstack/react-query";
import { Activity, BrainCircuit, CheckCircle2, Clock3, RefreshCw, Wrench } from "lucide-react";
import { api, type ServiceStatus } from "../lib/api";
import { timeAgo } from "../lib/utils";
import { PageHeader } from "../components/layout";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "../components/ui";

export function OverviewPage() {
  const status = useQuery({ queryKey: ["status"], queryFn: api.getStatus, refetchInterval: () => document.visibilityState === "visible" ? 15_000 : false, refetchIntervalInBackground: false });
  const sessions = useQuery({ queryKey: ["memory-sessions"], queryFn: api.getMemorySessions });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.getTasks, refetchInterval: (query) => document.visibilityState === "visible" && query.state.data?.some((task) => task.status === "queued" || task.status === "running") ? 2_500 : false, refetchIntervalInBackground: false });
  const refresh = () => Promise.all([status.refetch(), sessions.refetch(), tasks.refetch()]);
  if (status.isPending) return <LoadingState />;
  if (status.isError) return <><PageHeader eyebrow="Dashboard" title="Overview" description="Service status, recent tasks, and conversation memory." /><ErrorState error={status.error} retry={() => status.refetch()} /></>;

  const activeTasks = tasks.data?.filter((task) => task.status === "queued" || task.status === "running").length ?? 0;
  const healthy = status.data.services.filter((service) => service.state === "connected" || service.state === "configured").length;
  return <>
    <PageHeader eyebrow="Dashboard" title="Overview" description="Service status, recent tasks, and conversation memory." actions={<Button variant="secondary" onClick={refresh} disabled={status.isFetching}><RefreshCw className={`h-4 w-4 ${status.isFetching ? "animate-spin" : ""}`} />Refresh</Button>} />
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Metric icon={Activity} label="Services available" value={`${healthy}/${status.data.services.length}`} meta="Connected or configured" />
      <Metric icon={Wrench} label="Active tasks" value={String(activeTasks)} meta={activeTasks ? "Currently running" : "No active tasks"} />
      <Metric icon={BrainCircuit} label="Memory sessions" value={sessions.isSuccess ? String(sessions.data.length) : "--"} meta="Within the retention period" />
      <Metric icon={Clock3} label="Uptime" value={formatUptime(status.data.uptimeSeconds)} meta={status.data.version ? `Version ${status.data.version}` : "Application running"} />
    </div>
    <div className="mt-5 grid gap-5 xl:grid-cols-[1.35fr_.65fr]">
       <Card><CardHeader className="flex-row items-center justify-between"><div><CardTitle>Services</CardTitle><p className="mt-1 text-xs text-zinc-500">Current connection status</p></div><span className="text-xs text-zinc-600">Refreshes every 15 seconds</span></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2">{status.data.services.length ? status.data.services.map((service) => <ServiceCard key={service.name} service={service} />) : <div className="sm:col-span-2"><EmptyState title="No service status available" description="The server did not return any services." /></div>}</CardContent></Card>
       <Card><CardHeader><CardTitle>Recent tasks</CardTitle><p className="mt-1 text-xs text-zinc-500">The five most recently updated tasks</p></CardHeader><CardContent>{tasks.isError ? <p className="text-sm text-red-400">{tasks.error.message}</p> : tasks.isPending ? <LoadingState label="Loading tasks" /> : tasks.data.length === 0 ? <EmptyState title="No tasks yet" description="Tasks created by the bot will appear here." /> : <div className="space-y-1">{tasks.data.slice(0, 5).map((task) => <div key={task.id} className="flex items-center gap-3 border-b border-line py-3 last:border-0"><span className={`h-2 w-2 shrink-0 rounded-full ${task.status === "running" ? "animate-pulse bg-cyan" : task.status === "succeeded" ? "bg-signal" : task.status === "failed" ? "bg-red-400" : "bg-zinc-600"}`} /><div className="min-w-0 flex-1"><p className="truncate text-sm text-zinc-200">{task.title}</p><p className="mt-0.5 text-xs text-zinc-600">{task.toolProfile}</p></div><span className="text-xs text-zinc-600">{timeAgo(task.updatedAt)}</span></div>)}</div>}</CardContent></Card>
    </div>
  </>;
}

function Metric({ icon: Icon, label, value, meta }: { icon: typeof Activity; label: string; value: string; meta: string }) { return <Card className="overflow-hidden"><CardContent className="relative"><Icon className="absolute right-4 top-4 h-8 w-8 text-white/[.04]" /><p className="text-xs font-medium text-zinc-500">{label}</p><p className="mt-3 text-3xl font-semibold tracking-tight text-white">{value}</p><p className="mt-1 text-xs text-zinc-600">{meta}</p></CardContent></Card>; }
function ServiceCard({ service }: { service: ServiceStatus }) { const good = service.state === "connected" || service.state === "configured"; return <div className="rounded-lg border border-line bg-ink/50 p-4"><div className="flex items-start justify-between gap-3"><div className="flex items-center gap-2"><CheckCircle2 className={`h-4 w-4 ${good ? "text-signal" : service.state === "error" ? "text-red-400" : "text-amber-300"}`} /><p className="font-medium text-zinc-200">{service.name}</p></div><Badge tone={good ? "good" : service.state === "error" ? "bad" : "warn"}>{service.state}</Badge></div><p className="mt-3 line-clamp-2 min-h-10 text-xs leading-5 text-zinc-500">{service.detail || "No additional details."}</p><div className="mt-3 flex justify-between text-xs text-zinc-700"><span>{service.latencyMs !== undefined ? `${service.latencyMs}ms` : "Checked"}</span><span>{service.checkedAt ? timeAgo(service.checkedAt) : "just now"}</span></div></div>; }
function formatUptime(seconds?: number) { if (seconds === undefined) return "--"; const hours = Math.floor(seconds / 3600); return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h ${Math.floor((seconds % 3600) / 60)}m`; }

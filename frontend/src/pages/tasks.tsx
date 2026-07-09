import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CheckCircle2, CircleDashed, Clock3, RefreshCw, Terminal, XCircle } from "lucide-react";
import { useState } from "react";
import { api, type AgentTask, type AgentTaskStatus } from "../lib/api";
import { formatDate, timeAgo } from "../lib/utils";
import { PageHeader } from "../components/layout";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { useToast } from "../components/toast";
import { Badge, Button, Card, CardContent, ConfirmDialog } from "../components/ui";

export function TasksPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<AgentTask>();
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.getTasks, refetchInterval: (query) => document.visibilityState === "visible" && query.state.data?.some((task) => task.status === "queued" || task.status === "running") ? 2_000 : false, refetchIntervalInBackground: false });
  const cancel = useMutation({ mutationFn: api.cancelTask, onSuccess: (updated) => { queryClient.setQueryData<AgentTask[]>(["tasks"], (items) => items?.map((item) => item.id === updated.id ? updated : item)); toast({ tone: "success", title: "Cancellation requested" }); }, onError: (error) => toast({ tone: "error", title: "Unable to cancel task", description: error.message }) });
  if (tasks.isPending) return <LoadingState label="Loading agent task ledger" />;
  if (tasks.isError) return <><PageHeader eyebrow="Worker ledger" title="Agent tasks" description="Monitor queued, active, and completed coordinator jobs." /><ErrorState error={tasks.error} retry={() => tasks.refetch()} /></>;
  const active = tasks.data.filter((task) => task.status === "queued" || task.status === "running").length;
  return <><PageHeader eyebrow="Worker ledger" title="Agent tasks" description="Monitor queued, active, and completed coordinator jobs." actions={<Button variant="secondary" onClick={() => tasks.refetch()} disabled={tasks.isFetching}><RefreshCw className={`h-4 w-4 ${tasks.isFetching ? "animate-spin" : ""}`} />Refresh</Button>} />
    <div className="mb-4 flex items-center justify-between rounded-lg border border-line bg-white/[.02] px-4 py-3"><div className="flex items-center gap-3"><span className={`h-2 w-2 rounded-full ${active ? "animate-pulse bg-cyan" : "bg-signal"}`} /><p className="text-sm text-zinc-400">{active ? `${active} active worker${active === 1 ? "" : "s"}; polling every 2 seconds.` : "Worker queue is idle."}</p></div><span className="font-mono text-[10px] text-zinc-700">{tasks.data.length} TOTAL</span></div>
    {tasks.data.length === 0 ? <EmptyState title="No agent tasks yet" description="Coordinator work will be recorded here as repair requests run." /> : <div className="grid gap-3">{tasks.data.map((task) => <TaskCard key={task.id} task={task} cancel={() => setSelected(task)} />)}</div>}
    <ConfirmDialog open={!!selected} onOpenChange={(open) => !open && setSelected(undefined)} title="Cancel this agent task?" description={`Task “${selected?.title ?? ""}” will be marked cancelled. Running tool work may take a moment to stop.`} confirmLabel="Cancel task" destructive onConfirm={() => { if (selected) cancel.mutate(selected.id); setSelected(undefined); }} />
  </>;
}

function TaskCard({ task, cancel }: { task: AgentTask; cancel: () => void }) {
  const active = task.status === "queued" || task.status === "running";
  const Icon = task.status === "succeeded" ? CheckCircle2 : task.status === "failed" ? XCircle : task.status === "cancelled" ? Ban : task.status === "running" ? CircleDashed : Clock3;
  return <Card><CardContent className="flex flex-col gap-4 lg:flex-row lg:items-start"><div className={`grid h-10 w-10 shrink-0 place-items-center rounded-md border ${active ? "border-cyan/25 bg-cyan/[.06]" : "border-line bg-ink"}`}><Icon className={`h-4 w-4 ${task.status === "succeeded" ? "text-signal" : task.status === "failed" ? "text-red-400" : task.status === "running" ? "animate-spin text-cyan" : "text-zinc-500"}`} /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="font-medium text-zinc-100">{task.title}</h2><StatusBadge status={task.status} /><Badge>{task.toolProfile}</Badge></div><p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-500">{task.error || task.resultText || task.prompt}</p><div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-wide text-zinc-700"><span>ID {task.id.slice(0, 10)}</span><span>Attempt {task.attempts}</span><span>Updated {timeAgo(task.updatedAt)}</span><span title={formatDate(task.createdAt)}>{task.channelId}</span></div></div>{active && <Button variant="danger" size="sm" onClick={cancel}><Ban className="h-3.5 w-3.5" />Cancel</Button>}</CardContent></Card>;
}
function StatusBadge({ status }: { status: AgentTaskStatus }) { const tone = status === "succeeded" ? "good" : status === "failed" ? "bad" : status === "running" ? "info" : status === "queued" ? "warn" : "neutral"; return <Badge tone={tone}>{status}</Badge>; }

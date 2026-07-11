import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Ban, CheckCircle2, CircleDashed, Clock3, ExternalLink, FastForward, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "../components/layout";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { useToast } from "../components/toast";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, ConfirmDialog } from "../components/ui";
import { api, type RepairCase, type RepairCaseActivity, type RepairCaseStatus } from "../lib/api";
import { formatDate, timeAgo } from "../lib/utils";

type RepairGroup = "working" | "waiting" | "attention" | "completed";
type Filter = "all" | RepairGroup;

const groups: { id: RepairGroup; label: string; description: string; statuses: RepairCaseStatus[] }[] = [
  { id: "working", label: "Working", description: "Repairs currently being handled or verified.", statuses: ["working", "ready", "verifying"] },
  { id: "waiting", label: "Waiting", description: "Repairs paused until an expected download, import, or scheduled check.", statuses: ["waiting"] },
  { id: "attention", label: "Needs attention", description: "Repairs that need input or cannot continue automatically.", statuses: ["needs_input", "blocked", "exhausted"] },
  { id: "completed", label: "Completed", description: "Resolved and cancelled repair history.", statuses: ["resolved", "cancelled"] },
];

const statusCopy: Record<RepairCaseStatus, string> = {
  working: "Repair work is in progress",
  waiting: "Waiting for downloads or another update",
  ready: "Ready to continue",
  verifying: "Checking that the repair worked",
  resolved: "Repair completed",
  needs_input: "Needs your input",
  blocked: "Cannot continue automatically",
  exhausted: "Automatic attempts are exhausted",
  cancelled: "Repair cancelled",
};

const terminalStatuses = new Set<RepairCaseStatus>(["resolved", "exhausted", "cancelled"]);
const activeStatuses = new Set<RepairCaseStatus>(["working", "waiting", "ready", "verifying"]);

export function RepairsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string>();
  const [cancelId, setCancelId] = useState<string>();
  const [clearOpen, setClearOpen] = useState(false);
  const repairs = useQuery({
    queryKey: ["repairs"],
    queryFn: api.getRepairs,
    refetchInterval: (query) => document.visibilityState === "visible" && query.state.data?.some((repair) => activeStatuses.has(repair.status)) ? 3_000 : false,
    refetchIntervalInBackground: false,
  });
  const activity = useQuery({ queryKey: ["repair-activity", selectedId], queryFn: () => api.getRepairActivity(selectedId!), enabled: !!selectedId });

  const updateRepair = (updated: RepairCase) => {
    queryClient.setQueryData<RepairCase[]>(["repairs"], (items) => items?.map((item) => item.id === updated.id ? updated : item));
    queryClient.invalidateQueries({ queryKey: ["repair-activity", updated.id] });
  };
  const cancel = useMutation({
    mutationFn: api.cancelRepair,
    onSuccess: (updated) => { updateRepair(updated); toast({ tone: "success", title: "Repair cancelled" }); },
    onError: (error) => toast({ tone: "error", title: "Unable to cancel repair", description: error.message }),
  });
  const resume = useMutation({
    mutationFn: api.resumeRepair,
    onSuccess: (updated) => { updateRepair(updated); toast({ tone: "success", title: "Repair resumed", description: "The repair will run again now." }); },
    onError: (error) => toast({ tone: "error", title: "Unable to resume repair", description: error.message }),
  });
  const clearRepairs = useMutation({
    mutationFn: api.clearRepairs,
    onSuccess: ({ deleted }) => {
      queryClient.setQueryData<RepairCase[]>(["repairs"], []);
      setSelectedId(undefined);
      toast({ tone: "success", title: "Repairs cleared", description: `${deleted} repair${deleted === 1 ? "" : "s"} removed.` });
    },
    onError: (error) => toast({ tone: "error", title: "Unable to clear repairs", description: error.message }),
  });

  if (repairs.isPending) return <LoadingState label="Loading repairs" />;
  if (repairs.isError) return <><PageHeader eyebrow="Repair queue" title="Ongoing Repairs" description="Follow repair progress and intervene when a case needs help." /><ErrorState error={repairs.error} retry={() => repairs.refetch()} /></>;

  const selected = repairs.data.find((repair) => repair.id === selectedId);
  const activeCount = repairs.data.filter((repair) => activeStatuses.has(repair.status)).length;
  const visibleGroups = filter === "all" ? groups : groups.filter((group) => group.id === filter);
  return <>
    <PageHeader eyebrow="Repair queue" title="Ongoing Repairs" description="Follow repair progress, see what happens next, and intervene when a case needs help." actions={<div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => repairs.refetch()} disabled={repairs.isFetching}><RefreshCw className={`h-4 w-4 ${repairs.isFetching ? "animate-spin" : ""}`} />Refresh</Button><Button variant="danger" onClick={() => setClearOpen(true)} disabled={repairs.data.length === 0 || clearRepairs.isPending}><Trash2 className="h-4 w-4" />Clear all</Button></div>} />
    <div className="mb-5 flex flex-col gap-3 rounded-lg border border-line bg-white/[.02] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3"><span className={`h-2 w-2 rounded-full ${activeCount ? "animate-pulse bg-cyan" : "bg-signal"}`} /><p className="text-sm text-zinc-400">{activeCount ? `${activeCount} active repair${activeCount === 1 ? "" : "s"}` : "No repairs are currently active"}</p></div>
      <span className="text-xs text-zinc-600">{activeCount ? "Updates automatically while work is active" : `${repairs.data.length} total`}</span>
    </div>
    <div className="mb-5 flex gap-2 overflow-x-auto pb-1" aria-label="Filter repairs">
      <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>All <span>{repairs.data.length}</span></FilterButton>
      {groups.map((group) => <FilterButton key={group.id} active={filter === group.id} onClick={() => setFilter(group.id)}>{group.label} <span>{countGroup(repairs.data, group)}</span></FilterButton>)}
    </div>
    {repairs.data.length === 0 ? <EmptyState title="No repair cases yet" description="Repairs started from Discord will appear here with their latest progress." /> : <div className={`grid gap-5 ${selected ? "xl:grid-cols-[minmax(0,1fr)_minmax(360px,.55fr)]" : ""}`}>
      <div className="space-y-7">{visibleGroups.map((group) => {
        const items = repairs.data.filter((repair) => group.statuses.includes(repair.status));
        return <section key={group.id} aria-labelledby={`${group.id}-heading`}><div className="mb-3 flex items-end justify-between gap-4"><div><h2 id={`${group.id}-heading`} className="font-semibold text-zinc-100">{group.label}</h2><p className="mt-1 text-xs text-zinc-600">{group.description}</p></div><span className="font-mono text-xs text-zinc-600">{items.length}</span></div>{items.length ? <div className="grid gap-3">{items.map((repair) => <RepairCard key={repair.id} repair={repair} selected={repair.id === selectedId} select={() => setSelectedId(repair.id)} cancel={() => setCancelId(repair.id)} resume={() => resume.mutate(repair.id)} busy={resume.isPending && resume.variables === repair.id} />)}</div> : <div className="rounded-lg border border-dashed border-line px-4 py-5 text-sm text-zinc-600">No repairs in this section.</div>}</section>;
      })}</div>
      {selected && <ActivityPanel repair={selected} activity={activity.data} pending={activity.isPending} error={activity.error} retry={() => activity.refetch()} close={() => setSelectedId(undefined)} />}
    </div>}
    <ConfirmDialog open={!!cancelId} onOpenChange={(open) => !open && setCancelId(undefined)} title="Cancel this repair?" description="Automated repair work will stop. Its history and technical activity will remain available." confirmLabel="Cancel repair" destructive onConfirm={() => { if (cancelId) cancel.mutate(cancelId); setCancelId(undefined); }} />
    <ConfirmDialog open={clearOpen} onOpenChange={setClearOpen} title="Clear all repairs?" description={`This will stop active work and permanently remove all ${repairs.data.length} repair${repairs.data.length === 1 ? "" : "s"}, including completed history, saved thread context, and activity.`} confirmLabel="Clear all repairs" destructive onConfirm={() => { clearRepairs.mutate(); setClearOpen(false); }} />
  </>;
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} aria-pressed={active} className={`flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium transition ${active ? "border-signal/40 bg-signal/10 text-signal" : "border-line bg-panel text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"}`}>{children}</button>;
}

function RepairCard({ repair, selected, select, cancel, resume, busy }: { repair: RepairCase; selected: boolean; select: () => void; cancel: () => void; resume: () => void; busy: boolean }) {
  const canCancel = !terminalStatuses.has(repair.status);
  const canResume = ["waiting", "needs_input", "blocked"].includes(repair.status);
  const Icon = repair.status === "resolved" ? CheckCircle2 : repair.status === "cancelled" ? Ban : repair.status === "needs_input" || repair.status === "blocked" || repair.status === "exhausted" ? AlertTriangle : repair.status === "waiting" ? Clock3 : CircleDashed;
  return <Card className={selected ? "border-signal/40" : ""}><CardContent className="flex flex-col gap-4 sm:flex-row sm:items-start"><button type="button" onClick={select} className="flex min-w-0 flex-1 gap-4 text-left focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-line bg-ink"><Icon className={`h-4 w-4 ${repair.status === "resolved" ? "text-signal" : repair.status === "needs_input" || repair.status === "blocked" || repair.status === "exhausted" ? "text-amber-300" : repair.status === "cancelled" ? "text-zinc-500" : "text-cyan"}`} /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium text-zinc-100">{repair.title}</h3><StatusBadge status={repair.status} /></div><p className="mt-2 text-sm text-zinc-400">{statusCopy[repair.status]}</p><p className="mt-1 line-clamp-2 text-sm leading-6 text-zinc-600">{repair.latestUpdate || "No update has been recorded yet."}</p><div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600"><span title={formatDate(repair.updatedAt)}>Updated {timeAgo(repair.updatedAt)}</span>{repair.nextWakeAt && <span title={formatDate(repair.nextWakeAt)}>Next wake {timeAgo(repair.nextWakeAt)}</span>}<span title={formatDate(repair.createdAt)}>Opened {timeAgo(repair.createdAt)}</span></div></div></button><div className="flex shrink-0 flex-wrap gap-2 sm:flex-col">{repair.threadUrl && <Button asChild variant="secondary" size="sm"><a href={repair.threadUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" />Thread</a></Button>}{canResume && <Button variant="secondary" size="sm" onClick={resume} disabled={busy}><FastForward className="h-3.5 w-3.5" />Resume now</Button>}{canCancel && <Button variant="danger" size="sm" onClick={cancel}><Ban className="h-3.5 w-3.5" />Cancel</Button>}</div></CardContent></Card>;
}

function ActivityPanel({ repair, activity, pending, error, retry, close }: { repair: RepairCase; activity?: RepairCaseActivity[]; pending: boolean; error: Error | null; retry: () => void; close: () => void }) {
  return <Card className="h-fit xl:sticky xl:top-24"><CardHeader className="flex flex-row items-start justify-between gap-3"><div className="min-w-0"><p className="font-mono text-[10px] uppercase tracking-wider text-zinc-600">Technical activity</p><CardTitle className="mt-1 truncate">{repair.title}</CardTitle><p className="mt-1 font-mono text-[10px] text-zinc-700">ID {repair.id}</p></div><Button variant="ghost" size="sm" onClick={close}>Close</Button></CardHeader><CardContent>{pending ? <LoadingState label="Loading activity" /> : error ? <ErrorState error={error} retry={retry} /> : !activity?.length ? <EmptyState title="No technical activity" description="No activity entries have been recorded for this repair." /> : <ol className="space-y-5">{activity.map((item, index) => <li key={item.id} className="relative pl-6"><span className="absolute left-0 top-1.5 h-2 w-2 rounded-full bg-cyan" />{index < activity.length - 1 && <span className="absolute bottom-[-1.25rem] left-[3px] top-4 w-px bg-line" />}<div className="flex flex-wrap items-center gap-2"><p className="font-mono text-xs font-semibold text-zinc-300">{item.type.replaceAll("_", " ")}</p>{item.status && <StatusBadge status={item.status} />}</div>{item.message && <p className="mt-1 text-sm leading-6 text-zinc-500">{item.message}</p>}{item.details !== undefined && <pre className="mt-2 max-h-52 overflow-auto rounded-md border border-line bg-ink p-3 font-mono text-[11px] leading-5 text-zinc-500">{formatDetails(item.details)}</pre>}<time className="mt-2 block text-[10px] text-zinc-700" dateTime={item.createdAt} title={formatDate(item.createdAt)}>{formatDate(item.createdAt)}</time></li>)}</ol>}</CardContent></Card>;
}

function StatusBadge({ status }: { status: RepairCaseStatus }) {
  const tone = status === "resolved" ? "good" : status === "working" || status === "verifying" || status === "ready" ? "info" : status === "needs_input" || status === "blocked" || status === "exhausted" || status === "waiting" ? "warn" : "neutral";
  return <Badge tone={tone}>{status.replaceAll("_", " ")}</Badge>;
}

function countGroup(repairs: RepairCase[], group: (typeof groups)[number]) {
  return repairs.filter((repair) => group.statuses.includes(repair.status)).length;
}

function formatDetails(details: unknown) {
  if (typeof details === "string") return details;
  try { return JSON.stringify(details, null, 2); } catch { return String(details); }
}

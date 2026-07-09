import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrainCircuit, MessageSquareText, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, type MemorySession } from "../lib/api";
import { formatDate, timeAgo } from "../lib/utils";
import { PageHeader } from "../components/layout";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { useToast } from "../components/toast";
import { Badge, Button, Card, CardContent, ConfirmDialog } from "../components/ui";

export function MemoryPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<MemorySession>();
  const sessions = useQuery({ queryKey: ["memory-sessions"], queryFn: api.getMemorySessions });
  const remove = useMutation({ mutationFn: api.deleteMemorySession, onSuccess: (_, key) => { queryClient.setQueryData<MemorySession[]>(["memory-sessions"], (items) => items?.filter((item) => item.conversationKey !== key)); toast({ tone: "success", title: "Memory session deleted" }); }, onError: (error) => toast({ tone: "error", title: "Deletion failed", description: error.message }) });
  if (sessions.isPending) return <LoadingState label="Loading conversation memory" />;
  if (sessions.isError) return <><PageHeader eyebrow="Conversations" title="Memory" description="View and remove saved conversation history." /><ErrorState error={sessions.error} retry={() => sessions.refetch()} /></>;
  return <><PageHeader eyebrow="Conversations" title="Memory" description="View and remove saved conversation history." actions={<Button variant="secondary" onClick={() => sessions.refetch()} disabled={sessions.isFetching}><RefreshCw className={`h-4 w-4 ${sessions.isFetching ? "animate-spin" : ""}`} />Refresh</Button>} />
    <div className="mb-4 flex items-center gap-3 rounded-lg border border-line bg-white/[.02] px-4 py-3"><BrainCircuit className="h-4 w-4 text-signal" /><p className="text-sm text-zinc-400"><span className="font-semibold text-white">{sessions.data.length}</span> active sessions within the configured retention window.</p></div>
    {sessions.data.length === 0 ? <EmptyState title="No retained conversations" description="Sessions appear after the bot receives messages with memory enabled." /> : <div className="grid gap-3">{sessions.data.map((session) => <Card key={session.conversationKey}><CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-line bg-ink"><MessageSquareText className="h-4 w-4 text-cyan" /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="truncate font-mono text-xs text-zinc-200">{session.conversationKey}</p><Badge tone="neutral">{session.messageCount} messages</Badge></div><p className="mt-2 line-clamp-1 text-sm text-zinc-500"><span className="capitalize text-zinc-400">{session.latestRole}:</span> {session.latestContent}</p><p className="mt-2 text-[11px] text-zinc-700">Active {timeAgo(session.lastMessageAt)} · Started {formatDate(session.firstMessageAt)}</p></div><Button variant="ghost" size="icon" className="self-end text-zinc-500 hover:text-red-300 sm:self-auto" onClick={() => setSelected(session)} aria-label={`Delete memory session ${session.conversationKey}`}><Trash2 className="h-4 w-4" /></Button></CardContent></Card>)}</div>}
    <ConfirmDialog open={!!selected} onOpenChange={(open) => !open && setSelected(undefined)} title="Delete this memory session?" description={`All retained messages for ${selected?.conversationKey ?? "this conversation"} will be permanently removed. This cannot be undone.`} confirmLabel="Delete session" destructive onConfirm={() => { if (selected) remove.mutate(selected.conversationKey); setSelected(undefined); }} />
  </>;
}

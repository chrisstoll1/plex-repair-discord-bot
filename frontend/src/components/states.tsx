import { AlertTriangle, Inbox, LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Card } from "./ui";

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return <div className="flex min-h-52 items-center justify-center gap-3 text-sm text-zinc-400"><LoaderCircle className="h-5 w-5 animate-spin text-signal" /><span>{label}</span></div>;
}
export function ErrorState({ error, retry }: { error: unknown; retry: () => void }) {
  return <Card className="border-red-500/25 p-8 text-center"><AlertTriangle className="mx-auto h-8 w-8 text-red-400" /><h2 className="mt-3 font-semibold text-white">Unable to load this view</h2><p className="mx-auto mt-2 max-w-lg text-sm text-zinc-400">{error instanceof Error ? error.message : "The service returned an unexpected response."}</p><Button variant="secondary" className="mt-5" onClick={retry}><RefreshCw className="h-4 w-4" />Try again</Button></Card>;
}
export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line px-6 py-12 text-center"><Inbox className="mx-auto h-8 w-8 text-zinc-600" /><h3 className="mt-3 font-medium text-zinc-200">{title}</h3><p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">{description}</p>{action && <div className="mt-4">{action}</div>}</div>;
}

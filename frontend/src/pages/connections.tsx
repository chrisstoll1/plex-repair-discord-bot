import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clipboard, ExternalLink, KeyRound, LoaderCircle, LogOut, Radio } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "../components/layout";
import { SettingsEditor } from "../components/settings-editor";
import { ErrorState, LoadingState } from "../components/states";
import { useToast } from "../components/toast";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, ConfirmDialog } from "../components/ui";
import { api } from "../lib/api";
import { formatDate } from "../lib/utils";

export function ConnectionsPage() {
  return <>
    <PageHeader eyebrow="Services" title="Connections" description="Configure credentials, server addresses, and OpenAI Codex login." />
    <PiAuthPanel />
    <div className="mt-5"><SettingsEditor mode="connections" /></div>
  </>;
}

function PiAuthPanel() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [logoutOpen, setLogoutOpen] = useState(false);
  const auth = useQuery({
    queryKey: ["pi-auth"],
    queryFn: api.getPiAuth,
    refetchInterval: (query) => document.visibilityState === "visible" && query.state.data?.activeLogin?.status === "pending"
      ? Math.max(1000, (query.state.data.activeLogin.deviceCode?.intervalSeconds ?? 2) * 1000)
      : false,
    refetchIntervalInBackground: false,
  });
  const action = useMutation({
    mutationFn: (kind: "start" | "cancel" | "logout") => kind === "start" ? api.startPiAuth() : kind === "cancel" ? api.cancelPiAuth() : api.logoutPiAuth(),
    onSuccess: (data, kind) => {
      queryClient.setQueryData(["pi-auth"], data);
      toast({ tone: "success", title: kind === "start" ? "Login started" : kind === "logout" ? "Disconnected" : "Login cancelled" });
    },
    onError: (error) => toast({ tone: "error", title: "Authentication failed", description: error.message }),
  });

  if (auth.isPending) return <Card><LoadingState label="Checking OpenAI Codex login" /></Card>;
  if (auth.isError) return <ErrorState error={auth.error} retry={() => auth.refetch()} />;

  const data = auth.data;
  const device = data.activeLogin?.deviceCode;
  const pending = data.activeLogin?.status === "pending";
  const copy = async () => {
    if (!device) return;
    await navigator.clipboard.writeText(device.userCode);
    toast({ tone: "success", title: "Device code copied" });
  };

  return <Card className="overflow-hidden">
    <CardHeader className="flex-row items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-signal" /><CardTitle>Pi / OpenAI Codex</CardTitle></div>
        <p className="mt-1 text-xs text-zinc-500">Login used by the bot's AI model.</p>
      </div>
      <Badge tone={data.configured ? "good" : pending ? "info" : "warn"}>{data.configured ? "connected" : pending ? "waiting" : "not connected"}</Badge>
    </CardHeader>
    <CardContent>
      {device && pending ? <div className="grid gap-5 lg:grid-cols-[1fr_auto]">
        <div>
          <p className="text-xs font-medium text-zinc-500">One-time device code</p>
          <button onClick={copy} className="group mt-2 flex w-full items-center justify-between rounded-lg border border-cyan/25 bg-cyan/[.06] px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan">
            <span className="font-mono text-xl font-semibold tracking-[.18em] text-white">{device.userCode}</span>
            <Clipboard className="h-4 w-4 text-cyan transition group-hover:scale-110" />
          </button>
          <p className="mt-3 text-xs text-zinc-500">{data.activeLogin?.progress || "Waiting for authorization."} {device.expiresAt && <>Expires {formatDate(device.expiresAt)}.</>}</p>
        </div>
        <div className="flex flex-col justify-end gap-2 sm:flex-row lg:flex-col">
          <Button asChild><a href={device.verificationUri} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" />Open login page</a></Button>
          <Button variant="danger" onClick={() => action.mutate("cancel")} disabled={action.isPending}>Cancel login</Button>
        </div>
      </div> : <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          {data.configured ? <Check className="h-5 w-5 text-signal" /> : <Radio className="h-5 w-5 text-zinc-600" />}
          <div>
            <p className="text-sm font-medium text-zinc-200">{data.status.label || (data.configured ? "OpenAI Codex is connected" : "OpenAI Codex is not connected")}</p>
            <p className="mt-1 text-xs text-zinc-500">{data.credential?.expiresAt ? `Expires ${formatDate(data.credential.expiresAt)}` : data.activeLogin?.error || "Start login to connect your account."}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => action.mutate("start")} disabled={action.isPending}>
            {action.isPending && <LoaderCircle className="h-4 w-4 animate-spin" />}{data.configured ? "Reconnect" : "Start login"}
          </Button>
          {data.configured && <Button variant="ghost" onClick={() => setLogoutOpen(true)}><LogOut className="h-4 w-4" />Disconnect</Button>}
        </div>
      </div>}
    </CardContent>
    <ConfirmDialog open={logoutOpen} onOpenChange={setLogoutOpen} title="Disconnect OpenAI Codex?" description="This removes the saved login. The bot cannot use the AI model until you reconnect." confirmLabel="Disconnect" destructive onConfirm={() => action.mutate("logout")} />
  </Card>;
}

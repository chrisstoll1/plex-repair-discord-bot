import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clipboard, ExternalLink, KeyRound, LoaderCircle, LogOut, Radio, RefreshCw, Webhook } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "../components/layout";
import { SettingsEditor } from "../components/settings-editor";
import { ErrorState, LoadingState } from "../components/states";
import { useToast } from "../components/toast";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, ConfirmDialog } from "../components/ui";
import { api, type WebhookConfig } from "../lib/api";
import { formatDate } from "../lib/utils";

export function ConnectionsPage() {
  return <>
    <PageHeader eyebrow="Services" title="Connections" description="Configure credentials, server addresses, and OpenAI Codex login." />
    <PiAuthPanel />
    <div className="mt-5"><SettingsEditor mode="connections" /></div>
    <div className="mt-5"><WebhookPanel /></div>
  </>;
}

function WebhookPanel() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ["webhook-config"], queryFn: api.getWebhookConfig });
  const save = useMutation({
    mutationFn: api.updateWebhookConfig,
    onSuccess: (value) => { queryClient.setQueryData(["webhook-config"], value); toast({ tone: "success", title: "Webhook settings saved" }); },
    onError: (error) => toast({ tone: "error", title: "Unable to save webhook settings", description: error.message }),
  });
  const rotate = useMutation({
    mutationFn: api.rotateWebhookSecret,
    onSuccess: (value) => { queryClient.setQueryData(["webhook-config"], value); toast({ tone: "success", title: "Webhook secret rotated", description: "Update both service connections with the new URLs." }); },
    onError: (error) => toast({ tone: "error", title: "Unable to rotate webhook secret", description: error.message }),
  });
  if (config.isPending) return <Card><LoadingState label="Loading webhook configuration" /></Card>;
  if (config.isError) return <ErrorState error={config.error} retry={() => config.refetch()} />;
  return <WebhookForm value={config.data} saving={save.isPending || rotate.isPending} onSave={(value) => save.mutate(value)} onRotate={() => rotate.mutate()} />;
}

function WebhookForm({ value, saving, onSave, onRotate }: { value: WebhookConfig; saving: boolean; onSave: (value: Pick<WebhookConfig, "publicBaseUrl" | "sonarrEnabled" | "radarrEnabled">) => void; onRotate: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState(value);
  const copy = async (url?: string) => {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    toast({ tone: "success", title: "Webhook URL copied" });
  };
  return <Card><CardHeader className="flex-row items-start justify-between gap-4"><div><div className="flex items-center gap-2"><Webhook className="h-4 w-4 text-signal" /><CardTitle>Automatic progress events</CardTitle></div><p className="mt-1 text-xs text-zinc-500">Let repairs continue immediately when a download or import finishes instead of checking on a timer.</p></div><Badge tone={draft.sonarrEnabled || draft.radarrEnabled ? "good" : "neutral"}>{draft.sonarrEnabled || draft.radarrEnabled ? "enabled" : "disabled"}</Badge></CardHeader><CardContent className="space-y-5"><div><label className="text-xs font-medium text-zinc-400" htmlFor="webhook-base-url">Public Repairman URL</label><input id="webhook-base-url" value={draft.publicBaseUrl} onChange={(event) => setDraft((current) => ({ ...current, publicBaseUrl: event.target.value }))} placeholder="https://repairman.example.com" className="mt-2 h-10 w-full rounded-md border border-line bg-ink px-3 text-sm text-zinc-100 outline-none focus:border-signal/60" /><p className="mt-1.5 text-xs text-zinc-600">The address Sonarr and Radarr can use to reach this server.</p></div><div className="grid gap-3 sm:grid-cols-2">{(["sonarr", "radarr"] as const).map((provider) => { const enabledKey = `${provider}Enabled` as const; const urlKey = `${provider}Url` as const; const receivedKey = `${provider}LastReceivedAt` as const; return <div key={provider} className="rounded-lg border border-line bg-ink/40 p-4"><label className="flex items-center justify-between gap-3"><span className="text-sm font-medium capitalize text-zinc-200">{provider}</span><input type="checkbox" checked={draft[enabledKey]} onChange={(event) => setDraft((current) => ({ ...current, [enabledKey]: event.target.checked }))} className="h-4 w-4 accent-[#f2b84b]" /></label><button type="button" onClick={() => copy(value[urlKey])} disabled={!value[urlKey]} className="mt-3 flex w-full items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-left text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-40"><span className="truncate">{value[urlKey] || "Save a public URL first"}</span><Clipboard className="h-3.5 w-3.5 shrink-0" /></button><p className="mt-2 text-[11px] text-zinc-600">{value[receivedKey] ? `Last event ${formatDate(value[receivedKey]!)}` : "No event received yet"}</p></div>; })}</div><div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" onClick={onRotate} disabled={saving}><RefreshCw className="h-4 w-4" />Rotate secret</Button><Button onClick={() => onSave({ publicBaseUrl: draft.publicBaseUrl, sonarrEnabled: draft.sonarrEnabled, radarrEnabled: draft.radarrEnabled })} disabled={saving}>{saving && <LoaderCircle className="h-4 w-4 animate-spin" />}Save webhook settings</Button></div></CardContent></Card>;
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

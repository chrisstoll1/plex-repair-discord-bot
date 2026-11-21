import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clipboard, RefreshCw, Webhook } from "lucide-react";
import { useEffect, useState } from "react";
import { SettingsEditor } from "../components/settings-editor";
import { ErrorState, LoadingState } from "../components/states";
import { useToast } from "../components/toast";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "../components/ui";
import { api, type WebhookConfig } from "../lib/api";
import { formatDate } from "../lib/utils";
export { PiAuthPanel } from "../components/ai-providers-panel";

type WebhookDraft = Pick<WebhookConfig, "publicBaseUrl" | "sonarrEnabled" | "radarrEnabled">;

export function ConnectionsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ["webhook-config"], queryFn: api.getWebhookConfig });
  const [draft, setDraft] = useState<WebhookDraft | null>(null);

  useEffect(() => {
    if (config.data && !draft) {
      setDraft({
        publicBaseUrl: config.data.publicBaseUrl,
        sonarrEnabled: config.data.sonarrEnabled,
        radarrEnabled: config.data.radarrEnabled,
      });
    }
  }, [config.data, draft]);

  const saveWebhook = useMutation({
    mutationFn: api.updateWebhookConfig,
    onSuccess: (value) => {
      queryClient.setQueryData(["webhook-config"], value);
      setDraft({
        publicBaseUrl: value.publicBaseUrl,
        sonarrEnabled: value.sonarrEnabled,
        radarrEnabled: value.radarrEnabled,
      });
    },
    onError: (error) => toast({ tone: "error", title: "Unable to save webhook settings", description: error.message }),
  });

  const rotate = useMutation({
    mutationFn: api.rotateWebhookSecret,
    onSuccess: (value) => {
      queryClient.setQueryData(["webhook-config"], value);
      toast({ tone: "success", title: "Webhook secret rotated", description: "Update both service connections with the new URLs." });
    },
    onError: (error) => toast({ tone: "error", title: "Unable to rotate webhook secret", description: error.message }),
  });

  const activeDraft: WebhookDraft | undefined = draft ?? (config.data
    ? {
        publicBaseUrl: config.data.publicBaseUrl,
        sonarrEnabled: config.data.sonarrEnabled,
        radarrEnabled: config.data.radarrEnabled,
      }
    : undefined);

  const webhookDirty = Boolean(
    config.data && activeDraft && (
      activeDraft.publicBaseUrl !== config.data.publicBaseUrl ||
      activeDraft.sonarrEnabled !== config.data.sonarrEnabled ||
      activeDraft.radarrEnabled !== config.data.radarrEnabled
    ),
  );

  const webhookSection = config.isPending
    ? <Card><LoadingState label="Loading webhook configuration" /></Card>
    : config.isError
      ? <ErrorState error={config.error} retry={() => config.refetch()} />
      : activeDraft && (
        <WebhookCard
          value={config.data}
          draft={activeDraft}
          onChange={setDraft}
          saving={saveWebhook.isPending || rotate.isPending}
          onRotate={() => rotate.mutate()}
        />
      );

  return (
    <SettingsEditor
      mode="connections"
      afterFields={webhookSection}
      extraDirty={webhookDirty}
      extraSaving={saveWebhook.isPending}
      onExtraSave={activeDraft ? async () => { await saveWebhook.mutateAsync(activeDraft); } : undefined}
      onExtraReset={config.data ? () => setDraft({
        publicBaseUrl: config.data.publicBaseUrl,
        sonarrEnabled: config.data.sonarrEnabled,
        radarrEnabled: config.data.radarrEnabled,
      }) : undefined}
    />
  );
}

function WebhookCard({
  value,
  draft,
  onChange,
  saving,
  onRotate,
}: {
  value: WebhookConfig;
  draft: WebhookDraft;
  onChange: (next: WebhookDraft) => void;
  saving: boolean;
  onRotate: () => void;
}) {
  const toast = useToast();
  const copy = async (url?: string) => {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    toast({ tone: "success", title: "Webhook URL copied" });
  };
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Webhook className="h-4 w-4 text-signal" />
            <CardTitle>Automatic progress events</CardTitle>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Let repairs continue immediately when a download or import finishes instead of checking on a timer.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={draft.sonarrEnabled || draft.radarrEnabled ? "good" : "neutral"}>
            {draft.sonarrEnabled || draft.radarrEnabled ? "enabled" : "disabled"}
          </Badge>
          <Button type="button" variant="ghost" size="sm" onClick={onRotate} disabled={saving}>
            <RefreshCw className="h-3.5 w-3.5" />
            Rotate secret
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <label className="text-xs font-medium text-zinc-400" htmlFor="webhook-base-url">Public Repairman URL</label>
          <input
            id="webhook-base-url"
            value={draft.publicBaseUrl}
            onChange={(event) => onChange({ ...draft, publicBaseUrl: event.target.value })}
            placeholder="https://repairman.example.com"
            className="mt-2 h-10 w-full rounded-md border border-line bg-ink px-3 text-sm text-zinc-100 outline-none focus:border-signal/60"
          />
          <p className="mt-1.5 text-xs text-zinc-600">The address Sonarr and Radarr can use to reach this server.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {(["sonarr", "radarr"] as const).map((provider) => {
            const enabledKey = `${provider}Enabled` as const;
            const urlKey = `${provider}Url` as const;
            const receivedKey = `${provider}LastReceivedAt` as const;
            return (
              <div key={provider} className="rounded-lg border border-line bg-ink/40 p-4">
                <label className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium capitalize text-zinc-200">{provider}</span>
                  <input
                    type="checkbox"
                    checked={draft[enabledKey]}
                    onChange={(event) => onChange({ ...draft, [enabledKey]: event.target.checked })}
                    className="h-4 w-4 accent-[#f2b84b]"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => copy(value[urlKey])}
                  disabled={!value[urlKey]}
                  className="mt-3 flex w-full items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-left text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-40"
                >
                  <span className="truncate">{value[urlKey] || "Save a public URL first"}</span>
                  <Clipboard className="h-3.5 w-3.5 shrink-0" />
                </button>
                <p className="mt-2 text-[11px] text-zinc-600">
                  {value[receivedKey] ? `Last event ${formatDate(value[receivedKey]!)}` : "No event received yet"}
                </p>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

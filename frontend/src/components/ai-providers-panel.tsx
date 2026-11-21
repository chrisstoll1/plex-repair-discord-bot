import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Clipboard,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorState, LoadingState } from "./states";
import { useToast } from "./toast";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, ConfirmDialog, Input, Label, Switch, Textarea } from "./ui";
import {
  api,
  type AiProviderAuthSummary,
  type CustomModelConfig,
  type CustomProviderApi,
  type CustomProviderInput,
  type PiAuthSnapshot,
} from "../lib/api";
import { cn, formatDate } from "../lib/utils";

type AddTab = "oauth" | "apiKey" | "custom";

type CustomDraft = {
  editingId?: string;
  id: string;
  idTouched: boolean;
  name: string;
  baseUrl: string;
  api: CustomProviderApi;
  requiresApiKey: boolean;
  apiKeyConfigured: boolean;
  apiKeyValue: string;
  clearApiKey: boolean;
  modelsText: string;
};

const EMPTY_CUSTOM_DRAFT: CustomDraft = {
  id: "",
  idTouched: false,
  name: "",
  baseUrl: "",
  api: "openai-completions",
  requiresApiKey: false,
  apiKeyConfigured: false,
  apiKeyValue: "",
  clearApiKey: false,
  modelsText: "",
};

function slugifyProviderId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function parseModelsText(text: string): CustomModelConfig[] {
  const seen = new Set<string>();
  const models: CustomModelConfig[] = [];
  for (const raw of text.split(/[\n,]+/)) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: id });
  }
  return models;
}

function authBadgeLabel(provider: AiProviderAuthSummary): string {
  if (provider.kind === "custom") {
    return provider.custom?.requiresApiKey ? "Custom + Key" : "Custom";
  }
  if (provider.authType === "oauth") return "OAuth";
  if (provider.authType === "env") return "Env";
  return "API Key";
}

export function PiAuthPanel() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<AddTab>("oauth");
  const [selectedApiKeyProvider, setSelectedApiKeyProvider] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [copilotEnterpriseDomain, setCopilotEnterpriseDomain] = useState("");
  const [manualCodeInput, setManualCodeInput] = useState("");
  const [customDraft, setCustomDraft] = useState<CustomDraft>(EMPTY_CUSTOM_DRAFT);
  const [showCustomKey, setShowCustomKey] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<AiProviderAuthSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AiProviderAuthSummary | null>(null);
  const prevPendingRef = useRef(false);

  const auth = useQuery({
    queryKey: ["pi-auth"],
    queryFn: api.getPiAuth,
    refetchInterval: (query) =>
      document.visibilityState === "visible" && query.state.data?.activeLogin?.status === "pending"
        ? Math.max(1000, (query.state.data.activeLogin.deviceCode?.intervalSeconds ?? 2) * 1000)
        : false,
    refetchIntervalInBackground: false,
  });

  const syncAuthSnapshot = (data: PiAuthSnapshot) => {
    queryClient.setQueryData(["pi-auth"], data);
    queryClient.invalidateQueries({ queryKey: ["ai-models"] });
    queryClient.invalidateQueries({ queryKey: ["status"] });
  };

  const pendingNow = auth.data?.activeLogin?.status === "pending";
  useEffect(() => {
    if (prevPendingRef.current && !pendingNow) {
      queryClient.invalidateQueries({ queryKey: ["ai-models"] });
      queryClient.invalidateQueries({ queryKey: ["status"] });
    }
    prevPendingRef.current = Boolean(pendingNow);
  }, [pendingNow, queryClient]);

  const startOAuth = useMutation({
    mutationFn: (params: { providerId: string; enterpriseDomain?: string }) => api.startPiAuth(params),
    onSuccess: (data) => {
      setManualCodeInput("");
      syncAuthSnapshot(data);
      toast({ tone: "success", title: "Sign-in started", description: `Follow the prompt below to connect ${data.activeLogin?.providerName ?? "provider"}.` });
    },
    onError: (error) => toast({ tone: "error", title: "Unable to start sign-in", description: error.message }),
  });

  const submitOAuthInput = useMutation({
    mutationFn: (params: { providerId?: string; value: string }) => api.submitPiAuthInput(params),
    onSuccess: (data) => {
      setManualCodeInput("");
      syncAuthSnapshot(data);
      if (data.activeLogin?.status === "error") {
        toast({ tone: "error", title: "Sign-in failed", description: data.activeLogin.error });
      } else {
        toast({ tone: "success", title: "Provider connected" });
      }
    },
    onError: (error) => toast({ tone: "error", title: "Unable to complete sign-in", description: error.message }),
  });

  const cancelOAuth = useMutation({
    mutationFn: () => api.cancelPiAuth(),
    onSuccess: (data) => {
      setManualCodeInput("");
      syncAuthSnapshot(data);
      toast({ tone: "success", title: "Sign-in cancelled" });
    },
    onError: (error) => toast({ tone: "error", title: "Unable to cancel sign-in", description: error.message }),
  });

  const logoutProvider = useMutation({
    mutationFn: (providerId: string) => api.logoutPiAuth(providerId),
    onSuccess: (data) => {
      syncAuthSnapshot(data);
      toast({ tone: "success", title: "Provider disconnected" });
    },
    onError: (error) => toast({ tone: "error", title: "Unable to disconnect provider", description: error.message }),
  });

  const saveApiKey = useMutation({
    mutationFn: ({ providerId, apiKey }: { providerId: string; apiKey: string }) => api.savePiApiKey(providerId, apiKey),
    onSuccess: (data) => {
      setApiKeyInput("");
      setShowApiKey(false);
      syncAuthSnapshot(data);
      toast({ tone: "success", title: "API key saved", description: "Available models have been refreshed." });
    },
    onError: (error) => toast({ tone: "error", title: "Unable to save API key", description: error.message }),
  });

  const saveCustom = useMutation({
    mutationFn: (input: CustomProviderInput) => api.saveCustomAiProvider(input),
    onSuccess: (data) => {
      setCustomDraft(EMPTY_CUSTOM_DRAFT);
      setShowCustomKey(false);
      syncAuthSnapshot(data);
      toast({ tone: "success", title: "Custom endpoint saved", description: "Custom models are now available for selection." });
    },
    onError: (error) => toast({ tone: "error", title: "Unable to save custom endpoint", description: error.message }),
  });

  const deleteCustom = useMutation({
    mutationFn: (providerId: string) => api.deleteCustomAiProvider(providerId),
    onSuccess: (data) => {
      if (customDraft.editingId === deleteTarget?.id) {
        setCustomDraft(EMPTY_CUSTOM_DRAFT);
      }
      syncAuthSnapshot(data);
      toast({ tone: "success", title: "Custom endpoint removed" });
    },
    onError: (error) => toast({ tone: "error", title: "Unable to remove custom endpoint", description: error.message }),
  });

  const discoverModels = useMutation({
    mutationFn: () =>
      api.discoverCustomAiModels({
        baseUrl: customDraft.baseUrl,
        apiKey: customDraft.apiKeyValue.trim() || undefined,
        providerId: customDraft.editingId,
      }),
    onSuccess: (models) => {
      if (models.length === 0) {
        toast({ tone: "error", title: "No models returned", description: "The endpoint responded without any model IDs. Enter model IDs manually." });
        return;
      }
      setCustomDraft((current) => ({
        ...current,
        modelsText: models.map((model) => model.id).join("\n"),
      }));
      toast({ tone: "success", title: `Found ${models.length} model${models.length === 1 ? "" : "s"}` });
    },
    onError: (error) => toast({ tone: "error", title: "Model discovery failed", description: error.message }),
  });

  if (auth.isPending) return <Card><LoadingState label="Checking AI providers" /></Card>;
  if (auth.isError) return <ErrorState error={auth.error} retry={() => auth.refetch()} />;

  const data = auth.data;
  const providers = data.providers ?? [];
  const connectedProviders = providers.filter((provider) => provider.configured);
  const oauthProviders = providers.filter((provider) => provider.kind === "builtin" && provider.supportsOAuth);
  const apiKeyProviders = providers.filter((provider) => provider.kind === "builtin" && provider.supportsApiKey);
  const activeApiKeyProviderId = selectedApiKeyProvider || apiKeyProviders[0]?.id || "";
  const activeApiKeyProvider = apiKeyProviders.find((provider) => provider.id === activeApiKeyProviderId);
  const activeLogin = data.activeLogin;
  const device = activeLogin?.deviceCode;
  const authUrl = activeLogin?.authUrl;
  const inputPrompt = activeLogin?.inputPrompt;
  const pending = activeLogin?.status === "pending";
  const busy = startOAuth.isPending || submitOAuthInput.isPending || cancelOAuth.isPending || logoutProvider.isPending;

  const copyDeviceCode = async () => {
    if (!device) return;
    await navigator.clipboard.writeText(device.userCode);
    toast({ tone: "success", title: "Device code copied" });
  };

  const beginEditCustom = (provider: AiProviderAuthSummary) => {
    if (!provider.custom) return;
    setTab("custom");
    setShowCustomKey(false);
    setCustomDraft({
      editingId: provider.id,
      id: provider.id,
      idTouched: true,
      name: provider.name,
      baseUrl: provider.custom.baseUrl,
      api: provider.custom.api,
      requiresApiKey: provider.custom.requiresApiKey,
      apiKeyConfigured: provider.custom.apiKeyConfigured,
      apiKeyValue: "",
      clearApiKey: false,
      modelsText: provider.custom.models.map((model) => model.id).join("\n"),
    });
  };

  const handleCustomSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const models = parseModelsText(customDraft.modelsText);
    const id = (customDraft.editingId ?? customDraft.id).trim().toLowerCase();
    const trimmedKey = customDraft.apiKeyValue.trim();
    const apiKeyAction = !customDraft.requiresApiKey || customDraft.clearApiKey
      ? ({ action: "clear" } as const)
      : trimmedKey
        ? ({ action: "replace", value: trimmedKey } as const)
        : ({ action: "keep" } as const);

    saveCustom.mutate({
      id,
      name: customDraft.name.trim(),
      baseUrl: customDraft.baseUrl.trim(),
      api: customDraft.api,
      requiresApiKey: customDraft.requiresApiKey,
      apiKey: apiKeyAction,
      models,
    });
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-signal" />
            <CardTitle>AI providers &amp; authentication</CardTitle>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Connect one or more OAuth accounts, API keys, or custom OpenAI-compatible servers. Configure their priority order below.
          </p>
        </div>
        <Badge tone={connectedProviders.length > 0 ? "good" : pending ? "info" : "bad"}>
          {connectedProviders.length > 0
            ? `${connectedProviders.length} connected`
            : pending
              ? "waiting for sign-in"
              : "none connected"}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-6">
        {activeLogin && (pending || activeLogin.status === "error") && (
          <div className="rounded-lg border border-cyan/30 bg-cyan/[.05] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-cyan" />
                <p className="text-sm font-semibold text-zinc-100">
                  {pending ? `Signing in to ${activeLogin.providerName}` : `${activeLogin.providerName} sign-in failed`}
                </p>
              </div>
              <Badge tone={pending ? "info" : "bad"}>{activeLogin.status}</Badge>
            </div>

            {device && pending && (
              <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_auto]">
                <div>
                  <p className="text-xs font-medium text-zinc-400">One-time device code</p>
                  <button
                    type="button"
                    onClick={copyDeviceCode}
                    className="group mt-2 flex w-full items-center justify-between rounded-lg border border-cyan/25 bg-ink/80 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan"
                  >
                    <span className="font-mono text-xl font-semibold tracking-[.18em] text-white">{device.userCode}</span>
                    <Clipboard className="h-4 w-4 text-cyan transition group-hover:scale-110" />
                  </button>
                  <p className="mt-2.5 text-xs text-zinc-400">
                    {activeLogin.progress || "Waiting for authorization."}{" "}
                    {device.expiresAt && <>Expires {formatDate(device.expiresAt)}.</>}
                  </p>
                </div>
                <div className="flex flex-col justify-end gap-2 sm:flex-row lg:flex-col">
                  <Button asChild>
                    <a href={device.verificationUri} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-4 w-4" />
                      Open login page
                    </a>
                  </Button>
                  <Button variant="danger" onClick={() => cancelOAuth.mutate()} disabled={busy}>
                    Cancel login
                  </Button>
                </div>
              </div>
            )}

            {!device && pending && (authUrl || inputPrompt) && (
              <div className="mt-4 space-y-4">
                {authUrl && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-ink/60 p-3">
                    <p className="text-xs text-zinc-300">{authUrl.instructions || "Open the authorization page and complete sign-in."}</p>
                    <Button asChild size="sm">
                      <a href={authUrl.url} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open login page
                      </a>
                    </Button>
                  </div>
                )}

                {inputPrompt && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!manualCodeInput.trim()) return;
                      submitOAuthInput.mutate({ providerId: activeLogin.providerId, value: manualCodeInput.trim() });
                    }}
                    className="space-y-2"
                  >
                    <Label htmlFor="oauth-manual-code">{inputPrompt.message}</Label>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        id="oauth-manual-code"
                        value={manualCodeInput}
                        onChange={(event) => setManualCodeInput(event.target.value)}
                        placeholder={inputPrompt.placeholder || "Paste authorization code"}
                        autoComplete="off"
                      />
                      <Button type="submit" disabled={!manualCodeInput.trim() || submitOAuthInput.isPending}>
                        {submitOAuthInput.isPending && <LoaderCircle className="h-4 w-4 animate-spin" />}
                        Submit code
                      </Button>
                      <Button type="button" variant="danger" onClick={() => cancelOAuth.mutate()} disabled={busy}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            )}

            {!device && !authUrl && !inputPrompt && pending && (
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-xs text-zinc-400">
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin text-cyan" />
                  {activeLogin.progress || "Starting sign-in..."}
                </p>
                <Button variant="danger" size="sm" onClick={() => cancelOAuth.mutate()} disabled={busy}>
                  Cancel
                </Button>
              </div>
            )}

            {activeLogin.status === "error" && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-red-300">{activeLogin.error || "Authentication failed."}</p>
                <Button variant="ghost" size="sm" onClick={() => cancelOAuth.mutate()} disabled={busy}>
                  Dismiss
                </Button>
              </div>
            )}
          </div>
        )}

        <div>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Connected providers</h3>
            <span className="text-xs text-zinc-500">Models from every connected provider appear in the hierarchy below</span>
          </div>
          {connectedProviders.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line bg-ink/30 px-4 py-5 text-center text-xs text-zinc-500">
              No AI providers connected yet. Choose an OAuth account, API key, or custom endpoint below.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {connectedProviders.map((provider) => {
                const expired = provider.credential?.expired;
                return (
                  <div key={provider.id} className="flex flex-col justify-between gap-3 rounded-lg border border-line bg-ink/50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Check className="h-4 w-4 shrink-0 text-signal" />
                          <p className="truncate text-sm font-semibold text-zinc-100">{provider.name}</p>
                          <Badge tone={expired ? "warn" : "good"}>{authBadgeLabel(provider)}</Badge>
                        </div>
                        <p className="mt-1 truncate text-xs text-zinc-500">
                          {provider.kind === "custom"
                            ? `${provider.custom?.baseUrl} · ${provider.modelCount} model${provider.modelCount === 1 ? "" : "s"}`
                            : `${provider.modelCount} model${provider.modelCount === 1 ? "" : "s"} available`}
                        </p>
                        {provider.credential?.expiresAt && (
                          <p className={cn("mt-1 text-[11px]", expired ? "text-amber-300" : "text-zinc-500")}>
                            {expired ? "Expired" : "Expires"} {formatDate(provider.credential.expiresAt)}
                          </p>
                        )}
                        {provider.refresh?.error && (
                          <p className="mt-1 text-[11px] text-red-400">{provider.refresh.error}</p>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line/60 pt-3">
                      {provider.kind === "custom" ? (
                        <>
                          <Button variant="secondary" size="sm" onClick={() => beginEditCustom(provider)}>
                            <Pencil className="h-3.5 w-3.5" />
                            Edit
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(provider)}>
                            <Trash2 className="h-3.5 w-3.5" />
                            Remove
                          </Button>
                        </>
                      ) : (
                        <>
                          {provider.supportsOAuth && (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy}
                              onClick={() => startOAuth.mutate({ providerId: provider.id })}
                            >
                              Reconnect OAuth
                            </Button>
                          )}
                          {provider.supportsApiKey && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => {
                                setSelectedApiKeyProvider(provider.id);
                                setTab("apiKey");
                              }}
                            >
                              Update key
                            </Button>
                          )}
                          {provider.authType !== "env" && (
                            <Button variant="ghost" size="sm" onClick={() => setDisconnectTarget(provider)}>
                              <LogOut className="h-3.5 w-3.5" />
                              Disconnect
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t border-line pt-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Add or configure a provider</h3>
            <div className="inline-flex rounded-lg border border-line bg-ink/70 p-1">
              {(
                [
                  { id: "oauth", label: "OAuth sign-in" },
                  { id: "apiKey", label: "API key / token" },
                  { id: "custom", label: "Custom endpoint" },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition",
                    tab === item.id ? "bg-white/10 text-white" : "text-zinc-400 hover:text-zinc-200",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {tab === "oauth" && (
            <div className="grid gap-3 md:grid-cols-2">
              {oauthProviders.map((provider) => (
                <div key={provider.id} className="flex flex-col justify-between gap-3 rounded-lg border border-line bg-ink/40 p-4">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-zinc-100">{provider.name}</p>
                      <Badge tone={provider.configured ? "good" : "neutral"}>
                        {provider.configured ? "connected" : provider.oauthFlow === "copy_code" ? "copy code" : "device code"}
                      </Badge>
                    </div>
                    {provider.description && <p className="mt-1 text-xs text-zinc-500">{provider.description}</p>}
                    {provider.supportsEnterpriseDomain && (
                      <div className="mt-3">
                        <Label htmlFor="copilot-enterprise-domain" className="text-xs text-zinc-400">
                          GitHub Enterprise domain (optional)
                        </Label>
                        <Input
                          id="copilot-enterprise-domain"
                          value={copilotEnterpriseDomain}
                          onChange={(event) => setCopilotEnterpriseDomain(event.target.value)}
                          placeholder="Leave blank for github.com"
                          className="mt-1.5 h-9 text-xs"
                        />
                      </div>
                    )}
                  </div>
                  <div className="flex justify-end">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        startOAuth.mutate({
                          providerId: provider.id,
                          enterpriseDomain: provider.supportsEnterpriseDomain ? copilotEnterpriseDomain.trim() || undefined : undefined,
                        })
                      }
                    >
                      {startOAuth.isPending && startOAuth.variables?.providerId === provider.id && (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      )}
                      {provider.configured ? "Reconnect" : "Sign in"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "apiKey" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!activeApiKeyProviderId || !apiKeyInput.trim()) return;
                saveApiKey.mutate({ providerId: activeApiKeyProviderId, apiKey: apiKeyInput.trim() });
              }}
              className="grid gap-4 rounded-lg border border-line bg-ink/40 p-4 md:grid-cols-[240px_1fr_auto] md:items-end"
            >
              <div>
                <Label htmlFor="api-key-provider">Provider</Label>
                <select
                  id="api-key-provider"
                  value={activeApiKeyProviderId}
                  onChange={(event) => setSelectedApiKeyProvider(event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border border-line bg-ink px-3 text-sm text-zinc-100 outline-none focus:border-signal/60"
                >
                  {apiKeyProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}{provider.configured ? " (connected)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="api-key-value">{activeApiKeyProvider?.apiKeyLabel || "API key"}</Label>
                <div className="relative mt-2">
                  <Input
                    id="api-key-value"
                    type={showApiKey ? "text" : "password"}
                    autoComplete="new-password"
                    value={apiKeyInput}
                    onChange={(event) => setApiKeyInput(event.target.value)}
                    placeholder={activeApiKeyProvider?.configured ? "Enter a new key to replace the stored credential" : "Paste API key or token"}
                    className="pr-11"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey((value) => !value)}
                    className="absolute right-0 top-0 grid h-10 w-10 place-items-center text-zinc-500 hover:text-white"
                    aria-label={showApiKey ? "Hide API key" : "Show API key"}
                  >
                    {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <Button type="submit" disabled={!activeApiKeyProviderId || !apiKeyInput.trim() || saveApiKey.isPending}>
                {saveApiKey.isPending && <LoaderCircle className="h-4 w-4 animate-spin" />}
                Save key
              </Button>
              {activeApiKeyProvider?.description && (
                <p className="text-xs text-zinc-500 md:col-span-3">{activeApiKeyProvider.description}</p>
              )}
            </form>
          )}

          {tab === "custom" && (
            <form onSubmit={handleCustomSubmit} className="space-y-4 rounded-lg border border-line bg-ink/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Server className="h-4 w-4 text-signal" />
                  <p className="text-sm font-medium text-zinc-100">
                    {customDraft.editingId ? `Edit custom endpoint (${customDraft.editingId})` : "New custom compatible endpoint"}
                  </p>
                </div>
                {customDraft.editingId && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setCustomDraft(EMPTY_CUSTOM_DRAFT)}>
                    Cancel edit
                  </Button>
                )}
              </div>
              <p className="text-xs text-zinc-500">
                Connect Ollama, LM Studio, LiteLLM, vLLM, or any OpenAI- or Anthropic-compatible server.
              </p>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label htmlFor="custom-provider-name">Display name</Label>
                  <Input
                    id="custom-provider-name"
                    className="mt-2"
                    value={customDraft.name}
                    onChange={(event) => {
                      const name = event.target.value;
                      setCustomDraft((current) => ({
                        ...current,
                        name,
                        id: current.idTouched || current.editingId ? current.id : slugifyProviderId(name),
                      }));
                    }}
                    placeholder="Local Ollama"
                  />
                </div>
                <div>
                  <Label htmlFor="custom-provider-id">Provider ID</Label>
                  <Input
                    id="custom-provider-id"
                    className="mt-2 font-mono"
                    value={customDraft.id}
                    disabled={Boolean(customDraft.editingId)}
                    onChange={(event) => setCustomDraft((current) => ({ ...current, id: event.target.value, idTouched: true }))}
                    placeholder="local-ollama"
                  />
                </div>
                <div>
                  <Label htmlFor="custom-provider-url">Base URL</Label>
                  <Input
                    id="custom-provider-url"
                    className="mt-2"
                    value={customDraft.baseUrl}
                    onChange={(event) => setCustomDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                    placeholder="http://ollama.local:11434/v1"
                  />
                </div>
                <div>
                  <Label htmlFor="custom-provider-api">API protocol</Label>
                  <select
                    id="custom-provider-api"
                    value={customDraft.api}
                    onChange={(event) => setCustomDraft((current) => ({ ...current, api: event.target.value as CustomProviderApi }))}
                    className="mt-2 h-10 w-full rounded-md border border-line bg-ink px-3 text-sm text-zinc-100 outline-none focus:border-signal/60"
                  >
                    <option value="openai-completions">OpenAI Chat Completions (Ollama, vLLM, LM Studio, LiteLLM)</option>
                    <option value="openai-responses">OpenAI Responses API</option>
                    <option value="anthropic-messages">Anthropic Messages API</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-ink/50 p-3">
                <div>
                  <Label htmlFor="custom-requires-key">Requires API key</Label>
                  <p className="mt-0.5 text-xs text-zinc-500">Turn off for local servers like Ollama that do not require an Authorization header.</p>
                </div>
                <Switch
                  id="custom-requires-key"
                  checked={customDraft.requiresApiKey}
                  onCheckedChange={(checked) => setCustomDraft((current) => ({ ...current, requiresApiKey: checked }))}
                  aria-label="Requires API key"
                />
              </div>

              {customDraft.requiresApiKey && (
                <div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="custom-provider-key">API key</Label>
                    {customDraft.apiKeyConfigured && <Badge tone="good">stored</Badge>}
                  </div>
                  <div className="relative mt-2">
                    <Input
                      id="custom-provider-key"
                      type={showCustomKey ? "text" : "password"}
                      autoComplete="new-password"
                      value={customDraft.apiKeyValue}
                      onChange={(event) => setCustomDraft((current) => ({ ...current, apiKeyValue: event.target.value, clearApiKey: false }))}
                      placeholder={customDraft.apiKeyConfigured ? "Leave blank to keep stored API key" : "Enter endpoint API key"}
                      className="pr-11"
                    />
                    <button
                      type="button"
                      onClick={() => setShowCustomKey((value) => !value)}
                      className="absolute right-0 top-0 grid h-10 w-10 place-items-center text-zinc-500 hover:text-white"
                      aria-label={showCustomKey ? "Hide endpoint API key" : "Show endpoint API key"}
                    >
                      {showCustomKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              )}

              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor="custom-provider-models">Model IDs (one per line or comma-separated)</Label>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!customDraft.baseUrl.trim() || discoverModels.isPending}
                    onClick={() => discoverModels.mutate()}
                  >
                    {discoverModels.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    Fetch models
                  </Button>
                </div>
                <Textarea
                  id="custom-provider-models"
                  className="mt-2 font-mono text-xs"
                  rows={3}
                  value={customDraft.modelsText}
                  onChange={(event) => setCustomDraft((current) => ({ ...current, modelsText: event.target.value }))}
                  placeholder={"llama3.3\nqwen2.5:32b"}
                />
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  type="submit"
                  disabled={
                    saveCustom.isPending ||
                    !customDraft.name.trim() ||
                    !(customDraft.editingId ?? customDraft.id).trim() ||
                    !customDraft.baseUrl.trim() ||
                    parseModelsText(customDraft.modelsText).length === 0
                  }
                >
                  {saveCustom.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  {customDraft.editingId ? "Update endpoint" : "Save custom endpoint"}
                </Button>
              </div>
            </form>
          )}
        </div>
      </CardContent>

      <ConfirmDialog
        open={Boolean(disconnectTarget)}
        onOpenChange={(open) => { if (!open) setDisconnectTarget(null); }}
        title={`Disconnect ${disconnectTarget?.name ?? "provider"}?`}
        description="This removes the stored credential for this provider. Any fallback provider in your hierarchy will be used if configured."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => {
          if (disconnectTarget) logoutProvider.mutate(disconnectTarget.id);
          setDisconnectTarget(null);
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={`Remove ${deleteTarget?.name ?? "custom endpoint"}?`}
        description="This removes the custom endpoint configuration and any stored API key for it."
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (deleteTarget) deleteCustom.mutate(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </Card>
  );
}

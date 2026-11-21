import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Eye, EyeOff, FlaskConical, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Controller, type FieldError, type FieldPath, useForm } from "react-hook-form";
import { api, type AiFallbackTarget, type AiModel, type PiModelTestResult, type Settings } from "../lib/api";
import { settingsSchema } from "../lib/schemas";
import { ErrorState, LoadingState } from "./states";
import { useToast } from "./toast";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Switch } from "./ui";
import { SettingsSaveBar } from "./settings-save-bar";

export type SettingsSection = "connections" | "discord" | "ai" | "repair";

export function SettingsEditor({ mode }: { mode: SettingsSection }) {
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const modelsQuery = useQuery({ queryKey: ["ai-models"], queryFn: api.getAiModels, enabled: mode === "ai" });

  if (settingsQuery.isPending) return <LoadingState label="Loading configuration" />;
  if (settingsQuery.isError) return <ErrorState error={settingsQuery.error} retry={() => settingsQuery.refetch()} />;

  return <SettingsForm key={mode} mode={mode} settings={settingsQuery.data} models={modelsQuery.data ?? []} modelsPending={modelsQuery.isPending} modelsError={modelsQuery.error} />;
}

function SettingsForm({ mode, settings, models, modelsPending, modelsError }: { mode: SettingsSection; settings: Settings; models: AiModel[]; modelsPending: boolean; modelsError: Error | null }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const form = useForm<Settings>({ resolver: zodResolver(settingsSchema), values: settings });
  const { formState: { isDirty, errors, isSubmitting }, handleSubmit, register, control, reset, setValue, watch } = form;

  const mutation = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (data) => {
      queryClient.setQueryData(["settings"], data);
      queryClient.invalidateQueries({ queryKey: ["status"] });
      reset(data);
      toast({ tone: "success", title: "Settings saved", description: "Your changes have been applied." });
    },
    onError: (error) => toast({ tone: "error", title: "Save failed", description: error.message }),
  });

  const submit = handleSubmit((values) => mutation.mutateAsync(values));
  return <form onSubmit={submit} noValidate className="space-y-5">
    {mode === "connections" && <ConnectionsFields form={{ register, control, setValue, watch, errors }} />}
    {mode === "discord" && <DiscordFields form={{ register, control, setValue, watch, errors }} />}
    {mode === "ai" && <div className="grid gap-5 xl:grid-cols-2"><AiModelFields form={{ register, control, setValue, watch, errors }} models={models} pending={modelsPending} error={modelsError} /><TimeoutFields form={{ register, control, setValue, watch, errors }} /></div>}
    {mode === "repair" && <RepairFields form={{ register, control, setValue, watch, errors }} />}
    <SettingsSaveBar dirty={isDirty} saving={isSubmitting || mutation.isPending} onReset={() => reset(settings)} />
  </form>;
}

type FormParts = Pick<ReturnType<typeof useForm<Settings>>, "register" | "control" | "setValue" | "watch"> & { errors: ReturnType<typeof useForm<Settings>>["formState"]["errors"] };

function ConnectionsFields({ form }: { form: FormParts }) {
  const { register, control, watch, errors } = form;
  return <div className="grid gap-5 xl:grid-cols-2">
    <Section title="Plex media server" description="Primary library and playback server."><TextField label="Server URL" path="plex.url" register={register} error={errors.plex?.url} placeholder="http://plex.local:32400" /><SecretField label="Plex token" base="plex.token" register={register} control={control} watch={watch} /></Section>
    <Section title="Sonarr" description="Television index and repair target."><TextField label="Server URL" path="sonarr.url" register={register} error={errors.sonarr?.url} placeholder="http://sonarr.local:8989" /><SecretField label="API key" base="sonarr.apiKey" register={register} control={control} watch={watch} /></Section>
    <Section title="Radarr" description="Movie index and repair target."><TextField label="Server URL" path="radarr.url" register={register} error={errors.radarr?.url} placeholder="http://radarr.local:7878" /><SecretField label="API key" base="radarr.apiKey" register={register} control={control} watch={watch} /></Section>
    <Section title="Seerr requests" description="Optional request tracking, approvals, and server defaults for new movies and TV shows.">
      <TextField label="Seerr URL" path="seerr.url" register={register} error={errors.seerr?.url} placeholder="http://seerr.local:5055" />
      <SecretField label="Seerr API key" base="seerr.apiKey" register={register} control={control} watch={watch} />
      <ToggleField label="Prefer Seerr for new requests" description="Use Seerr whenever this connection is configured. Its approval and quota rules apply." path="seerr.preferForRequests" control={control} />
      <TextField label="Seerr account for unlinked requesters" path="seerr.defaultUserId" register={register} error={errors.seerr?.defaultUserId} type="number" placeholder="0" />
      <p className="text-xs text-zinc-500">A Seerr user ID to own unlinked Discord requests. Its permissions and approval rules apply. Use 0 to require linked accounts.</p>
      <div><Label htmlFor="seerr-user-mappings">Discord user mappings</Label><textarea id="seerr-user-mappings" {...register("seerr.userMappings")} rows={3} placeholder="DiscordID:SeerrUserID" className="mt-2 w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-zinc-100" /><p className="mt-1 text-xs text-zinc-500">Optional overrides, one pair per line. Otherwise use the Discord IDs linked in each Seerr user's notification settings.</p>{errors.seerr?.userMappings && <p className="mt-1 text-xs text-red-400">{errors.seerr.userMappings.message}</p>}</div>
    </Section>
  </div>;
}

function DiscordFields({ form }: { form: FormParts }) {
  const { register, control, watch, errors } = form;
  return <div className="grid gap-5 xl:grid-cols-2">
    <Section title="Bot identity" description="Connect the bot to your Discord application."><TextField label="Application ID" path="discord.applicationId" register={register} error={errors.discord?.applicationId} placeholder="Discord application ID" /><SecretField label="Bot token" base="discord.token" register={register} control={control} watch={watch} /></Section>
    <Section title="Discord access" description="Limit where commands are accepted and who can run repairs."><TextField label="Allowed guild IDs" path="discord.allowedGuildIds" register={register} placeholder="Comma-separated; blank allows all" /><TextField label="Allowed channel IDs" path="discord.allowedChannelIds" register={register} placeholder="Comma-separated; blank allows all" /><TextField label="Repair role IDs" path="discord.repairRoleIds" register={register} placeholder="Comma-separated" /><ToggleField label="Allow direct messages" description="Accept repair requests outside servers." path="discord.allowDirectMessages" control={control} /><ToggleField label="Message reactions" description="Use reactions to communicate task state." path="discord.reactionsEnabled" control={control} /></Section>
  </div>;
}

function RepairFields({ form }: { form: FormParts }) {
  const { control } = form;
  return <div className="grid gap-5 xl:grid-cols-2">
    <Section title="New content requests" description="Choose whether the bot can add new library entries directly."><ToggleField label="Allow direct Sonarr/Radarr additions" description="Allow new movies or series using existing root folders and quality profiles. Off by default. A configured preferred Seerr connection handles requests instead." path="repair.allowDirectAdd" control={control} /></Section>
    <Section title="Repair safeguards" description="Control which actions the bot can take on your media."><ToggleField label="Require confirmation" description="Ask the requester to approve each exact repair action before it runs." path="repair.requireConfirmation" control={control} /><ToggleField label="Allow destructive repairs" description="Permit queue removal, file deletion, and movie or series removal." path="repair.allowDestructive" control={control} /></Section>
  </div>;
}

function TimeoutFields({ form }: { form: FormParts }) {
  return <Section title="Request timeouts" description="How long to wait for standard operations and release searches."><TextField label="Standard timeout (seconds)" path="timeouts.standardSeconds" register={form.register} error={form.errors.timeouts?.standardSeconds} type="number" /><TextField label="Release lookup timeout (seconds)" path="timeouts.releaseLookupSeconds" register={form.register} error={form.errors.timeouts?.releaseLookupSeconds} type="number" /></Section>;
}

function AiModelFields({ form, models, pending, error }: { form: FormParts; models: AiModel[]; pending: boolean; error: Error | null }) {
  const toast = useToast();
  const [testResults, setTestResults] = useState<Record<string, PiModelTestResult>>({});
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const provider = form.watch("ai.modelProvider");
  const modelId = form.watch("ai.modelId");
  const fallbacks = form.watch("ai.fallbacks") ?? [];
  const providers = [...new Set(models.map((model) => model.provider))].sort();
  const providerModels = models.filter((model) => model.provider === provider);
  const providerAvailable = providers.includes(provider);
  const modelAvailable = providerModels.some((model) => model.id === modelId);
  const providerField = form.register("ai.modelProvider");
  const hasCodexInHierarchy = provider === "openai-codex" || fallbacks.some((item) => item.modelProvider === "openai-codex");

  const runModelTest = useMutation({
    mutationFn: (params: { key: string; providerId: string; modelId?: string }) =>
      api.testPiModel({ providerId: params.providerId, modelId: params.modelId }),
    onMutate: ({ key }) => setTestingKey(key),
    onSuccess: (result, { key }) => {
      setTestResults((current) => ({ ...current, [key]: result }));
      toast({
        tone: result.ok ? "success" : "error",
        title: result.ok ? `${result.provider}/${result.modelId} responded (${result.latencyMs}ms)` : `${result.provider}/${result.modelId || "model"} test failed`,
        description: result.ok ? result.reply : result.error,
      });
    },
    onError: (err, { key, providerId, modelId: targetModelId }) => {
      setTestResults((current) => ({
        ...current,
        [key]: { ok: false, provider: providerId, modelId: targetModelId ?? "", latencyMs: 0, error: err.message },
      }));
      toast({ tone: "error", title: "Model test failed", description: err.message });
    },
    onSettled: () => setTestingKey(null),
  });

  const primaryTestKey = `${provider}\0${modelId}`;
  const primaryTestResult = testResults[primaryTestKey];

  const updateFallbacks = (next: AiFallbackTarget[]) => {
    form.setValue("ai.fallbacks", next, { shouldDirty: true, shouldValidate: true });
  };

  const swapWithPrimary = (fallbackIndex: number) => {
    const target = fallbacks[fallbackIndex];
    if (!target) return;
    const nextFallbacks = [...fallbacks];
    nextFallbacks[fallbackIndex] = { modelProvider: provider, modelId };
    form.setValue("ai.modelProvider", target.modelProvider, { shouldDirty: true, shouldValidate: true });
    form.setValue("ai.modelId", target.modelId, { shouldDirty: true, shouldValidate: true });
    updateFallbacks(nextFallbacks);
  };

  const moveFallback = (index: number, direction: -1 | 1) => {
    if (index === 0 && direction === -1) {
      swapWithPrimary(0);
      return;
    }
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= fallbacks.length) return;
    const next = [...fallbacks];
    const current = next[index]!;
    next[index] = next[targetIndex]!;
    next[targetIndex] = current;
    updateFallbacks(next);
  };

  const addFallback = () => {
    const usedProviders = new Set([provider, ...fallbacks.map((item) => item.modelProvider)]);
    const nextProvider = providers.find((item) => !usedProviders.has(item)) ?? providers[0] ?? provider ?? "";
    const nextModels = models.filter((model) => model.provider === nextProvider);
    const usedKeys = new Set([`${provider}\0${modelId}`, ...fallbacks.map((item) => `${item.modelProvider}\0${item.modelId}`)]);
    const nextModel = nextModels.find((model) => !usedKeys.has(`${nextProvider}\0${model.id}`))?.id ?? nextModels[0]?.id ?? "";
    updateFallbacks([...fallbacks, { modelProvider: nextProvider, modelId: nextModel }]);
  };

  const updateFallbackEntry = (index: number, patch: Partial<AiFallbackTarget>) => {
    const next = fallbacks.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item));
    updateFallbacks(next);
  };

  const removeFallback = (index: number) => {
    updateFallbacks(fallbacks.filter((_, itemIndex) => itemIndex !== index));
  };

  return <Section title="AI model & fallback hierarchy" description="Order your primary model and optional fallbacks. If the primary fails before taking actions, the next model is tried automatically.">
    <div className="space-y-3 rounded-lg border border-line bg-ink/40 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone="good">#1 Primary</Badge>
          <span className="text-xs text-zinc-400">Used first for every request</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!provider || testingKey === primaryTestKey}
            onClick={() => runModelTest.mutate({ key: primaryTestKey, providerId: provider, modelId: modelId || undefined })}
            aria-label="Test primary model"
          >
            {testingKey === primaryTestKey ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
            Test
          </Button>
          {fallbacks.length > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={() => swapWithPrimary(0)} aria-label="Move primary down">
              <ArrowDown className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="model-provider">Model provider</Label>
          <select id="model-provider" {...providerField} value={provider} onChange={(event) => { providerField.onChange(event); form.setValue("ai.modelId", "", { shouldDirty: true, shouldValidate: true }); }} aria-invalid={!!form.errors.ai?.modelProvider} className="mt-2 h-10 w-full rounded-md border border-line bg-ink px-3 text-sm text-zinc-100 outline-none focus:border-signal/60">
            <option value="">Select a provider</option>
            {provider && !providerAvailable && <option value={provider}>{provider} (Unavailable)</option>}
            {providers.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          {form.errors.ai?.modelProvider && <p className="mt-1.5 text-xs text-red-400">{form.errors.ai.modelProvider.message}</p>}
        </div>
        <div>
          <Label htmlFor="model-id">Model</Label>
          <select id="model-id" {...form.register("ai.modelId")} value={modelId} aria-invalid={!!form.errors.ai?.modelId} disabled={!provider || pending} className="mt-2 h-10 w-full rounded-md border border-line bg-ink px-3 text-sm text-zinc-100 outline-none focus:border-signal/60 disabled:cursor-not-allowed disabled:opacity-60">
            <option value="">Select a model</option>
            {modelId && !modelAvailable && <option value={modelId}>{modelId} (Unavailable)</option>}
            {providerModels.map((model) => <option key={model.id} value={model.id}>{model.name} ({model.id})</option>)}
          </select>
          {form.errors.ai?.modelId && <p className="mt-1.5 text-xs text-red-400">{form.errors.ai.modelId.message}</p>}
        </div>
      </div>
      {primaryTestResult && (
        <p className={`text-xs ${primaryTestResult.ok ? "text-signal" : "text-red-400"}`}>
          {primaryTestResult.ok
            ? `Test passed (${primaryTestResult.latencyMs}ms): ${primaryTestResult.reply}`
            : `Test failed: ${primaryTestResult.error}`}
        </p>
      )}
    </div>

    {fallbacks.map((fallback, index) => {
      const fbModels = models.filter((model) => model.provider === fallback.modelProvider);
      const fbProviderAvailable = providers.includes(fallback.modelProvider);
      const fbModelAvailable = fbModels.some((model) => model.id === fallback.modelId);
      const fbErrors = Array.isArray(form.errors.ai?.fallbacks) ? form.errors.ai.fallbacks[index] : undefined;
      const fbTestKey = `${fallback.modelProvider}\0${fallback.modelId}`;
      const fbTestResult = testResults[fbTestKey];
      return (
        <div key={index} className="space-y-3 rounded-lg border border-line bg-ink/30 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <Badge tone="neutral">#{index + 2} Fallback</Badge>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!fallback.modelProvider || testingKey === fbTestKey}
                onClick={() => runModelTest.mutate({ key: fbTestKey, providerId: fallback.modelProvider, modelId: fallback.modelId || undefined })}
                aria-label={`Test fallback ${index + 1} model`}
              >
                {testingKey === fbTestKey ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
                Test
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => moveFallback(index, -1)} aria-label={`Move fallback ${index + 1} up`}>
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={index === fallbacks.length - 1} onClick={() => moveFallback(index, 1)} aria-label={`Move fallback ${index + 1} down`}>
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => removeFallback(index)} aria-label={`Remove fallback ${index + 1}`}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor={`fallback-provider-${index}`}>Fallback {index + 1} provider</Label>
              <select
                id={`fallback-provider-${index}`}
                value={fallback.modelProvider}
                onChange={(event) => {
                  const nextProvider = event.target.value;
                  const firstModel = models.find((model) => model.provider === nextProvider)?.id ?? "";
                  updateFallbackEntry(index, { modelProvider: nextProvider, modelId: firstModel });
                }}
                className="mt-2 h-10 w-full rounded-md border border-line bg-ink px-3 text-sm text-zinc-100 outline-none focus:border-signal/60"
              >
                <option value="">Select a provider</option>
                {fallback.modelProvider && !fbProviderAvailable && <option value={fallback.modelProvider}>{fallback.modelProvider} (Unavailable)</option>}
                {providers.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              {fbErrors?.modelProvider && <p className="mt-1.5 text-xs text-red-400">{fbErrors.modelProvider.message}</p>}
            </div>
            <div>
              <Label htmlFor={`fallback-model-${index}`}>Fallback {index + 1} model</Label>
              <select
                id={`fallback-model-${index}`}
                value={fallback.modelId}
                disabled={!fallback.modelProvider || pending}
                onChange={(event) => updateFallbackEntry(index, { modelId: event.target.value })}
                className="mt-2 h-10 w-full rounded-md border border-line bg-ink px-3 text-sm text-zinc-100 outline-none focus:border-signal/60 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="">Select a model</option>
                {fallback.modelId && !fbModelAvailable && <option value={fallback.modelId}>{fallback.modelId} (Unavailable)</option>}
                {fbModels.map((model) => <option key={model.id} value={model.id}>{model.name} ({model.id})</option>)}
              </select>
              {fbErrors?.modelId && <p className="mt-1.5 text-xs text-red-400">{fbErrors.modelId.message}</p>}
            </div>
          </div>
          {fbTestResult && (
            <p className={`text-xs ${fbTestResult.ok ? "text-signal" : "text-red-400"}`}>
              {fbTestResult.ok
                ? `Test passed (${fbTestResult.latencyMs}ms): ${fbTestResult.reply}`
                : `Test failed: ${fbTestResult.error}`}
            </p>
          )}
        </div>
      );
    })}

    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={addFallback} disabled={fallbacks.length >= 10 || models.length === 0}>
        <Plus className="h-3.5 w-3.5" />
        Add fallback model
      </Button>
      {pending && <p className="text-xs text-zinc-500">Loading authenticated models...</p>}
      {error && <p className="text-xs text-red-400">Could not load models: {error.message}</p>}
      {!pending && !error && models.length === 0 && <p className="text-xs text-amber-300">Connect an AI provider above before selecting a model.</p>}
    </div>

    <div><Label htmlFor="thinking">Thinking level</Label><select id="thinking" {...form.register("ai.thinkingLevel")} className="mt-2 h-10 w-full rounded-md border border-line bg-ink px-3 text-sm text-zinc-100 outline-none focus:border-signal/60">{["off", "minimal", "low", "medium", "high", "xhigh"].map((value) => <option key={value}>{value}</option>)}</select></div>
    <div><Label htmlFor="service-tier">Service tier</Label><select id="service-tier" {...form.register("ai.serviceTier")} className="mt-2 h-10 w-full rounded-md border border-line bg-ink px-3 text-sm text-zinc-100 outline-none focus:border-signal/60"><option value="default">Standard</option><option value="priority">Priority (Fast)</option></select><p className="mt-1.5 text-xs text-zinc-500">{hasCodexInHierarchy ? "Priority requests faster processing when OpenAI Codex is used." : "Applies only when OpenAI Codex is in your model hierarchy."}</p></div>
  </Section>;
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <Card><CardHeader><CardTitle>{title}</CardTitle><p className="mt-1 text-xs text-zinc-500">{description}</p></CardHeader><CardContent className="space-y-5">{children}</CardContent></Card>; }

function TextField({ label, path, register, error, placeholder, type = "text" }: { label: string; path: FieldPath<Settings>; register: FormParts["register"]; error?: FieldError; placeholder?: string; type?: string }) {
  const id = path.replaceAll(".", "-");
  return <div><Label htmlFor={id}>{label}</Label><Input id={id} type={type} placeholder={placeholder} aria-invalid={!!error} className="mt-2" {...register(path, type === "number" ? { valueAsNumber: true } : undefined)} />{error && <p className="mt-1.5 text-xs text-red-400">{error.message}</p>}</div>;
}

function ToggleField({ label, description, path, control }: { label: string; description: string; path: FieldPath<Settings>; control: FormParts["control"] }) {
  return <Controller name={path} control={control} render={({ field }) => <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-ink/40 p-3"><div><Label>{label}</Label><p className="mt-0.5 text-xs text-zinc-500">{description}</p></div><Switch checked={Boolean(field.value)} onCheckedChange={field.onChange} aria-label={label} /></div>} />;
}

function SecretField({ label, base, register, control, watch }: { label: string; base: "discord.token" | "sonarr.apiKey" | "radarr.apiKey" | "plex.token" | "seerr.apiKey"; register: FormParts["register"]; control: FormParts["control"]; watch: FormParts["watch"] }) {
  const [visible, setVisible] = useState(false);
  const configured = watch(`${base}.configured`);
  const clear = watch(`${base}.clear`);
  return <div><div className="flex items-center justify-between"><Label htmlFor={`${base}-value`}>{label}</Label><Badge tone={configured && !clear ? "good" : "neutral"}>{clear ? "will clear" : configured ? "configured" : "not set"}</Badge></div><div className="relative mt-2"><Input id={`${base}-value`} type={visible ? "text" : "password"} autoComplete="new-password" placeholder={configured ? "Leave blank to keep existing secret" : "Enter credential"} className="pr-11" {...register(`${base}.value`)} /><button type="button" onClick={() => setVisible((value) => !value)} className="absolute right-0 top-0 grid h-10 w-10 place-items-center text-zinc-500 hover:text-white" aria-label={visible ? "Hide secret" : "Show secret"}>{visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div><Controller name={`${base}.clear`} control={control} render={({ field }) => <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-zinc-500"><input type="checkbox" checked={Boolean(field.value)} onChange={field.onChange} className="accent-[#f2b84b]" />Clear stored secret when saving</label>} /></div>;
}

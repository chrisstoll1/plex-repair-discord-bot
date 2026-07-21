import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, LoaderCircle, RotateCcw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { Controller, type FieldError, type FieldPath, useForm } from "react-hook-form";
import { useBlocker } from "react-router-dom";
import { api, type AiModel, type Settings } from "../lib/api";
import { settingsSchema } from "../lib/schemas";
import { ErrorState, LoadingState } from "./states";
import { useToast } from "./toast";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, ConfirmDialog, Input, Label, Switch } from "./ui";

export function SettingsEditor({ mode }: { mode: "connections" | "bot" }) {
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const modelsQuery = useQuery({ queryKey: ["ai-models"], queryFn: api.getAiModels, enabled: mode === "bot" });

  if (settingsQuery.isPending) return <LoadingState label="Loading configuration" />;
  if (settingsQuery.isError) return <ErrorState error={settingsQuery.error} retry={() => settingsQuery.refetch()} />;

  return <SettingsForm mode={mode} settings={settingsQuery.data} models={modelsQuery.data ?? []} modelsPending={modelsQuery.isPending} modelsError={modelsQuery.error} />;
}

function SettingsForm({ mode, settings, models, modelsPending, modelsError }: { mode: "connections" | "bot"; settings: Settings; models: AiModel[]; modelsPending: boolean; modelsError: Error | null }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const form = useForm<Settings>({ resolver: zodResolver(settingsSchema), values: settings });
  const { formState: { isDirty, errors, isSubmitting }, handleSubmit, register, control, reset, setValue, watch } = form;
  const blocker = useBlocker(isDirty);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (isDirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isDirty]);

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
    {mode === "connections" ? <ConnectionsFields form={{ register, control, setValue, watch, errors }} /> : <BotFields form={{ register, control, setValue, watch, errors }} models={models} modelsPending={modelsPending} modelsError={modelsError} />}
    <div className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-xl border border-line bg-[#11171c]/95 p-3 shadow-2xl backdrop-blur sm:flex-row sm:items-center sm:justify-between">
      <p className="px-1 text-xs text-zinc-500">{isDirty ? <span className="text-amber-300">Unsaved configuration changes</span> : "All changes saved"}</p>
      <div className="flex gap-2"><Button type="button" variant="ghost" disabled={!isDirty || isSubmitting} onClick={() => reset(settings)}><RotateCcw className="h-4 w-4" />Reset</Button><Button type="submit" disabled={!isDirty || isSubmitting || mutation.isPending}>{mutation.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save changes</Button></div>
    </div>
    <ConfirmDialog open={blocker.state === "blocked"} onOpenChange={(open) => { if (!open && blocker.state === "blocked") blocker.reset(); }} title="Discard unsaved changes?" description="You have configuration changes that have not been saved. Leaving this view will discard them." confirmLabel="Discard and leave" destructive onConfirm={() => blocker.state === "blocked" && blocker.proceed()} />
  </form>;
}

type FormParts = Pick<ReturnType<typeof useForm<Settings>>, "register" | "control" | "setValue" | "watch"> & { errors: ReturnType<typeof useForm<Settings>>["formState"]["errors"] };

function ConnectionsFields({ form }: { form: FormParts }) {
  const { register, control, watch, errors } = form;
  return <div className="grid gap-5 xl:grid-cols-2">
    <Section title="Discord gateway" description="Bot identity and Discord access credential."><TextField label="Application ID" path="discord.applicationId" register={register} error={errors.discord?.applicationId} placeholder="Discord application ID" /><SecretField label="Bot token" base="discord.token" register={register} control={control} watch={watch} /></Section>
    <Section title="Plex media server" description="Primary library and playback server."><TextField label="Server URL" path="plex.url" register={register} error={errors.plex?.url} placeholder="http://plex.local:32400" /><SecretField label="Plex token" base="plex.token" register={register} control={control} watch={watch} /></Section>
    <Section title="Sonarr" description="Television index and repair target."><TextField label="Server URL" path="sonarr.url" register={register} error={errors.sonarr?.url} placeholder="http://sonarr.local:8989" /><SecretField label="API key" base="sonarr.apiKey" register={register} control={control} watch={watch} /></Section>
    <Section title="Radarr" description="Movie index and repair target."><TextField label="Server URL" path="radarr.url" register={register} error={errors.radarr?.url} placeholder="http://radarr.local:7878" /><SecretField label="API key" base="radarr.apiKey" register={register} control={control} watch={watch} /></Section>
  </div>;
}

function BotFields({ form, models, modelsPending, modelsError }: { form: FormParts; models: AiModel[]; modelsPending: boolean; modelsError: Error | null }) {
  const { register, control, errors } = form;
  return <div className="grid gap-5 xl:grid-cols-2">
    <Section title="Discord access" description="Limit where commands are accepted and who can run repairs."><TextField label="Allowed guild IDs" path="discord.allowedGuildIds" register={register} placeholder="Comma-separated; blank allows all" /><TextField label="Allowed channel IDs" path="discord.allowedChannelIds" register={register} placeholder="Comma-separated; blank allows all" /><TextField label="Repair role IDs" path="discord.repairRoleIds" register={register} placeholder="Comma-separated" /><ToggleField label="Allow direct messages" description="Accept repair requests outside servers." path="discord.allowDirectMessages" control={control} /><ToggleField label="Message reactions" description="Use reactions to communicate task state." path="discord.reactionsEnabled" control={control} /></Section>
    <AiModelFields form={form} models={models} pending={modelsPending} error={modelsError} />
    <Section title="Safety and timeouts" description="Set request limits and control which repairs may execute."><TextField label="Standard timeout (seconds)" path="timeouts.standardSeconds" register={register} error={errors.timeouts?.standardSeconds} type="number" /><TextField label="Release lookup timeout (seconds)" path="timeouts.releaseLookupSeconds" register={register} error={errors.timeouts?.releaseLookupSeconds} type="number" /><ToggleField label="Require confirmation" description="Blocks repair execution until action-specific confirmation is implemented." path="repair.requireConfirmation" control={control} /><ToggleField label="Allow destructive repairs" description="Permit queue removal, file deletion, and movie or series removal." path="repair.allowDestructive" control={control} /></Section>
  </div>;
}

function AiModelFields({ form, models, pending, error }: { form: FormParts; models: AiModel[]; pending: boolean; error: Error | null }) {
  const provider = form.watch("ai.modelProvider");
  const modelId = form.watch("ai.modelId");
  const providers = [...new Set(models.map((model) => model.provider))].sort();
  const providerModels = models.filter((model) => model.provider === provider);
  const providerAvailable = providers.includes(provider);
  const modelAvailable = providerModels.some((model) => model.id === modelId);
  const providerField = form.register("ai.modelProvider");

  return <Section title="AI model" description="Choose from models available through authenticated providers.">
    <div><Label htmlFor="model-provider">Model provider</Label><select id="model-provider" {...providerField} value={provider} onChange={(event) => { providerField.onChange(event); form.setValue("ai.modelId", "", { shouldDirty: true, shouldValidate: true }); }} aria-invalid={!!form.errors.ai?.modelProvider} className="mt-2 h-10 w-full rounded-md border border-line bg-ink px-3 text-sm text-zinc-100 outline-none focus:border-signal/60"><option value="">Select a provider</option>{provider && !providerAvailable && <option value={provider}>{provider} (Unavailable)</option>}{providers.map((value) => <option key={value} value={value}>{value}</option>)}</select>{form.errors.ai?.modelProvider && <p className="mt-1.5 text-xs text-red-400">{form.errors.ai.modelProvider.message}</p>}</div>
    <div><Label htmlFor="model-id">Model</Label><select id="model-id" {...form.register("ai.modelId")} value={modelId} aria-invalid={!!form.errors.ai?.modelId} disabled={!provider || pending} className="mt-2 h-10 w-full rounded-md border border-line bg-ink px-3 text-sm text-zinc-100 outline-none focus:border-signal/60 disabled:cursor-not-allowed disabled:opacity-60"><option value="">Select a model</option>{modelId && !modelAvailable && <option value={modelId}>{modelId} (Unavailable)</option>}{providerModels.map((model) => <option key={model.id} value={model.id}>{model.name} ({model.id})</option>)}</select>{form.errors.ai?.modelId && <p className="mt-1.5 text-xs text-red-400">{form.errors.ai.modelId.message}</p>}{pending && <p className="mt-1.5 text-xs text-zinc-500">Loading authenticated models...</p>}{error && <p className="mt-1.5 text-xs text-red-400">Could not load models: {error.message}</p>}{!pending && !error && models.length === 0 && <p className="mt-1.5 text-xs text-amber-300">Connect an AI provider before selecting a model.</p>}</div>
    <div><Label htmlFor="thinking">Thinking level</Label><select id="thinking" {...form.register("ai.thinkingLevel")} className="mt-2 h-10 w-full rounded-md border border-line bg-ink px-3 text-sm text-zinc-100 outline-none focus:border-signal/60">{["off", "minimal", "low", "medium", "high", "xhigh"].map((value) => <option key={value}>{value}</option>)}</select></div>
    <div><Label htmlFor="service-tier">Service tier</Label><select id="service-tier" {...form.register("ai.serviceTier")} className="mt-2 h-10 w-full rounded-md border border-line bg-ink px-3 text-sm text-zinc-100 outline-none focus:border-signal/60"><option value="default">Standard</option><option value="priority">Priority (Fast)</option></select><p className="mt-1.5 text-xs text-zinc-500">Priority requests faster processing from OpenAI Codex.</p></div>
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

function SecretField({ label, base, register, control, watch }: { label: string; base: "discord.token" | "sonarr.apiKey" | "radarr.apiKey" | "plex.token"; register: FormParts["register"]; control: FormParts["control"]; watch: FormParts["watch"] }) {
  const [visible, setVisible] = useState(false);
  const configured = watch(`${base}.configured`);
  const clear = watch(`${base}.clear`);
  return <div><div className="flex items-center justify-between"><Label htmlFor={`${base}-value`}>{label}</Label><Badge tone={configured && !clear ? "good" : "neutral"}>{clear ? "will clear" : configured ? "configured" : "not set"}</Badge></div><div className="relative mt-2"><Input id={`${base}-value`} type={visible ? "text" : "password"} autoComplete="new-password" placeholder={configured ? "Leave blank to keep existing secret" : "Enter credential"} className="pr-11" {...register(`${base}.value`)} /><button type="button" onClick={() => setVisible((value) => !value)} className="absolute right-0 top-0 grid h-10 w-10 place-items-center text-zinc-500 hover:text-white" aria-label={visible ? "Hide secret" : "Show secret"}>{visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div><Controller name={`${base}.clear`} control={control} render={({ field }) => <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-zinc-500"><input type="checkbox" checked={Boolean(field.value)} onChange={field.onChange} className="accent-[#f2b84b]" />Clear stored secret when saving</label>} /></div>;
}

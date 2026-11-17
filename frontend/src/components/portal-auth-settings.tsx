import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, type PortalAuthSettings as AuthSettings } from "../lib/api";
import { ErrorState, LoadingState } from "./states";
import { Card, CardContent, CardHeader, CardTitle, Input, Label, Switch } from "./ui";
import { SettingsSaveBar } from "./settings-save-bar";

export function PortalAuthSettings() {
  const query = useQuery({ queryKey: ["portal-auth"], queryFn: api.getPortalAuth, refetchOnWindowFocus: false, staleTime: Infinity });
  if (query.isPending) return <LoadingState label="Loading portal access" />;
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  return <PortalAuthForm settings={query.data} />;
}

function PortalAuthForm({ settings }: { settings: AuthSettings }) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [username, setUsername] = useState(settings.username);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [validationError, setValidationError] = useState("");
  const [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: api.updatePortalAuth,
    onSuccess: (value) => {
      queryClient.setQueryData(["portal-auth"], value);
      setEnabled(value.enabled); setUsername(value.username); setPassword(""); setConfirmation(""); setCurrentPassword(""); setSaved(true);
    },
  });
  const dirty = enabled !== settings.enabled || username !== settings.username || password.length > 0;
  function reset() { setEnabled(settings.enabled); setUsername(settings.username); setPassword(""); setConfirmation(""); setCurrentPassword(""); setValidationError(""); setSaved(false); mutation.reset(); }
  function submit(event: FormEvent) {
    event.preventDefault(); setSaved(false); setValidationError("");
    if (password !== confirmation) { setValidationError("The new passwords do not match."); return; }
    mutation.mutate({ enabled, username, ...(password ? { password } : {}), ...(settings.enabled ? { currentPassword } : {}) });
  }
  return <Card><CardHeader><CardTitle>Administrator sign-in</CardTitle></CardHeader>
    <CardContent><form onSubmit={submit} className="space-y-5">
      <div className="flex items-center justify-between gap-4"><div><Label htmlFor="portal-sign-in">Require sign-in</Label><p className="mt-1 max-w-xl text-sm text-zinc-500">When off, anyone with portal access is an administrator.</p></div>
        <Switch id="portal-sign-in" checked={enabled} onCheckedChange={(value) => { setEnabled(value); setSaved(false); if (!value) { setPassword(""); setConfirmation(""); setUsername(settings.username); } }} aria-label="Require sign-in" />
      </div>
      {enabled && <div className="grid max-w-2xl gap-5 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="portal-username">Username</Label><Input id="portal-username" autoComplete="username" required maxLength={128} value={username} onChange={(event) => { setUsername(event.target.value); setSaved(false); }} /></div>
        <div className="space-y-2"><Label htmlFor="portal-password">Password</Label><Input id="portal-password" type="password" autoComplete="new-password" required={!settings.passwordConfigured} minLength={8} maxLength={256} value={password} onChange={(event) => { setPassword(event.target.value); setSaved(false); }} placeholder={settings.passwordConfigured ? "Leave blank to keep current password" : "At least 8 characters"} /></div>
        <div className="space-y-2"><Label htmlFor="portal-confirm-password">Confirm new password</Label><Input id="portal-confirm-password" type="password" autoComplete="new-password" required={password.length > 0} maxLength={256} value={confirmation} onChange={(event) => { setConfirmation(event.target.value); setSaved(false); }} /></div>
      </div>}
      {settings.enabled && <div className="max-w-sm space-y-2"><Label htmlFor="portal-current-password">Current password</Label><Input id="portal-current-password" type="password" autoComplete="current-password" required maxLength={256} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></div>}
      {saved && <p role="status" className="text-sm text-signal">{enabled ? "Sign-in enabled. You are signed in on this browser." : "Sign-in disabled."}</p>}
      {validationError && <p role="alert" className="text-sm text-red-300">{validationError}</p>}
      {mutation.error && <p role="alert" className="text-sm text-red-300">{mutation.error.message}</p>}
      <SettingsSaveBar dirty={dirty} saving={mutation.isPending} onReset={reset} />
    </form></CardContent>
  </Card>;
}

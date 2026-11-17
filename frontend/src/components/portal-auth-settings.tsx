import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, type PortalAuthSettings as AuthSettings } from "../lib/api";
import { ErrorState, LoadingState } from "./states";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Switch } from "./ui";

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
  const [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: api.updatePortalAuth,
    onSuccess: (value) => {
      queryClient.setQueryData(["portal-auth"], value);
      setEnabled(value.enabled); setUsername(value.username); setPassword(""); setSaved(true);
    },
  });
  const dirty = enabled !== settings.enabled || username !== settings.username || password.length > 0;
  function submit(event: FormEvent) {
    event.preventDefault(); setSaved(false);
    mutation.mutate({ enabled, username, ...(password ? { password } : {}) });
  }
  return <Card className="mb-6"><CardHeader><CardTitle>Portal access</CardTitle><p className="mt-1 text-sm text-zinc-500">Optional HTTP Basic authentication for the web portal.</p></CardHeader>
    <CardContent><form onSubmit={submit} className="space-y-5">
      <div className="flex items-center justify-between gap-4"><div><Label htmlFor="portal-basic-auth">Enable Basic authentication</Label><p className="mt-1 text-sm text-zinc-500">Leave off if your reverse proxy already handles authentication. Otherwise, anyone who can reach this portal can manage the bot.</p></div>
        <Switch id="portal-basic-auth" checked={enabled} onCheckedChange={(value) => { setEnabled(value); setSaved(false); if (!value) { setPassword(""); setUsername(settings.username); } }} aria-label="Enable Basic authentication" />
      </div>
      {enabled && <div className="grid max-w-2xl gap-5 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="portal-username">Username</Label><Input id="portal-username" autoComplete="username" required maxLength={128} value={username} onChange={(event) => { setUsername(event.target.value); setSaved(false); }} /></div>
        <div className="space-y-2"><Label htmlFor="portal-password">Password</Label><Input id="portal-password" type="password" autoComplete="new-password" required={!settings.passwordConfigured} minLength={8} maxLength={256} value={password} onChange={(event) => { setPassword(event.target.value); setSaved(false); }} placeholder={settings.passwordConfigured ? "Leave blank to keep current password" : "At least 8 characters"} /></div>
      </div>}
      <p className="text-xs text-zinc-500">When enabled, your browser asks for the username and password. Use HTTPS when accessing the portal remotely.</p>
      <Button type="submit" disabled={!dirty || mutation.isPending}>{mutation.isPending ? "Saving…" : "Save portal access"}</Button>
      {saved && <p role="status" className="text-sm text-signal">{enabled ? "Basic authentication enabled. Your browser will ask you to sign in on the next request." : "Basic authentication disabled."}</p>}
      {mutation.error && <p role="alert" className="text-sm text-red-300">{mutation.error.message}</p>}
    </form></CardContent>
  </Card>;
}

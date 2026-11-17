import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type PortalSession } from "../lib/api";
import { Button, Card, CardContent, Input, Label } from "./ui";

export function PortalAccess({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<PortalSession>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [token, setToken] = useState("");

  useEffect(() => {
    let active = true;
    const load = () => { setError(""); void api.getPortalSession().then((value) => { if (active) setSession(value); }).catch(() => { if (active) setError("Cannot reach the portal. Reload this page to try again."); }); };
    const signedOut = () => { queryClient.clear(); setSession(undefined); setPassword(""); setConfirmation(""); setToken(""); load(); };
    load();
    window.addEventListener("portal-signed-out", signedOut);
    return () => { active = false; window.removeEventListener("portal-signed-out", signedOut); };
  }, [queryClient]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    if (session.setupRequired && password !== confirmation) { setError("Passwords do not match."); return; }
    setBusy(true);
    setError("");
    try {
      const result = session.setupRequired ? await api.setupPortal(token.trim(), password) : await api.loginPortal(password);
      queryClient.clear();
      setPassword(""); setConfirmation(""); setToken("");
      setSession(result);
    } catch (error) { setError(error instanceof Error ? error.message : "Sign-in failed."); }
    finally { setBusy(false); }
  }

  if (session?.authenticated) return children;
  return <main className="flex min-h-screen items-center justify-center bg-ink px-4 py-12 text-zinc-100">
    <Card className="w-full max-w-md"><CardContent>
      <img src="/repairman.png" alt="" className="mb-5 h-16 w-16 rounded-xl" />
      <h1 className="text-2xl font-semibold">{session?.setupRequired ? "Set up Plex Repairman" : "Sign in to Plex Repairman"}</h1>
      {!session && !error && <p className="mt-4 text-sm text-zinc-400" role="status">Checking portal access…</p>}
      {session && <form onSubmit={(event) => void submit(event)} className="mt-5 space-y-5">
        {session.setupRequired && <>
          <p className="text-sm leading-6 text-zinc-400">Create the administrator password. Find your one-time setup token in <code>/config/portal-setup-token</code> using the container shell or your configuration dataset.</p>
          <div className="space-y-2"><Label htmlFor="setup-token">Setup token</Label><Input id="setup-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" required maxLength={128} /></div>
        </>}
        <div className="space-y-2"><Label htmlFor="portal-password">Administrator password</Label><Input id="portal-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={session.setupRequired ? "new-password" : "current-password"} required minLength={session.setupRequired ? 12 : 1} maxLength={256} /></div>
        {session.setupRequired && <div className="space-y-2"><Label htmlFor="confirm-password">Confirm password</Label><Input id="confirm-password" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" required minLength={12} maxLength={256} /><p className="text-xs text-zinc-500">Use at least 12 characters.</p></div>}
        <Button className="w-full" type="submit" disabled={busy}>{busy ? "Please wait…" : session.setupRequired ? "Create administrator account" : "Sign in"}</Button>
        {!session.setupRequired && <p className="text-xs leading-5 text-zinc-500">Lost your password? Follow the password recovery instructions in the project README. Recovery requires access to the configuration volume.</p>}
      </form>}
      {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
    </CardContent></Card>
  </main>;
}

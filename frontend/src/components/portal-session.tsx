import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { LockKeyhole, LogOut } from "lucide-react";
import { api, setPortalSession, type PortalSession } from "../lib/api";
import { Button, Input, Label } from "./ui";
import { ErrorState, LoadingState } from "./states";

const sessionKey = ["portal-session"];
const SessionContext = createContext<PortalSession>({ enabled: false, authenticated: false });

export function PortalSessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: sessionKey, queryFn: api.getPortalSession, retry: false, staleTime: 0,
    refetchInterval: () => document.visibilityState === "visible" ? 60_000 : false });
  function clearPrivateData() {
    void client.cancelQueries({ predicate: (item) => item.queryKey[0] !== "portal-session" });
    client.removeQueries({ predicate: (item) => item.queryKey[0] !== "portal-session" });
  }
  function accept(session: PortalSession) {
    void client.cancelQueries({ queryKey: sessionKey, exact: true });
    setPortalSession(session);
    client.setQueryData(sessionKey, session);
  }
  useEffect(() => {
    const expired = () => { clearPrivateData(); accept({ enabled: true, authenticated: false }); };
    const updated = (event: Event) => { accept((event as CustomEvent<PortalSession>).detail); };
    window.addEventListener("portal-session-expired", expired);
    window.addEventListener("portal-session-updated", updated);
    return () => { window.removeEventListener("portal-session-expired", expired); window.removeEventListener("portal-session-updated", updated); };
  }, [client]);
  useEffect(() => {
    if (query.data) setPortalSession(query.data);
    if (query.data?.enabled && !query.data.authenticated) clearPrivateData();
  }, [client, query.data]);
  if (query.isPending) return <AuthFrame><LoadingState label="Checking portal access" /></AuthFrame>;
  if (query.isError) return <AuthFrame><ErrorState error={query.error} retry={() => void query.refetch()} /></AuthFrame>;
  if (query.data.enabled && !query.data.authenticated) return <LoginForm onSuccess={(session) => { clearPrivateData(); accept(session); }} />;
  return <SessionContext.Provider value={query.data}>{children}</SessionContext.Provider>;
}

function AuthFrame({ children }: { children: ReactNode }) {
  return <main className="grid min-h-screen place-items-center bg-ink px-5 py-12 text-zinc-100"><div className="w-full max-w-md"><div className="mb-8 flex items-center gap-3"><img src="/repairman.png" alt="" className="h-12 w-12 rounded-xl" /><div><p className="font-semibold">Plex Repairman</p><p className="mt-1 text-sm text-zinc-500">Administration</p></div></div>{children}</div></main>;
}

export function LoginForm({ onSuccess }: { onSuccess: (session: PortalSession) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({ mutationFn: api.login, onSuccess: (session) => { setPassword(""); onSuccess(session); }, onError: () => setPassword("") });
  function submit(event: FormEvent) { event.preventDefault(); login.mutate({ username, password }); }
  return <AuthFrame><section className="rounded-2xl border border-line bg-panel p-6 shadow-2xl sm:p-8"><LockKeyhole className="mb-5 h-6 w-6 text-signal" /><h1 className="text-2xl font-semibold tracking-tight">Sign in</h1><form onSubmit={submit} className="mt-6 space-y-5">
    <div className="space-y-2"><Label htmlFor="login-username">Username</Label><Input id="login-username" name="username" autoComplete="username" autoFocus required maxLength={128} value={username} onChange={(event) => setUsername(event.target.value)} /></div>
    <div className="space-y-2"><Label htmlFor="login-password">Password</Label><Input id="login-password" name="password" type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} /></div>
    {login.error && <p role="alert" className="text-sm text-red-300">{login.error.message}</p>}
    <Button className="w-full" type="submit" disabled={login.isPending}>{login.isPending ? "Signing in…" : "Sign in"}</Button>
  </form></section></AuthFrame>;
}

export function PortalAccountMenu() {
  const session = useContext(SessionContext);
  const logout = useMutation({ mutationFn: api.logout, onSuccess: () => window.dispatchEvent(new Event("portal-session-expired")) });
  if (!session.authenticated) return null;
  return <div className="flex items-center gap-3"><span className="hidden text-xs text-zinc-500 sm:inline">{session.username}</span><Button variant="ghost" size="sm" disabled={logout.isPending} onClick={() => logout.mutate()}><LogOut className="h-4 w-4" />Sign out</Button>{logout.error && <span role="alert" className="text-xs text-red-300">{logout.error.message}</span>}</div>;
}

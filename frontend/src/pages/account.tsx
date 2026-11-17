import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { PageHeader } from "../components/layout";
import { Button, Card, CardContent, Input, Label } from "../components/ui";

export function AccountPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    if (newPassword !== confirmation) { setError("Passwords do not match."); return; }
    setBusy(true);
    try {
      await api.changePortalPassword(currentPassword, newPassword);
      setCurrentPassword(""); setNewPassword(""); setConfirmation("");
      setMessage("Password changed. All other portal sessions have been signed out.");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not change the password."); }
    finally { setBusy(false); }
  }
  return <><PageHeader eyebrow="Administration" title="Account" description="Manage the administrator password for this portal." />
    <Card className="max-w-lg"><CardContent><form onSubmit={(event) => void submit(event)} className="space-y-5">
      <div className="space-y-2"><Label htmlFor="current-password">Current password</Label><Input id="current-password" type="password" autoComplete="current-password" required maxLength={256} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></div>
      <div className="space-y-2"><Label htmlFor="new-password">New password</Label><Input id="new-password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></div>
      <div className="space-y-2"><Label htmlFor="confirm-new-password">Confirm new password</Label><Input id="confirm-new-password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div>
      <p className="text-sm text-zinc-500">Use at least 12 characters. Sessions expire after 12 hours and when the application restarts.</p>
      <Button type="submit" disabled={busy}>{busy ? "Updating…" : "Change password"}</Button>
      {message && <p role="status" className="text-sm text-signal">{message}</p>}
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    </form></CardContent></Card>
  </>;
}

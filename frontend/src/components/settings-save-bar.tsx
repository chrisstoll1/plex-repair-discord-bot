import { useEffect } from "react";
import { useBlocker } from "react-router-dom";
import { LoaderCircle, RotateCcw, Save } from "lucide-react";
import { Button, ConfirmDialog } from "./ui";

export function SettingsSaveBar({ dirty, saving, onReset }: { dirty: boolean; saving: boolean; onReset: () => void }) {
  const blocker = useBlocker(dirty);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return <><div className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-xl border border-line bg-[#11171c]/95 p-3 shadow-2xl backdrop-blur sm:flex-row sm:items-center sm:justify-between">
    <p className="px-1 text-xs text-zinc-500">{dirty ? <span className="text-amber-300">Unsaved configuration changes</span> : "All changes saved"}</p>
    <div className="flex gap-2"><Button type="button" variant="ghost" disabled={!dirty || saving} onClick={onReset}><RotateCcw className="h-4 w-4" />Reset</Button><Button type="submit" disabled={!dirty || saving}>{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save changes</Button></div>
  </div><ConfirmDialog open={blocker.state === "blocked"} onOpenChange={(open) => { if (!open && blocker.state === "blocked") blocker.reset(); }} title="Discard unsaved changes?" description="You have configuration changes that have not been saved. Leaving this view will discard them." confirmLabel="Discard and leave" destructive onConfirm={() => blocker.state === "blocked" && blocker.proceed()} /></>;
}

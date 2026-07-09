import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { cn } from "../lib/utils";

type Toast = { id: number; title: string; description?: string; tone: "success" | "error" | "info" };
type ToastInput = Omit<Toast, "id">;
const ToastContext = createContext<(toast: ToastInput) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((toast: ToastInput) => setToasts((current) => [...current, { ...toast, id: Date.now() + Math.random() }]), []);
  const remove = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  return <ToastContext.Provider value={push}>{children}<div className="fixed bottom-4 right-4 z-[80] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2" aria-live="polite">{toasts.map((toast) => <ToastItem key={toast.id} toast={toast} remove={remove} />)}</div></ToastContext.Provider>;
}

function ToastItem({ toast, remove }: { toast: Toast; remove: (id: number) => void }) {
  useEffect(() => { const timer = window.setTimeout(() => remove(toast.id), 4500); return () => clearTimeout(timer); }, [remove, toast.id]);
  const Icon = toast.tone === "success" ? CheckCircle2 : toast.tone === "error" ? CircleAlert : Info;
  return <div role={toast.tone === "error" ? "alert" : "status"} className={cn("flex gap-3 rounded-lg border bg-[#11171c] p-4 shadow-2xl", toast.tone === "error" ? "border-red-500/35" : toast.tone === "success" ? "border-signal/30" : "border-cyan/30")}><Icon className={cn("mt-0.5 h-5 w-5 shrink-0", toast.tone === "error" ? "text-red-400" : toast.tone === "success" ? "text-signal" : "text-cyan")} /><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-white">{toast.title}</p>{toast.description && <p className="mt-1 text-xs leading-5 text-zinc-400">{toast.description}</p>}</div><button onClick={() => remove(toast.id)} className="text-zinc-500 hover:text-white" aria-label="Dismiss notification"><X className="h-4 w-4" /></button></div>;
}

export const useToast = () => useContext(ToastContext);

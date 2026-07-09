import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import * as LabelPrimitive from "@radix-ui/react-label";
import { Slot } from "@radix-ui/react-slot";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { cn } from "../lib/utils";

const buttonVariants = cva("inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:pointer-events-none disabled:opacity-45", {
  variants: {
    variant: {
      primary: "bg-signal text-ink hover:bg-[#e1ff78]",
      secondary: "border border-line bg-[#131a20] text-zinc-100 hover:border-zinc-500 hover:bg-[#192229]",
      ghost: "text-zinc-400 hover:bg-white/5 hover:text-white",
      danger: "border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20",
    },
    size: { default: "h-10 px-4", sm: "h-8 px-3 text-xs", icon: "h-10 w-10 p-0" },
  },
  defaultVariants: { variant: "primary", size: "default" },
});

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { asChild?: boolean };
export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <section className={cn("rounded-xl border border-line bg-panel/90 shadow-glow", className)} {...props} />;
}
export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn("border-b border-line px-5 py-4", className)} {...props} />; }
export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn("p-5", className)} {...props} />; }
export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) { return <h2 className={cn("text-base font-semibold tracking-tight text-zinc-50", className)} {...props} />; }

export const Input = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => <input className={cn("h-10 w-full rounded-md border border-line bg-ink/70 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-signal/60 focus:ring-2 focus:ring-signal/10 disabled:opacity-50", className)} {...props} />;
export const Textarea = ({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className={cn("min-h-24 w-full resize-y rounded-md border border-line bg-ink/70 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-signal/60 focus:ring-2 focus:ring-signal/10", className)} {...props} />;
export const Label = ({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) => <LabelPrimitive.Root className={cn("text-sm font-medium text-zinc-200", className)} {...props} />;

export function Switch({ checked, onCheckedChange, "aria-label": ariaLabel }: { checked: boolean; onCheckedChange: (value: boolean) => void; "aria-label": string }) {
  return <SwitchPrimitive.Root checked={checked} onCheckedChange={onCheckedChange} aria-label={ariaLabel} className="relative h-6 w-11 rounded-full bg-zinc-700 transition data-[state=checked]:bg-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"><SwitchPrimitive.Thumb className="block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[22px] data-[state=checked]:bg-ink" /></SwitchPrimitive.Root>;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "good" | "warn" | "bad" | "neutral" | "info" }) {
  const tones = { good: "border-signal/30 bg-signal/10 text-signal", warn: "border-amber-400/30 bg-amber-400/10 text-amber-300", bad: "border-red-400/30 bg-red-400/10 text-red-300", neutral: "border-line bg-white/5 text-zinc-400", info: "border-cyan/30 bg-cyan/10 text-cyan" };
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider", tones[tone])}>{children}</span>;
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = "Confirm", onConfirm, destructive = false }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; confirmLabel?: string; onConfirm: () => void; destructive?: boolean }) {
  return <AlertDialog.Root open={open} onOpenChange={onOpenChange}><AlertDialog.Portal><AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm" /><AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-panel p-6 shadow-2xl"><AlertDialog.Title className="text-lg font-semibold text-white">{title}</AlertDialog.Title><AlertDialog.Description className="mt-2 text-sm leading-6 text-zinc-400">{description}</AlertDialog.Description><div className="mt-6 flex justify-end gap-3"><AlertDialog.Cancel asChild><Button variant="secondary">Cancel</Button></AlertDialog.Cancel><AlertDialog.Action asChild><Button variant={destructive ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button></AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>;
}

export function Drawer({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm md:hidden" /><Dialog.Content aria-describedby={undefined} className="fixed inset-y-0 left-0 z-50 w-[84vw] max-w-72 border-r border-line bg-ink p-4 shadow-2xl md:hidden"><Dialog.Title className="sr-only">Navigation</Dialog.Title>{children}<Dialog.Close asChild><Button variant="ghost" size="icon" className="absolute right-3 top-3" aria-label="Close navigation"><X className="h-5 w-5" /></Button></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>;
}

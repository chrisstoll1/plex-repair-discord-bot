import { Activity, Bot, BrainCircuit, Cable, Menu, PanelLeftClose, Wrench } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { cn } from "../lib/utils";
import { Button, Drawer } from "./ui";

const navigation = [
  { to: "/", label: "Overview", icon: Activity },
  { to: "/connections", label: "Connections", icon: Cable },
  { to: "/bot-settings", label: "Bot Settings", icon: Bot },
  { to: "/memory", label: "Memory", icon: BrainCircuit },
  { to: "/tasks", label: "Agent Tasks", icon: Wrench },
];

function Brand() {
  return <div className="flex items-center gap-3 px-2 py-2"><div className="grid h-9 w-9 place-items-center rounded-md border border-signal/25 bg-signal/10"><PanelLeftClose className="h-4 w-4 text-signal" /></div><div><p className="font-mono text-[10px] uppercase tracking-[.24em] text-zinc-500">Media ops</p><p className="text-sm font-bold tracking-tight text-white">PLEX / REPAIRMAN</p></div></div>;
}

function Navigation({ close }: { close?: () => void }) {
  return <nav className="mt-8 space-y-1" aria-label="Primary navigation">{navigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === "/"} onClick={close} className={({ isActive }) => cn("group flex items-center gap-3 rounded-md border border-transparent px-3 py-2.5 text-sm font-medium text-zinc-500 transition hover:bg-white/[.035] hover:text-zinc-200", isActive && "border-line bg-white/[.045] text-white before:-ml-3 before:h-5 before:w-0.5 before:bg-signal")}><Icon className="h-4 w-4 group-aria-[current=page]:text-signal" />{label}</NavLink>)}</nav>;
}

export function AppLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  return <div className="min-h-screen bg-ink text-zinc-100"><div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_80%_-20%,rgba(71,215,232,.08),transparent_35%),linear-gradient(rgba(255,255,255,.018)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.018)_1px,transparent_1px)] bg-[size:auto,40px_40px,40px_40px]" /><aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line bg-[#090d11]/95 px-4 py-5 backdrop-blur md:block"><Brand /><Navigation /><div className="absolute bottom-5 left-4 right-4 rounded-lg border border-amber-300/15 bg-amber-300/[.025] p-3"><div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-amber-200/70"><span className="h-1.5 w-1.5 rounded-full bg-signal shadow-[0_0_10px_#d5ff45]" />Trusted network only</div><p className="mt-1 text-xs leading-5 text-zinc-600">No built-in portal authentication</p></div></aside><Drawer open={drawerOpen} onOpenChange={setDrawerOpen}><Brand /><Navigation close={() => setDrawerOpen(false)} /><div className="mt-8 rounded-lg border border-amber-300/15 bg-amber-300/[.025] p-3 text-xs text-zinc-500">No built-in authentication. Use only on a trusted network.</div></Drawer><div className="relative md:pl-64"><header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-line bg-ink/85 px-4 backdrop-blur-xl sm:px-6 lg:px-10"><div className="flex items-center gap-3"><Button variant="ghost" size="icon" className="md:hidden" onClick={() => setDrawerOpen(true)} aria-label="Open navigation"><Menu className="h-5 w-5" /></Button><span className="font-mono text-[10px] uppercase tracking-[.2em] text-zinc-600">System / <span className="text-zinc-300">Live</span></span></div><div className="flex items-center gap-2 text-xs text-zinc-500"><span className="hidden sm:inline">Command surface</span><span className="h-4 w-px bg-line" /><span className="font-mono text-signal">ONLINE</span></div></header><main className="mx-auto max-w-[1440px] px-4 py-7 sm:px-6 lg:px-10 lg:py-10"><Outlet /></main></div></div>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: React.ReactNode }) {
  return <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="mb-2 font-mono text-[10px] uppercase tracking-[.24em] text-signal">{eyebrow}</p><h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">{description}</p></div>{actions && <div className="shrink-0">{actions}</div>}</div>;
}

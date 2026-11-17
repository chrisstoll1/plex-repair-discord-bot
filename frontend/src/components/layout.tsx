import { Activity, Bot, Cable, Menu, Stethoscope, Wrench } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { cn } from "../lib/utils";
import { Button, Drawer } from "./ui";

const navigation = [
  { to: "/", label: "Overview", icon: Activity },
  { to: "/connections", label: "Connections", icon: Cable },
  { to: "/bot-settings", label: "Bot Settings", icon: Bot },
  { to: "/tasks", label: "Agent Tasks", icon: Wrench },
  { to: "/repairs", label: "Ongoing Repairs", icon: Stethoscope },
];

const repositoryUrl = "https://github.com/chrisstoll1/plex-repair-discord-bot";
const appVersion = import.meta.env.VITE_APP_VERSION || "dev";

function Brand() {
  return <div className="flex items-center gap-3 px-2 py-2"><img src="/repairman.png" alt="" className="h-11 w-11 rounded-xl object-cover shadow-md" /><div><p className="text-sm font-semibold text-white">Plex Repairman</p><p className="text-xs text-zinc-500">Administration</p></div></div>;
}

function Navigation({ close }: { close?: () => void }) {
  return <nav className="mt-8 space-y-1" aria-label="Primary navigation">{navigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === "/"} onClick={close} className={({ isActive }) => cn("group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-zinc-400 transition hover:bg-white/[.04] hover:text-zinc-100", isActive && "bg-white/[.07] text-white")}><Icon className="h-4 w-4 group-aria-[current=page]:text-signal" />{label}</NavLink>)}</nav>;
}

export function VersionLink() {
  const label = appVersion === "dev" ? appVersion : `v${appVersion}`;
  return <a href={repositoryUrl} target="_blank" rel="noreferrer" className="rounded px-2 py-1 font-mono text-[11px] text-zinc-600 transition hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60">{label}</a>;
}

function Sidebar({ close }: { close?: () => void }) {
  return <div className="flex h-full flex-col"><Brand /><Navigation close={close} /><div className="mt-auto"><VersionLink /></div></div>;
}

export function AppLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  return <div className="min-h-screen bg-ink text-zinc-100"><aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line bg-[#141619]/95 px-4 py-5 md:block"><Sidebar /></aside><Drawer open={drawerOpen} onOpenChange={setDrawerOpen}><Sidebar close={() => setDrawerOpen(false)} /></Drawer><div className="relative md:pl-64"><header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-line bg-ink/90 px-4 backdrop-blur-xl sm:px-6 lg:px-10"><div className="flex items-center gap-3"><Button variant="ghost" size="icon" className="md:hidden" onClick={() => setDrawerOpen(true)} aria-label="Open navigation"><Menu className="h-5 w-5" /></Button><span className="text-sm text-zinc-400">Plex Repairman</span></div><div className="flex items-center gap-2 text-xs text-zinc-500"><span className="h-2 w-2 rounded-full bg-signal" /><span>Running</span></div></header><main className="mx-auto max-w-[1440px] px-4 py-7 sm:px-6 lg:px-10 lg:py-10"><Outlet /></main></div></div>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: React.ReactNode }) {
  return <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="mb-2 text-sm font-medium text-signal">{eyebrow}</p><h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">{description}</p></div>{actions && <div className="shrink-0">{actions}</div>}</div>;
}

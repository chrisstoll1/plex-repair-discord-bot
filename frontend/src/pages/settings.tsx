import { Bot, Cable, BrainCircuit, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { PageHeader } from "../components/layout";
import { SettingsEditor } from "../components/settings-editor";
import { PortalAuthSettings } from "../components/portal-auth-settings";
import { cn } from "../lib/utils";
import { PiAuthPanel } from "./connections";
export { ConnectionsPage } from "./connections";

export const settingsSections = [
  { path: "connections", label: "Connections", icon: Cable },
  { path: "discord", label: "Discord", icon: Bot },
  { path: "ai", label: "AI", icon: BrainCircuit },
  { path: "repair-policy", label: "Repair policy", icon: SlidersHorizontal },
  { path: "security", label: "Security", icon: ShieldCheck },
];

export function SettingsLayout() {
  const { pathname } = useLocation();
  const section = settingsSections.find((item) => pathname === `/settings/${item.path}`) ?? settingsSections[0]!;
  return <><PageHeader eyebrow="Settings" title={section.label} /><nav aria-label="Settings navigation" className="mb-6 flex flex-wrap gap-1 rounded-xl border border-line bg-panel p-1.5">{settingsSections.map(({ path, label, icon: Icon }) => <NavLink key={path} to={`/settings/${path}`} className={({ isActive }) => cn("flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-zinc-400 transition hover:bg-white/5 hover:text-white", isActive && "bg-white/[.08] text-white")}><Icon className="h-4 w-4" />{label}</NavLink>)}</nav><Outlet /></>;
}

export function DiscordSettingsPage() { return <SettingsEditor mode="discord" />; }
export function AiSettingsPage() { return <div className="space-y-5"><PiAuthPanel /><SettingsEditor mode="ai" /></div>; }
export function RepairPolicyPage() { return <SettingsEditor mode="repair" />; }
export function SecurityPage() { return <div className="max-w-4xl"><PortalAuthSettings /></div>; }

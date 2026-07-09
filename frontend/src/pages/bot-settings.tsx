import { PageHeader } from "../components/layout";
import { SettingsEditor } from "../components/settings-editor";

export function BotSettingsPage() { return <><PageHeader eyebrow="Runtime policy" title="Bot settings" description="Shape access, model behavior, memory retention, and repair safeguards." /><SettingsEditor mode="bot" /></>; }

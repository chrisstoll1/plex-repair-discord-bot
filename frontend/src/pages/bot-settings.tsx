import { PageHeader } from "../components/layout";
import { SettingsEditor } from "../components/settings-editor";

export function BotSettingsPage() { return <><PageHeader eyebrow="Configuration" title="Bot settings" description="Configure access, model behavior, timeouts, and repair safety." /><SettingsEditor mode="bot" /></>; }

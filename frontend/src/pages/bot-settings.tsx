import { PageHeader } from "../components/layout";
import { SettingsEditor } from "../components/settings-editor";
import { PortalAuthSettings } from "../components/portal-auth-settings";

export function BotSettingsPage() { return <><PageHeader eyebrow="Configuration" title="Bot settings" description="Configure access, model behavior, timeouts, and repair safety." /><PortalAuthSettings /><SettingsEditor mode="bot" /></>; }

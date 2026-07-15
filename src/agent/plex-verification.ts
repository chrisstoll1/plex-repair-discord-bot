export type PlexVerificationState = {
  followUpChecks: number;
  missingMedia: string[];
};

export function readPlexVerification(checkpoint: unknown): PlexVerificationState | undefined {
  if (!checkpoint || typeof checkpoint !== "object" || !("plexVerification" in checkpoint)) return undefined;
  const value = checkpoint.plexVerification;
  if (!value || typeof value !== "object") return undefined;
  const followUpChecks = "followUpChecks" in value && Number.isInteger(value.followUpChecks) && Number(value.followUpChecks) >= 0
    ? Number(value.followUpChecks)
    : 0;
  const missingMedia = "missingMedia" in value && Array.isArray(value.missingMedia)
    ? [...new Set(value.missingMedia.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()))]
    : [];
  return { followUpChecks, missingMedia };
}

export function advancePlexVerification(
  checkpoint: unknown,
  resume: { source: "webhook" | "timer" } | undefined,
  missingMedia: string[],
): { state: PlexVerificationState; exhausted: boolean } {
  const previous = readPlexVerification(checkpoint);
  const state = {
    followUpChecks: (previous?.followUpChecks ?? 0) + (resume?.source === "timer" ? 1 : 0),
    missingMedia: [...new Set(missingMedia.map((item) => item.trim()).filter(Boolean))],
  };
  return { state, exhausted: state.followUpChecks >= 2 };
}

export function plexVerificationBlockedMessage(state: PlexVerificationState): string {
  const missing = state.missingMedia.length > 0 ? ` Plex still cannot see: ${state.missingMedia.join(", ")}.` : "";
  return `Plex still hasn’t indexed the new files after two follow-up checks.${missing} The downloads are present, but the Plex library or server configuration now needs to be checked manually.`;
}

export function requireActivePlexScan(status: PlexLibrarySectionStatus): void {
  if (!status.refreshing) {
    throw new Error("Plex is not actively scanning this library. Verify the exact media once, then finish the repair instead of scheduling another indexing check.");
  }
}
import type { PlexLibrarySectionStatus } from "../services/plex-client.js";

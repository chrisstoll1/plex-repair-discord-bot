export type ToolProfile = "sonarr_agent" | "radarr_agent" | "plex_agent" | "media_readonly_agent";

const SONARR_READ_TOOLS = [
  "search_sonarr_series",
  "get_sonarr_series",
  "list_sonarr_root_folders",
  "get_sonarr_queue",
  "get_sonarr_queue_details",
  "get_sonarr_history",
  "get_sonarr_blocklist",
  "preview_sonarr_manual_import",
  "get_sonarr_episodes",
  "get_sonarr_episode_file",
  "preview_sonarr_rename",
  "get_sonarr_episode_releases",
] as const;

const RADARR_READ_TOOLS = [
  "search_radarr_movies",
  "get_radarr_movie",
  "list_radarr_root_folders",
  "get_radarr_queue",
  "get_radarr_queue_details",
  "get_radarr_history",
  "get_radarr_blocklist",
  "preview_radarr_manual_import",
  "get_radarr_movie_releases",
  "preview_radarr_rename",
  "get_radarr_movie_files",
  "get_radarr_movie_file",
] as const;

const PLEX_READ_TOOLS = ["search_all_media", "list_plex_libraries", "get_service_health"] as const;

export const TOOL_PROFILES: Record<ToolProfile, readonly string[]> = {
  sonarr_agent: SONARR_READ_TOOLS,
  radarr_agent: RADARR_READ_TOOLS,
  plex_agent: PLEX_READ_TOOLS,
  media_readonly_agent: [...SONARR_READ_TOOLS, ...RADARR_READ_TOOLS, ...PLEX_READ_TOOLS],
};

export function isToolProfile(value: string): value is ToolProfile {
  return Object.prototype.hasOwnProperty.call(TOOL_PROFILES, value);
}

export function toolProfileNames(): ToolProfile[] {
  return Object.keys(TOOL_PROFILES) as ToolProfile[];
}

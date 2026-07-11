export type ToolProfile =
  | "sonarr_agent"
  | "radarr_agent"
  | "plex_agent"
  | "sonarr_repair_agent"
  | "radarr_repair_agent"
  | "plex_repair_agent";

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

const PLEX_READ_TOOLS = ["search_all_media", "list_plex_libraries", "get_plex_metadata_children", "get_service_health"] as const;

const SONARR_WRITE_TOOLS = [
  "trigger_sonarr_series_search",
  "trigger_sonarr_season_search",
  "trigger_sonarr_episode_search",
  "grab_sonarr_release",
  "remove_sonarr_queue_item",
  "execute_sonarr_manual_import",
  "rename_sonarr_episode_files",
  "update_sonarr_series_settings",
  "set_sonarr_series_monitored",
  "set_sonarr_season_monitored",
  "delete_sonarr_episode_file",
  "remove_sonarr_series",
] as const;

const RADARR_WRITE_TOOLS = [
  "trigger_radarr_movie_search",
  "grab_radarr_release",
  "remove_radarr_queue_item",
  "execute_radarr_manual_import",
  "rename_radarr_movie_files",
  "update_radarr_movie_settings",
  "set_radarr_movie_monitored",
  "delete_radarr_movie_file",
  "remove_radarr_movie",
] as const;

const PLEX_WRITE_TOOLS = ["refresh_plex_library_section"] as const;

export const TOOL_PROFILES: Record<ToolProfile, readonly string[]> = {
  sonarr_agent: SONARR_READ_TOOLS,
  radarr_agent: RADARR_READ_TOOLS,
  plex_agent: PLEX_READ_TOOLS,
  sonarr_repair_agent: [...SONARR_READ_TOOLS, ...SONARR_WRITE_TOOLS],
  radarr_repair_agent: [...RADARR_READ_TOOLS, ...RADARR_WRITE_TOOLS],
  plex_repair_agent: [...PLEX_READ_TOOLS, ...PLEX_WRITE_TOOLS],
};

const REPAIR_PROFILES = new Set<ToolProfile>(["sonarr_repair_agent", "radarr_repair_agent", "plex_repair_agent"]);

export function isToolProfile(value: string): value is ToolProfile {
  return Object.prototype.hasOwnProperty.call(TOOL_PROFILES, value);
}

export function isRepairToolProfile(value: ToolProfile): boolean {
  return REPAIR_PROFILES.has(value);
}

export function toolProfileNames(): ToolProfile[] {
  return Object.keys(TOOL_PROFILES) as ToolProfile[];
}

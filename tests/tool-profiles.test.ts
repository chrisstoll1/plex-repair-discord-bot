import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_PROFILES, isRepairToolProfile, toolProfileNames } from "../src/agent/tool-profiles.js";

const WRITE_TOOLS = new Set([
  "trigger_radarr_movie_search",
  "refresh_plex_library_section",
  "trigger_sonarr_series_search",
  "trigger_sonarr_season_search",
  "trigger_sonarr_episode_search",
  "grab_radarr_release",
  "grab_sonarr_release",
  "remove_radarr_queue_item",
  "remove_sonarr_queue_item",
  "execute_radarr_manual_import",
  "execute_sonarr_manual_import",
  "rename_radarr_movie_files",
  "rename_sonarr_episode_files",
  "update_radarr_movie_settings",
  "update_sonarr_series_settings",
  "set_radarr_movie_monitored",
  "set_sonarr_series_monitored",
  "set_sonarr_season_monitored",
  "delete_sonarr_episode_file",
  "delete_radarr_movie_file",
  "remove_radarr_movie",
  "remove_sonarr_series",
]);

test("read-only profiles contain no repair tools", () => {
  for (const profile of ["sonarr_agent", "radarr_agent", "plex_agent", "media_readonly_agent"] as const) {
    assert.equal(TOOL_PROFILES[profile].some((tool) => WRITE_TOOLS.has(tool)), false, profile);
    assert.equal(isRepairToolProfile(profile), false);
  }
});

test("repair profiles expose every write tool once and remain service-scoped", () => {
  const repairProfiles = toolProfileNames().filter(isRepairToolProfile);
  assert.deepEqual(repairProfiles.sort(), ["plex_repair_agent", "radarr_repair_agent", "sonarr_repair_agent"]);

  const exposedWrites = repairProfiles.flatMap((profile) => TOOL_PROFILES[profile].filter((tool) => WRITE_TOOLS.has(tool)));
  assert.deepEqual(new Set(exposedWrites), WRITE_TOOLS);
  assert.equal(exposedWrites.length, WRITE_TOOLS.size);
  assert.equal(TOOL_PROFILES.sonarr_repair_agent.some((tool) => tool.includes("radarr")), false);
  assert.equal(TOOL_PROFILES.radarr_repair_agent.some((tool) => tool.includes("sonarr")), false);
  assert.deepEqual(TOOL_PROFILES.plex_repair_agent.filter((tool) => WRITE_TOOLS.has(tool)), ["refresh_plex_library_section"]);
});

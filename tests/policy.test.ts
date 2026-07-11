import assert from "node:assert/strict";
import test from "node:test";
import { authorizeRepair, canStartRepairWorker } from "../src/agent/policy.js";
import type { RuntimeSettings } from "../src/domain/settings.js";

test("repair workers require confirmation to be disabled and satisfy configured roles", () => {
  const settings = runtimeSettings();
  assert.equal(canStartRepairWorker(settings, { roles: [] }), true);

  settings.discord.repairRoleIds = "repair-role";
  assert.equal(canStartRepairWorker(settings, { roles: [] }), false);
  assert.equal(canStartRepairWorker(settings, { roles: ["repair-role"] }), true);

  settings.repair.requireConfirmation = true;
  assert.equal(canStartRepairWorker(settings, { roles: ["repair-role"] }), false);
});

test("model-supplied confirmation cannot bypass confirmation policy", () => {
  const settings = runtimeSettings();
  settings.repair.requireConfirmation = true;
  const result = authorizeRepair(settings, { roles: [] }, { action: "refresh", confirmed: true });
  assert.equal((result?.details as { confirmationRequired?: boolean }).confirmationRequired, true);
});

test("destructive actions require destructive repairs to be enabled", () => {
  const settings = runtimeSettings();
  settings.repair.allowDestructive = false;
  const blocked = authorizeRepair(settings, { roles: [] }, { action: "delete", destructive: true });
  assert.equal((blocked?.details as { blocked?: boolean }).blocked, true);

  settings.repair.allowDestructive = true;
  assert.equal(authorizeRepair(settings, { roles: [] }, { action: "delete", destructive: true }), undefined);
});

function runtimeSettings(): RuntimeSettings {
  return {
    discord: {
      token: "",
      applicationId: "",
      allowedGuildIds: "",
      allowedChannelIds: "",
      repairRoleIds: "",
      allowDirectMessages: false,
      reactionsEnabled: true,
    },
    sonarr: { url: "", apiKey: "" },
    radarr: { url: "", apiKey: "" },
    plex: { url: "", token: "" },
    ai: { provider: "openai-codex", modelProvider: "openai-codex", modelId: "", thinkingLevel: "medium" },
    timeouts: { standardSeconds: 60, releaseLookupSeconds: 300 },
    repair: { requireConfirmation: false, allowDestructive: true },
  };
}

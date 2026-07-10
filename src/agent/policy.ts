import { csvToSet, type RuntimeSettings } from "../domain/settings.js";

export type RepairContext = {
  roles: string[];
};

export type RepairAuthorizationOptions = {
  action: string;
  confirmed?: boolean;
  destructive?: boolean;
};

export function authorizeRepair(settings: RuntimeSettings, context: RepairContext, options: RepairAuthorizationOptions) {
  const repairRoles = csvToSet(settings.discord.repairRoleIds);
  if (repairRoles.size > 0 && !context.roles.some((role) => repairRoles.has(role))) {
    return toolResponse({ blocked: true, reason: "User does not have an allowed repair role", action: options.action });
  }

  if (options.destructive && !settings.repair.allowDestructive) {
    return toolResponse({ blocked: true, reason: "Destructive repair actions are disabled by policy", action: options.action });
  }

  if (settings.repair.requireConfirmation) {
    return toolResponse({ confirmationRequired: true, action: options.action, reason: "Confirmed repair execution is not enabled yet" });
  }

  return undefined;
}

export function canStartRepairWorker(settings: RuntimeSettings, context: RepairContext): boolean {
  if (settings.repair.requireConfirmation) return false;
  const repairRoles = csvToSet(settings.discord.repairRoleIds);
  return repairRoles.size === 0 || context.roles.some((role) => repairRoles.has(role));
}

function toolResponse(results: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(results).slice(0, 12000) }],
    details: results,
  };
}

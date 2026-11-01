export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

/** Only classify explicit model rejection; auth, quota and transport errors differ. */
export function isModelUnavailableMessage(message: string): boolean {
  if (/\b(?:model_not_found|model_not_supported|unsupported_model|model_not_available|model_access_denied|invalid_model)\b/i.test(message)) return true;
  if (/\bmodel (?:server|service|provider|endpoint)\b/i.test(message)) return false;
  return /\bmodel(?:\s+['"`]?[-\w.:/]+['"`]?)?\s+(?:(?:is|was)\s+)?(?:not (?:found|available|supported)|unavailable|does not exist|no longer (?:available|supported)|has been (?:retired|removed))\b/i.test(message)
    || /\b(?:do not|don't|does not) have access to (?:the |this )?model\b/i.test(message)
    || /\b(?:unsupported|unknown|invalid) model\b/i.test(message);
}

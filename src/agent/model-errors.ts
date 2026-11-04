export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

export class AiAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiAuthenticationError";
  }
}

/** Match explicit credential failures, not quota, access policy or transport errors. */
export function isAiAuthenticationMessage(message: string): boolean {
  return /\b(?:token_expired|invalid_api_key|invalid_access_token|invalid_refresh_token|refresh_token_expired|refresh_token_reused|authentication_error)\b/i.test(message)
    || /\b(?:authentication|access|refresh|oauth) token\b[^.\n]{0,80}\b(?:expired|invalid|revoked)\b/i.test(message)
    || /\b(?:expired|invalid|revoked)\s+(?:(?:authentication|access|refresh|oauth)\s+)?token\b/i.test(message)
    || /\b(?:incorrect|invalid|missing)\s+api[ _-]?key\b/i.test(message);
}

/** Pi may either throw a request error or return it on an assistant message. */
export function classifyAiRequestError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof AiAuthenticationError || error instanceof ModelUnavailableError) return error;
  if (isAiAuthenticationMessage(error.message)) return new AiAuthenticationError(error.message);
  if (isModelUnavailableMessage(error.message)) return new ModelUnavailableError(error.message);
  return error;
}

/** Only classify explicit model rejection; auth, quota and transport errors differ. */
export function isModelUnavailableMessage(message: string): boolean {
  if (/\b(?:model_not_found|model_not_supported|unsupported_model|model_not_available|model_access_denied|invalid_model)\b/i.test(message)) return true;
  if (/\bmodel (?:server|service|provider|endpoint)\b/i.test(message)) return false;
  return /\bmodel(?:\s+['"`]?[-\w.:/]+['"`]?)?\s+(?:(?:is|was)\s+)?(?:not (?:found|available|supported)|unavailable|does not exist|no longer (?:available|supported)|has been (?:retired|removed))\b/i.test(message)
    || /\b(?:do not|don't|does not) have access to (?:the |this )?model\b/i.test(message)
    || /\b(?:unsupported|unknown|invalid) model\b/i.test(message);
}

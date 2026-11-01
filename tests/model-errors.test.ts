import assert from "node:assert/strict";
import test from "node:test";
import { isModelUnavailableMessage } from "../src/agent/model-errors.js";

test("recognizes explicit unavailable, unsupported and inaccessible models", () => {
  for (const message of [
    '{"error":{"code":"model_not_found","message":"Model rejected"}}',
    "The model `gpt-5.5` does not exist or you do not have access to it.",
    "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
    "Model gpt-5.5 is not available.",
    "Model gpt-5.5 has been retired.",
    "You do not have access to this model.",
    "Unsupported model: gpt-5.5",
  ]) assert.equal(isModelUnavailableMessage(message), true, message);
});

test("does not mislabel authentication, quota, network or request-option failures", () => {
  for (const message of [
    "401 Unauthorized: OAuth token expired",
    "Usage limit reached for model gpt-5.5",
    "429 Too many requests",
    "503 Service unavailable",
    "The model server is unavailable",
    "The model is temporarily unavailable",
    "fetch failed",
    "Unsupported parameter: service_tier",
    "This model does not support reasoning effort minimal",
    "Agent session completed without a response or lifecycle decision",
  ]) assert.equal(isModelUnavailableMessage(message), false, message);
});

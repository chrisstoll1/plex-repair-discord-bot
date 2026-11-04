import assert from "node:assert/strict";
import test from "node:test";
import { AiAuthenticationError, classifyAiRequestError, isAiAuthenticationMessage, isModelUnavailableMessage, ModelUnavailableError } from "../src/agent/model-errors.js";

test("recognizes explicit expired and invalid AI credentials", () => {
  for (const message of [
    "Your authentication token has expired. Please try refreshing it.",
    "401 Unauthorized: OAuth token expired",
    "The access token is invalid",
    "Invalid refresh token",
    "The refresh token has been revoked",
    '{"error":{"code":"refresh_token_reused"}}',
    '{"error":{"code":"invalid_api_key"}}',
    "Incorrect API key provided",
  ]) {
    assert.equal(isAiAuthenticationMessage(message), true, message);
    const error = new Error(message);
    const failure = classifyAiRequestError(error);
    assert.ok(failure instanceof AiAuthenticationError);
    assert.equal(failure.message, message);
    assert.equal(classifyAiRequestError(failure), failure);
  }
});

test("does not mislabel unrelated provider failures as authentication problems", () => {
  for (const message of [
    "Usage limit reached",
    "Maximum token limit exceeded",
    "The request expired",
    "401 Unauthorized",
    "403 Forbidden: access denied by policy",
    "503 Service unavailable",
    "fetch failed",
    "The model is temporarily unavailable",
    "Unsupported parameter: service_tier",
  ]) {
    assert.equal(isAiAuthenticationMessage(message), false, message);
    const error = new Error(message);
    assert.equal(classifyAiRequestError(error), error);
  }
  const modelError = classifyAiRequestError(new Error("Model gpt-example is not available."));
  assert.ok(modelError instanceof ModelUnavailableError);
  assert.equal(classifyAiRequestError(modelError), modelError);
  assert.equal(classifyAiRequestError(undefined), undefined);
});

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

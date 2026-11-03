import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { piAiPackageDir } from "../../scripts/pi-ai-package.mjs";

const dist = path.join(piAiPackageDir, "dist");
const { stream } = await import(pathToFileURL(path.join(dist, "api/openai-codex-responses.js")).href);
let oversized = true;
const server = http.createServer((request, response) => {
  request.resume();
  if (request.url === "/health") { response.end("ok"); return; }
  response.setHeader("Content-Type", "text/event-stream");
  const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const item = { type: "function_call", id: "fc_test", call_id: "call_test", name: "finish_repair_case", arguments: "" };
  send({ type: "response.output_item.added", output_index: 0, item });
  const chunks = oversized
    // Production emitted a normal prefix missing its closing brace, followed by
    // 1.5M+ whitespace characters in mostly 128-character deltas.
    ? ['{"status":"blocked","checkpoint":"Diagnosis complete."', ...Array(16_384).fill(" ".repeat(128))]
    : ['{"status":"blocked",', '"userUpdate":"No usable release was found.",', '"checkpoint":"Diagnosis complete."}'];
  for (const delta of chunks) send({ type: "response.function_call_arguments.delta", output_index: 0, delta });
  const args = chunks.join("") + (oversized ? "}" : "");
  send({ type: "response.function_call_arguments.done", output_index: 0, arguments: args });
  send({ type: "response.output_item.done", output_index: 0, item: { ...item, arguments: args } });
  send({ type: "response.completed", response: { id: "resp_test", status: "completed", output: [] } });
  response.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const model = {
  id: "test", name: "Test", api: "openai-codex-responses", provider: "openai-codex", baseUrl,
  reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
// Synthetic test credential accepted only by this local fake endpoint.
const apiKey = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.test`;
try {
  let timerFired = false;
  const timer = new Promise((resolve) => setTimeout(() => { timerFired = true; resolve(); }, 25));
  const result = await stream(model, { messages: [] }, { apiKey, transport: "sse" }).result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /Tool call arguments exceeded the 65536 character safety limit/);
  oversized = false;
  const normal = await stream(model, { messages: [] }, { apiKey, transport: "sse" }).result();
  assert.equal(normal.stopReason, "toolUse");
  assert.deepEqual(normal.content[0].arguments, { status: "blocked", userUpdate: "No usable release was found.", checkpoint: "Diagnosis complete." });
  const health = await fetch(`${baseUrl}/health`);
  await timer;
  console.log(JSON.stringify({ failure: result, oversized: result.stopReason, normal: normal.stopReason, health: health.status, timerFired }));
} finally {
  server.closeAllConnections();
  server.close();
}

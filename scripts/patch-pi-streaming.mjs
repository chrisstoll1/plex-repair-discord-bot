import fs from "node:fs";
import path from "node:path";
import { piAiPackageDir } from "./pi-ai-package.mjs";

// Temporary, version-checked mitigation for https://github.com/earendil-works/pi/issues/9265.
// A runaway finish_repair_case call grew past 1.49M characters in production;
// reparsing every 128-character delta starved health checks and cancellation.
// Revisit this patch when upgrading Pi. Do not silently ship an unpatched SDK.
const manifest = JSON.parse(fs.readFileSync(path.join(piAiPackageDir, "package.json"), "utf8"));
if (manifest.version !== "0.80.7") {
  throw new Error(`Review the streaming safety patch before upgrading pi-ai (${manifest.version})`);
}

const guard = `// Plex Repairman: bound provider-controlled work before any JSON parsing/repair.
export function assertToolCallArgumentSize(length) {
    if (length > 65536) {
        throw new Error("Tool call arguments exceeded the 65536 character safety limit");
    }
}
`;

const patches = [
  {
    file: "utils/json-parse.js",
    replacements: [
      ["export function parseStreamingJson(partialJson) {", `${guard}export function parseStreamingJson(partialJson) {
    assertToolCallArgumentSize(partialJson?.length ?? 0);`],
    ],
  },
  {
    file: "api/openai-responses-shared.js",
    replacements: [
      ['import { parseStreamingJson } from "../utils/json-parse.js";', 'import { assertToolCallArgumentSize, parseStreamingJson } from "../utils/json-parse.js";'],
      ['        if (item.type === "function_call") {', `        if (item.type === "function_call") {
            assertToolCallArgumentSize((item.arguments || "").length);`],
      [`            slot.block.partialJson += event.delta;
            slot.block.arguments = parseStreamingJson(slot.block.partialJson);`, `            assertToolCallArgumentSize(slot.block.partialJson.length + event.delta.length);
            slot.block.partialJson += event.delta;
            // Repairman consumes arguments only after toolcall_end. Parsing every
            // growing prefix is quadratic and can prevent even abort timers firing.`],
    ],
  },
];

// Validate every replacement before writing either file. Repeated installs are safe.
const updates = patches.map(({ file, replacements }) => {
  const target = path.join(piAiPackageDir, "dist", file);
  let source = fs.readFileSync(target, "utf8");
  for (const [before, after] of replacements) {
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2) {
      throw new Error(`Unexpected pi-ai source in ${file}; streaming safety patch was not applied`);
    }
    source = source.replace(before, after);
  }
  return { target, source };
});
for (const { target, source } of updates) fs.writeFileSync(target, source);
console.log("Applied Pi streaming argument safety patch (pi-ai 0.80.7)");

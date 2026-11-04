import fs from "node:fs";
import path from "node:path";
import { piAiPackageDir } from "./pi-ai-package.mjs";

// Pi now parses streaming JSON incrementally (upstream issue #9265). Keep our
// application argument-size limit, checking the SDK's source structure rather
// than pinning a version. Unknown layouts fail installation; regression tests
// exercise the real Codex stream before an SDK update can auto-merge.
const manifest = JSON.parse(fs.readFileSync(path.join(piAiPackageDir, "package.json"), "utf8"));

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
      ["export function parseToolCallArguments(json) {", "export function parseToolCallArguments(json) {\n    assertToolCallArgumentSize(json?.length ?? 0);"],
      ["export function parseStreamingJson(partialJson) {", `${guard}export function parseStreamingJson(partialJson) {
    assertToolCallArgumentSize(partialJson?.length ?? 0);`],
    ],
  },
  {
    file: "utils/streaming-json.js",
    replacements: [
      ['import { parseToolCallArguments } from "./json-parse.js";', 'import { assertToolCallArgumentSize, parseToolCallArguments } from "./json-parse.js";'],
      ["    append(delta) {\n        this.#text += delta;", "    append(delta) {\n        assertToolCallArgumentSize(this.#text.length + delta.length);\n        this.#text += delta;"],
      ["    replace(text) {", "    replace(text) {\n        assertToolCallArgumentSize(text.length);"],
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
console.log(`Applied Pi streaming argument safety patch (pi-ai ${manifest.version})`);

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// pi-coding-agent bundles its own pi-ai; patch/test that copy, not an unrelated
// top-level installation. resolve.paths also supports a future hoisted layout.
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
export const piAiPackageDir = piRequire.resolve.paths("@earendil-works/pi-ai")
  .map((base) => path.join(base, "@earendil-works/pi-ai"))
  .find((candidate) => fs.existsSync(path.join(candidate, "package.json")));
if (!piAiPackageDir) throw new Error("Cannot locate pi-coding-agent's pi-ai dependency");

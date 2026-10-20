/**
 * Copy the skill into the plugin folder.
 *
 * The skill is written once, in skills/antideploy, because that is where the
 * open skills installer, the npm package and the docs site look for it. The
 * plugin folder has to be self-contained (a plugin is installed from its own
 * folder, and symbolic links are refused by Anthropic's directory), so it
 * carries a copy. test/packaging.test.mjs fails if the copy differs.
 *
 * Run: node scripts/sync-plugin.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const from = path.join(root, "skills", "antideploy");
const to = path.join(root, "plugin", "skills", "antideploy");

fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
console.log("copied", path.relative(root, from), "to", path.relative(root, to));

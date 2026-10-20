/**
 * Make the single-file skill the docs site serves.
 *
 * Mintlify serves one `skill.md` from the docs repository root (at
 * antideploy.com/docs/skill.md and in the agent-skills discovery index) and
 * replaces the one it would otherwise write itself from the docs. That file
 * cannot have side files, so this joins the skill in skills/antideploy with the
 * two reference files it points to. The skill stays written once.
 *
 * Usage: node scripts/build-docs-skill.mjs [output file]
 *        default output: ../antideploy-mintlify/skill.md, next to this repository
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

/** The text of the single-file skill. Exported so the test can compare it with the published copy. */
export function docsSkill() {
  const skill = read("skills/antideploy/SKILL.md");
  const troubleshooting = read("skills/antideploy/references/troubleshooting.md").replace(/^# .*\n+/, "");
  const examples = read("skills/antideploy/references/examples.md").replace(/^# .*\n+/, "");
  const demote = (text) => text.replace(/^(#{2,5}) /gm, "$1# ");

  const refsLine = "Details and the usual causes: `references/troubleshooting.md`.";
  const moreLine = "More: `references/examples.md`. The machine-readable contract is one unauthenticated GET at https://antideploy.com/api/v1.";
  if (!skill.includes(refsLine) || !skill.includes(moreLine)) {
    throw new Error("SKILL.md no longer has the lines that point to its references; update this script.");
  }

  const body = skill
    .replace(refsLine, "The usual causes are in Troubleshooting below.")
    .replace(moreLine, "Examples are below. The machine-readable contract is one unauthenticated GET at https://antideploy.com/api/v1.");

  return (
    body.trimEnd() +
    "\n\n## Troubleshooting\n\n" +
    demote(troubleshooting).trim() +
    "\n\n## Examples\n\n" +
    demote(examples).trim() +
    "\n"
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = path.resolve(process.argv[2] || path.join(root, "..", "antideploymintlify", "skill.md"));
  fs.writeFileSync(out, docsSkill());
  console.log("wrote", out);
}

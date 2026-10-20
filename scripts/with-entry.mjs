/**
 * Run a command with ANTIDEPLOY_ENTRY set, so the same end-to-end suite can be
 * pointed at the bundle instead of the source.
 * Usage: node scripts/with-entry.mjs <entry> -- <command> [args...]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const [entry, sep, ...command] = process.argv.slice(2);
if (!entry || sep !== "--" || command.length === 0) {
  console.error("usage: node scripts/with-entry.mjs <entry> -- <command> [args...]");
  process.exit(2);
}
const result = spawnSync(command[0], command.slice(1), {
  stdio: "inherit",
  env: { ...process.env, ANTIDEPLOY_ENTRY: path.resolve(entry) },
});
process.exit(result.status ?? 1);

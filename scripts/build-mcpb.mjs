/**
 * Build an MCP bundle (.mcpb) of the connector, the form Smithery takes for a
 * server that runs on the person's own machine.
 *
 *   npm run build && node scripts/build-mcpb.mjs
 *
 * The bundle holds mcpb/manifest.json, the one-file server, and the logo. It
 * declares no settings: a person signs in with the login tool, and an optional
 * setting that is left empty could reach the server as a literal placeholder
 * rather than as nothing. The manifest's version must be the package's, which the
 * packaging test checks.
 *
 * Output: dist/antideploy.mcpb (not committed).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "dist", "antideploy-mcp.mjs");
if (!fs.existsSync(bundle)) {
  console.error("Run npm run build first: dist/antideploy-mcp.mjs is missing.");
  process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "adbundle-"));
fs.mkdirSync(path.join(work, "server"));
fs.copyFileSync(path.join(root, "mcpb", "manifest.json"), path.join(work, "manifest.json"));
fs.copyFileSync(bundle, path.join(work, "server", "index.mjs"));
fs.copyFileSync(path.join(root, "plugin", "logo.png"), path.join(work, "icon.png"));

const out = path.join(root, "dist", "antideploy.mcpb");
// A path with a space in it (a Windows profile folder, say) is split by the shell unless it is quoted.
const quote = (p) => JSON.stringify(p);
const result = spawnSync("npx", ["-y", "@anthropic-ai/mcpb", "pack", quote(work), quote(out)], { stdio: "inherit", shell: true });
fs.rmSync(work, { recursive: true, force: true });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log("wrote", out);

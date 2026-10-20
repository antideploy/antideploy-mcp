/**
 * Bundle the server and everything it imports into one file.
 *
 * Why: an agent starts this package with `npx -y antideploy-mcp`, and with its
 * dependencies (the MCP SDK alone pulls in about a hundred packages) a first
 * start on a clean machine took 14.7 s to answer, measured on 20 Oct 2026. Codex
 * waits 10 s for an MCP server by default and Claude Code waited 30 s before
 * giving up on it in the same test, so the first launch looked like a broken
 * server. One file has nothing to resolve.
 *
 * Run: npm run build. The published package ships dist/ and no dependencies.
 */

import { build } from "esbuild";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));

fs.rmSync(new URL("./dist", import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: ["index.js"], // its #! line is kept at the top of the output
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: "dist/antideploy-mcp.mjs",
  // Some dependencies still call require() for Node's own modules.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  define: { __ANTIDEPLOY_MCP_VERSION__: JSON.stringify(pkg.version) },
  legalComments: "none",
  logLevel: "info",
});

fs.chmodSync(new URL("./dist/antideploy-mcp.mjs", import.meta.url), 0o755);

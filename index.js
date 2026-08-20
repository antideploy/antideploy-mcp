#!/usr/bin/env node
/**
 * antideploy-mcp — deploying to Antideploy from inside a coding agent.
 *
 * This runs on the developer's machine, not on ours, and that is forced rather
 * than chosen: deploying means sending the project directory, and a server
 * hosted by us cannot read a directory sitting on somebody's laptop. So the
 * transport is stdio and the agent launches this process itself.
 *
 * Everything here is a thin shell over the HTTP API at /api/v1, which already
 * describes itself. Nothing is reimplemented; the value is that an agent can
 * call a tool with typed arguments instead of composing a multipart upload and
 * guessing at field names.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as tar from "tar";
import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.ANTIDEPLOY_URL || "https://antideploy.com").replace(/\/+$/, "");
const KEY = process.env.ANTIDEPLOY_API_KEY;

/**
 * Directories that never belong in a build context.
 *
 * Mirrored from the platform's own upload filter. The server strips these
 * anyway, so the only thing sending them achieves is a slower upload and a
 * file count closer to the ceiling — but keeping the lists identical also
 * means the count reported here is the count that will actually be built.
 */
const SKIP_SEGMENTS = new Set([
  "node_modules", ".git", ".next", ".nuxt", ".svelte-kit", "dist", "build",
  "out", "coverage", "vendor", "__pycache__", ".pytest_cache", ".mypy_cache",
  ".ruff_cache", ".venv", "venv", "env", ".turbo", ".cache", ".parcel-cache",
  "target", ".gradle", ".idea", ".vscode", ".terraform",
]);

const SKIP_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** The same ceilings the API enforces, checked here so a failure costs no upload. */
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 28 * 1024 * 1024;

/**
 * Private keys and certificates, which the platform strips regardless.
 *
 * A `.env` is deliberately NOT excluded here. The platform reads it on the way
 * past and moves the values into its encrypted secret store before dropping the
 * file from the build context — so filtering it client-side would quietly cost
 * the user every variable they already had on disk, and the app would deploy
 * successfully and then crash looking for them.
 */
const isKeyFile = (name) =>
  /\.(pem|key|p12|pfx|keystore|jks)$/.test(name) || name === "id_rsa";

function skip(rel) {
  const parts = rel.split("/");
  if (parts.some((p) => SKIP_SEGMENTS.has(p))) return true;
  const name = parts[parts.length - 1];
  return SKIP_FILES.has(name) || isKeyFile(name);
}

/** Every file under `dir`, as paths relative to it, in POSIX form. */
function walk(dir) {
  const found = [];
  const visit = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // an unreadable directory is not worth failing a deploy over
    }
    for (const entry of entries) {
      const childRel = rel ? rel + "/" + entry.name : entry.name;
      if (skip(childRel)) continue;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) visit(childAbs, childRel);
      else if (entry.isFile()) found.push(childRel);
    }
  };
  visit(dir, "");
  return found;
}

async function packDirectory(dir) {
  const files = walk(dir);
  if (files.length === 0) throw new Error("No files to deploy in " + dir + ".");
  if (files.length > MAX_FILES) {
    throw new Error(
      files.length + " files, and the limit is " + MAX_FILES + ". Deploy a " +
        "subdirectory, or move build output into one of the ignored directories.",
    );
  }

  let total = 0;
  for (const rel of files) {
    const { size } = fs.statSync(path.join(dir, rel));
    if (size > MAX_FILE_BYTES) {
      throw new Error(
        rel + " is " + (size / 1048576).toFixed(1) + " MB; the per-file limit is 5 MB.",
      );
    }
    total += size;
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new Error(
      (total / 1048576).toFixed(1) + " MB in total; the limit is 28 MB, because " +
        "Cloud Run rejects larger request bodies before they reach the platform.",
    );
  }

  const chunks = [];
  // `portable` drops uid, gid and mtime noise, so an unchanged tree packs to an
  // identical archive — which is what lets the API answer "unchanged" rather
  // than rebuilding something byte-for-byte the same.
  for await (const chunk of tar.c({ gzip: true, cwd: dir, portable: true }, files)) {
    chunks.push(chunk);
  }
  return { archive: Buffer.concat(chunks), fileCount: files.length, totalBytes: total };
}

async function api(pathname, init = {}) {
  if (!KEY) {
    throw new Error(
      "ANTIDEPLOY_API_KEY is not set. Create a key for the application in the " +
        "Antideploy dashboard and set it in this server's environment. Keys are " +
        "scoped to one application, so the key is what says which app to deploy.",
    );
  }
  const response = await fetch(BASE + pathname, {
    ...init,
    headers: { authorization: "Bearer " + KEY, ...(init.headers || {}) },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 800) };
  }
  if (!response.ok) {
    const detail = body.error || body.code || response.statusText;
    throw new Error(response.status + " from " + pathname + ": " + detail);
  }
  return body;
}

const asText = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

const server = new McpServer(
  { name: "antideploy", version: "0.1.0" },
  {
    instructions:
      "Deploy applications to Antideploy. The API key identifies the application, " +
      "so an application id is never passed. Deploys are asynchronous: `deploy` " +
      "returns a taskId, and `deployment_status` reports progress until the status " +
      "is succeeded or failed. Warnings and hazards in that response are structured " +
      "data meant to be relayed to the user, not decoration.",
  },
);

server.registerTool(
  "deploy",
  {
    title: "Deploy the project",
    description:
      "Package a project directory and deploy it. Sends the whole directory, not " +
      "just an entry point — a deploy containing one file builds successfully and " +
      "then serves a page whose assets all 404. Returns a taskId to poll with " +
      "`deployment_status`. A `.env` in the directory is uploaded on purpose: the " +
      "values go into the encrypted secret store and the file itself is dropped " +
      "from the build. Say so if the user may not expect it.",
    inputSchema: {
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to the working directory of this server."),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe("Variables to store with this deploy. Write-only; never readable back."),
      force: z
        .boolean()
        .optional()
        .describe("Rebuild even when the content is byte-for-byte identical to the last deploy."),
    },
  },
  async ({ directory, env, force }) => {
    const dir = path.resolve(directory || process.cwd());
    if (!fs.existsSync(dir)) throw new Error("No such directory: " + dir);

    const { archive, fileCount, totalBytes } = await packDirectory(dir);

    const form = new FormData();
    form.append("archive", new Blob([archive]), "project.tar.gz");
    if (env) form.append("env", JSON.stringify(env));
    if (force) form.append("force", "true");

    const body = await api("/api/v1/deploy", { method: "POST", body: form });
    return asText({ directory: dir, fileCount, uploadedBytes: totalBytes, ...body });
  },
);

server.registerTool(
  "deployment_status",
  {
    title: "Check a deployment",
    description:
      "Progress for one deployment: status, per-step detail, the analyzed spec, " +
      "warnings and hazards. Poll until the status is succeeded or failed.",
    inputSchema: { taskId: z.string().describe("The taskId returned by `deploy`.") },
  },
  async ({ taskId }) => asText(await api("/api/v1/deployments/" + encodeURIComponent(taskId))),
);

server.registerTool(
  "list_env",
  {
    title: "List environment variable names",
    description: "Names only. The platform never returns values, by design.",
    inputSchema: {},
  },
  async () => asText(await api("/api/v1/secrets")),
);

server.registerTool(
  "set_env",
  {
    title: "Set environment variables",
    description: "Store or replace environment variables for this application. Write-only.",
    inputSchema: {
      env: z.record(z.string(), z.string()).describe("Variables to store, as name/value pairs."),
    },
  },
  async ({ env }) =>
    asText(
      await api("/api/v1/secrets", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ env }),
      }),
    ),
);

server.registerTool(
  "api_info",
  {
    title: "Read the API's own manual",
    description:
      "The platform's self-description: endpoints, limits and current behaviour. " +
      "Worth reading whenever something here disagrees with what the server does.",
    inputSchema: {},
  },
  async () => {
    const response = await fetch(BASE + "/api/v1", { headers: { accept: "application/json" } });
    return asText(await response.json());
  },
);

await server.connect(new StdioServerTransport());

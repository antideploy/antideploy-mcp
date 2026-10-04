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
import os from "node:os";
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
      "data meant to be relayed to the user, not decoration. While a project is still being " +
      "written, `database_create` gives it its Postgres now and `database_env_to_file` puts the " +
      "connection in .env without printing it, so it is built against the real database and the " +
      "deploy later reuses it; do not send the user to sign up for another, and do not push " +
      "DATABASE_URL through `set_env`. Once something is live, the " +
      "other tools run it: `logs`, `health`, `metrics` and `deployment_history` to see what " +
      "happened, `redeploy` after changing a variable, `rollback` to undo a bad release, " +
      "`add_schedule` for jobs, and `update_app_settings` for the address and deploy-on-push.",
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

/* ── Running what is deployed ──────────────────────────────────────────────
 *
 * Everything below is a thin shell over an endpoint that already exists, and
 * all of it is scoped by the key to its one application, so none of it takes
 * an application id from the agent. Before these, an agent connected here
 * could ship an app and then not look at it: no logs, no history, no way to
 * undo a bad release. Those were reachable only by an agent that could run
 * curl, which a chat client cannot.
 *
 * Left out on purpose, because a project key is not allowed them: reading rows
 * from the database, and minting more keys. They need an account token, which
 * belongs on a person's machine and not in an MCP server's environment.
 */

const asJson = (method, body) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

/** Query string from the arguments that were actually given. */
const query = (params) => {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  return pairs.length ? "?" + new URLSearchParams(pairs.map(([k, v]) => [k, String(v)])) : "";
};

/**
 * The application this key belongs to. A project key sees only its own, so the
 * list has exactly one entry; asked once, because it cannot change under a key.
 */
let ownApplication;
async function ownApplicationId() {
  if (!ownApplication) {
    const body = await api("/api/v1/applications");
    const list = Array.isArray(body) ? body : body.applications;
    const first = Array.isArray(list) ? list[0] : null;
    ownApplication = first && (first.applicationId || first.id);
    if (!ownApplication) throw new Error("This key could not find its application. Has it been revoked?");
  }
  return ownApplication;
}

const READ = { readOnlyHint: true, openWorldHint: false };

server.registerTool(
  "redeploy",
  {
    title: "Deploy again without sending the code",
    description:
      "Build and release the application again without uploading it. By default that is " +
      "the version last sent, with the current environment variables: this is how a changed " +
      "variable or a new AI key reaches the running app. For an application built from " +
      "GitHub, `latest` deploys the newest commit on its default branch instead. Returns a " +
      "taskId to poll with `deployment_status`.",
    inputSchema: {
      latest: z
        .boolean()
        .optional()
        .describe("GitHub applications only: deploy the branch's newest commit."),
    },
  },
  async ({ latest }) => asText(await api("/api/v1/redeploy", asJson("POST", latest ? { latest: true } : {}))),
);

server.registerTool(
  "deployment_history",
  {
    title: "Recent deployments",
    description:
      "Recent deploys, newest first: status, commit, address, and the full failure " +
      "sentence in `error`. Read this before redeploying after a failure; an unchanged " +
      "redeploy fails the same way.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("How many. Default 10.") },
    annotations: READ,
  },
  async ({ limit }) => asText(await api("/api/v1/deployments" + query({ limit }))),
);

server.registerTool(
  "logs",
  {
    title: "Read the application's logs",
    description: "What the running container has printed, newest last.",
    inputSchema: { limit: z.number().int().min(1).max(300).optional().describe("How many lines. Default 100.") },
    annotations: READ,
  },
  async ({ limit }) => asText(await api("/api/v1/logs" + query({ limit }))),
);

server.registerTool(
  "health",
  {
    title: "Is it serving?",
    description:
      "Last observed state (healthy, degraded, down or unknown) and when it was checked. " +
      "A sweep every five minutes, not a probe taken now: compare `checkedAt` with your deploy.",
    inputSchema: {},
    annotations: READ,
  },
  async () => asText(await api("/api/v1/health")),
);

server.registerTool(
  "metrics",
  {
    title: "Traffic, errors and speed",
    description:
      "Requests, server errors and their rate, p50 and p95 response times, and requests per " +
      "day. Check it when the user says the site is slow or failing: logs show what happened, " +
      "this shows how often. Requests include bots and every asset on a page, so they are not visitors.",
    inputSchema: { days: z.number().int().min(1).max(30).optional().describe("Window in days. Default 7.") },
    annotations: READ,
  },
  async ({ days }) => asText(await api("/api/v1/metrics" + query({ days }))),
);

server.registerTool(
  "rollback",
  {
    title: "Put back the previous version",
    description:
      "Put back the last version that went live before the one serving now, or a specific " +
      "deployment from `deployment_history`. It is built again from its source, so it takes " +
      "as long as a deploy; poll `deployment_status` with the returned taskId.",
    inputSchema: { deploymentId: z.string().optional().describe("A specific earlier deployment.") },
  },
  async ({ deploymentId }) =>
    asText(await api("/api/v1/rollback", asJson("POST", deploymentId ? { deploymentId } : {}))),
);

server.registerTool(
  "remove_env",
  {
    title: "Remove an environment variable",
    description:
      "Remove one variable. The running app keeps it until the next deploy; `redeploy` applies " +
      "it. A removed value cannot be shown again, only set again.",
    inputSchema: { key: z.string().describe("The variable's name.") },
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  async ({ key }) => asText(await api("/api/v1/secrets" + query({ key }), { method: "DELETE" })),
);

server.registerTool(
  "app_settings",
  {
    title: "The application's settings",
    description:
      "Its address, source, repository and branch, whether a push deploys it (`deployOnPush`), " +
      "and its root directory.",
    inputSchema: {},
    annotations: READ,
  },
  async () => asText(await api("/api/v1/applications/" + (await ownApplicationId()))),
);

server.registerTool(
  "update_app_settings",
  {
    title: "Change the application's settings",
    description:
      "Change any of: the address (`subdomain`, which stops the old one working at once; ask the " +
      "user first and show them the full URL), whether a push to a GitHub repository deploys by " +
      "itself (`deployOnPush`), and which directory holds the application inside the project " +
      "(`rootDirectory`, null for the whole project). Changing the directory analyzes the project " +
      "again and reports what it found; the running app changes on the next deploy.",
    inputSchema: {
      subdomain: z.string().optional().describe("The new address label, like my-app."),
      deployOnPush: z.boolean().optional().describe("GitHub applications only."),
      rootDirectory: z.string().nullable().optional().describe("A path like services/api, or null."),
    },
  },
  async ({ subdomain, deployOnPush, rootDirectory }) => {
    const body = {};
    if (subdomain !== undefined) body.subdomain = subdomain;
    if (deployOnPush !== undefined) body.deployOnPush = deployOnPush;
    if (rootDirectory !== undefined) body.rootDirectory = rootDirectory;
    return asText(await api("/api/v1/applications/" + (await ownApplicationId()), asJson("PATCH", body)));
  },
);

server.registerTool(
  "list_schedules",
  {
    title: "Scheduled jobs",
    description:
      "The application's scheduled jobs, each with its next and last run, last status and error, " +
      "plus the rules: UTC, a few jobs per application, runs at least five minutes apart.",
    inputSchema: {},
    annotations: READ,
  },
  async () => asText(await api("/api/v1/cron")),
);

server.registerTool(
  "add_schedule",
  {
    title: "Schedule a job",
    description:
      "Call a path on the application on a schedule, such as a nightly cleanup. Anyone can send " +
      "the x-antideploy-cron header the call carries, so an endpoint that does real work should " +
      "also check a secret of the app's own.",
    inputSchema: {
      schedule: z.string().describe('Five-field cron in UTC, like "0 3 * * *", or @hourly, @daily, @weekly, @monthly.'),
      path: z.string().describe("A path on this application, starting with a slash."),
      method: z.enum(["GET", "POST"]).optional().describe("Default POST."),
    },
  },
  async ({ schedule, path: jobPath, method }) =>
    asText(await api("/api/v1/cron", asJson("POST", { schedule, path: jobPath, method }))),
);

server.registerTool(
  "set_schedule_enabled",
  {
    title: "Pause or resume a scheduled job",
    description: "Resuming also resets the job's failure count, which pauses it after ten in a row.",
    inputSchema: {
      id: z.string().describe("The job's id from `list_schedules`."),
      enabled: z.boolean().describe("false pauses it, true resumes it."),
    },
  },
  async ({ id, enabled }) =>
    asText(await api("/api/v1/cron/" + encodeURIComponent(id), asJson("PATCH", { enabled }))),
);

server.registerTool(
  "remove_schedule",
  {
    title: "Remove a scheduled job",
    description: "To change a job's schedule or path, remove it and add it again.",
    inputSchema: { id: z.string().describe("The job's id from `list_schedules`.") },
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  async ({ id }) => asText(await api("/api/v1/cron/" + encodeURIComponent(id), { method: "DELETE" })),
);

server.registerTool(
  "database_info",
  {
    title: "The application's database",
    description:
      "Its state, size and tables, with the connection string masked. The platform creates a " +
      "Postgres database and sets DATABASE_URL by itself when the project needs one, or earlier " +
      "when `database_create` asks: do not send the user to sign up for another.",
    inputSchema: {},
    annotations: READ,
  },
  async () => asText(await api("/api/v1/database")),
);

/* ── Building against the real database ────────────────────────────────────
 *
 * Until these, the database appeared as a side effect of the first deploy, so
 * an agent writing the project had nothing to develop against and built on
 * SQLite or mock data.
 *
 * Creating it is allowed to a project key, which is scoped to one application.
 * Reading its connection string is not, and rightly: a project key is built to
 * be committed. So `database_env_to_file` uses the account token the connect
 * step (https://antideploy.com/agent.md) saves on this machine, read from
 * ~/.antideploy/config.json at the moment it is needed and never taken from
 * this server's environment, where it would end up in a config file that gets
 * committed. It is only ever used for the one application this key names.
 */

/** The account token saved on this machine by the connect step, or null. */
function accountToken() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".antideploy", "config.json"), "utf8"));
  } catch {
    return null;
  }
  if (!saved || typeof saved !== "object") return null;
  for (const value of Object.values(saved)) {
    if (typeof value === "string" && value.startsWith("adu_")) return value;
  }
  return null;
}

/**
 * Where the variables may be written: a `.env*` file inside the project
 * directory, and nowhere else. This tool writes a file on the user's machine at
 * an agent's request, so it is not given a free choice of path.
 */
function envFileTarget(file) {
  const root = process.cwd();
  const target = path.resolve(root, file || ".env");
  const inside = target.startsWith(root + path.sep);
  if (!inside || !path.basename(target).startsWith(".env")) {
    throw new Error("The file must be a .env file inside the project directory (" + root + "), such as .env or .env.local.");
  }
  return target;
}

/** `KEY='value'` lines out of the body the platform answers, comments dropped. */
function envLines(body) {
  const lines = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) lines.push({ key: line.slice(0, eq).trim(), line });
  }
  return lines;
}

/**
 * Put those lines in the file: a variable already there is replaced in place,
 * so running this twice never leaves two DATABASE_URLs (and which one wins is
 * different in every loader), and every other line is left alone.
 */
function mergeEnvFile(target, entries) {
  let text = "";
  try {
    text = fs.readFileSync(target, "utf8");
  } catch {
    /* a new file */
  }
  const existed = text.length > 0;
  const lines = existed ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const replaced = [];
  const added = [];
  for (const { key, line } of entries) {
    const at = lines.findIndex((l) => new RegExp("^\\s*(export\\s+)?" + key + "\\s*=").test(l));
    if (at >= 0) {
      lines[at] = line;
      replaced.push(key);
    } else {
      lines.push(line);
      added.push(key);
    }
  }
  // 0600 on a file this creates: it holds a password.
  fs.writeFileSync(target, lines.join("\n") + "\n", { mode: 0o600 });
  return { replaced, added };
}

/** Make sure git will not pick the file up. Returns what it did. */
function ensureIgnored(target) {
  const root = process.cwd();
  const rel = path.relative(root, target).split(path.sep).join("/");
  const ignoreFile = path.join(root, ".gitignore");
  let text = "";
  try {
    text = fs.readFileSync(ignoreFile, "utf8");
  } catch {
    /* none yet */
  }
  const covered = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l === rel || l === "/" + rel || l === ".env*" || l === ".env.*" || l === "*.env");
  if (covered) return "already ignored";
  fs.writeFileSync(ignoreFile, text + (text && !text.endsWith("\n") ? "\n" : "") + rel + "\n");
  return "added " + rel + " to .gitignore";
}

server.registerTool(
  "database_create",
  {
    title: "Create the application's database now",
    description:
      "Create this application's Postgres database now, while the project is still being written, so " +
      "it is built and tested against the real thing instead of SQLite or mock data. A later deploy " +
      "reuses it, so what was tested is what goes live. Safe to call twice. Skip it when the project " +
      "stores nothing, or already points at a database the user chose (a DATABASE_URL in .env that is " +
      "not localhost, or a provider they named): the answer is a 409 own_database. It counts against " +
      "the plan's allowance; a 402 database_limit is not a rate limit, so do not retry, say what it " +
      "says and let the user choose. If the call is refused or blocked, do not look for another " +
      "route: tell the user, who can approve it or press Create database on the application's page " +
      "in the console, then carry on with `database_env_to_file`. The connection string is not " +
      "returned: call `database_env_to_file` to put it in .env. Tell the user what was created " +
      "and on which account.",
    inputSchema: {},
  },
  async () => asText(await api("/api/v1/database", asJson("POST", {}))),
);

server.registerTool(
  "database_env_to_file",
  {
    title: "Put the database's variables in .env",
    description:
      "Write DATABASE_URL and the PG* variables for this application's database into a .env file in " +
      "the project directory, and return only the names of what was written. The password goes into " +
      "the file and never into this conversation, so do not read the file back out to the user. " +
      "These are the same variables the deployed app receives. Variables already in the file are " +
      "replaced, everything else is kept, and the file is added to .gitignore. Needs the account " +
      "token that connecting through https://antideploy.com/agent.md saves on this machine: a project " +
      "key cannot read a connection string. Once the app is live its database holds real data: " +
      "do not reset, truncate or drop it from here without asking.",
    inputSchema: {
      file: z
        .string()
        .optional()
        .describe("A .env file inside the project directory. Default .env; .env.local suits Next.js."),
    },
    annotations: { openWorldHint: false },
  },
  async ({ file }) => {
    const target = envFileTarget(file);
    const token = accountToken();
    if (!token) {
      throw new Error(
        "No account token on this machine. A project key cannot read a database's connection string. " +
          "Connect once: follow https://antideploy.com/agent.md (the user clicks Approve), which saves a " +
          "token at ~/.antideploy/config.json, then call this again.",
      );
    }

    const applicationId = await ownApplicationId();
    const response = await fetch(BASE + "/api/v1/database/env" + query({ applicationId }), {
      headers: { authorization: "Bearer " + token },
    });
    const body = await response.text();
    if (!response.ok) {
      let detail = response.statusText;
      try {
        const parsed = JSON.parse(body);
        detail = parsed.error || parsed.code || detail;
      } catch {
        /* keep the status text */
      }
      throw new Error(response.status + " from /api/v1/database/env: " + detail);
    }

    const entries = envLines(body);
    const { replaced, added } = mergeEnvFile(target, entries);
    return asText({
      file: target,
      variables: entries.map((e) => e.key),
      replaced,
      added,
      gitignore: ensureIgnored(target),
      note: "The values are in the file, not in this result. Do not print the file.",
    });
  },
);

server.registerTool(
  "security_scan",
  {
    title: "Scan the live app for vulnerabilities",
    description:
      "Start a scan of the running application: keys shipped to the browser, endpoints open " +
      "without a login, SQL injection, downloadable config files, open CORS and missing headers. " +
      "Takes seconds. Poll `security_scan_status` with the returned scanId.",
    inputSchema: {},
  },
  async () => asText(await api("/api/v1/security/scans", asJson("POST", { applicationId: await ownApplicationId() }))),
);

server.registerTool(
  "security_scan_status",
  {
    title: "Result of a security scan",
    description:
      "Status and findings, each with a severity, a plain explanation and a `recommendation`. " +
      "Poll until completed or failed. Fix each finding at its root, then scan again.",
    inputSchema: { scanId: z.string().describe("The scanId returned by `security_scan`.") },
    annotations: READ,
  },
  async ({ scanId }) => asText(await api("/api/v1/security/scans/" + encodeURIComponent(scanId))),
);

server.registerTool(
  "ai_wallet",
  {
    title: "AI wallet balance",
    description:
      "The balance, the rate usage is charged at, and the AI keys on this account. Only the user " +
      "can add money: give them the `topUpUrl` and wait.",
    inputSchema: {},
    annotations: READ,
  },
  async () => asText(await api("/api/v1/ai")),
);

server.registerTool(
  "create_ai_key",
  {
    title: "Give the application an AI key",
    description:
      "Create an OpenRouter key (hundreds of models, any OpenAI-compatible client at " +
      "https://openrouter.ai/api/v1) and save it into the application as OPENROUTER_API_KEY. " +
      "Then `redeploy` so the running app picks it up. The secret is not returned here: it is " +
      "in the application's environment, which is where it belongs, and out of this transcript. " +
      "A key on an empty wallet is disabled until the user tops it up.",
    inputSchema: { name: z.string().describe("A label for the key, like chatbot.") },
  },
  async ({ name }) => {
    const body = await api("/api/v1/ai/keys", asJson("POST", { name }));
    // A credential in an agent's transcript is a credential in scrollback.
    const { secret, warning, ...safe } = body;
    return asText({
      ...safe,
      secret: secret ? "[saved as OPENROUTER_API_KEY in the application, not shown]" : undefined,
    });
  },
);

await server.connect(new StdioServerTransport());

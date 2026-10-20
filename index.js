#!/usr/bin/env node
/**
 * antideploy-mcp: deploying to Antideploy from inside a coding agent.
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
 *
 * Two ways to be signed in, and both work:
 *
 *  - The `login` tool runs the platform's device flow. The person opens one link
 *    and clicks Approve; the account token is saved in ~/.antideploy and the
 *    server can then create applications, provision what they need and deploy.
 *    No dashboard, no key to copy.
 *  - ANTIDEPLOY_API_KEY, a project key for one application, as before. A server
 *    started with one is bound to that application.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as tar from "tar";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearToken,
  clientNameFor,
  configPath,
  normalizeBase,
  pollDeviceLogin,
  readToken,
  saveToken,
  startDeviceLogin,
} from "./lib/auth.js";
import {
  fetchLimits,
  findLink,
  isApplicationId,
  isInside,
  isPlaceholder,
  LINK_FILE,
  listProjectFiles,
  parseDotenv,
  platformManagedReason,
  refuseBroadFolder,
  refuseSymlink,
  writeLink,
} from "./lib/project.js";

const BASE = normalizeBase(process.env.ANTIDEPLOY_URL);
/** A project key bound to one application. Empty counts as unset. */
const KEY = process.env.ANTIDEPLOY_API_KEY || null;

/** Inlined when the package is bundled (see build.mjs); read from package.json otherwise. */
function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}
const VERSION = typeof __ANTIDEPLOY_MCP_VERSION__ === "string" ? __ANTIDEPLOY_MCP_VERSION__ : readVersion();

/**
 * Where the project is. A client that starts servers elsewhere can say so with
 * ANTIDEPLOY_PROJECT_DIR. A folder named in a call must be inside the folder the
 * server was started in (or that variable names): without that, a stray
 * instruction in a repository could send any folder on the machine to Antideploy.
 */
function projectDir(directory) {
  const base = path.resolve(process.env.ANTIDEPLOY_PROJECT_DIR || process.cwd());
  if (!directory) return base;
  const target = path.resolve(base, directory);
  const roots = [process.cwd(), process.env.ANTIDEPLOY_PROJECT_DIR].filter(Boolean);
  if (!roots.some((root) => isInside(root, target))) {
    throw new Error(
      target + " is outside the project this server was started in (" + base + "). The tools only act inside that folder. " +
        "If your client starts servers somewhere else, set ANTIDEPLOY_PROJECT_DIR to the project folder.",
    );
  }
  return target;
}

/** The project folder for anything that uploads or writes: never a whole home directory or drive. */
function workFolder(directory) {
  const dir = projectDir(directory);
  refuseBroadFolder(dir, os.homedir());
  return dir;
}

/* ── Packing ──────────────────────────────────────────────────────────────── */

async function packDirectory(dir, limits) {
  const { files, envFilesNotSent, virtualenvsSkipped } = listProjectFiles(dir);
  if (files.length === 0) throw new Error("No files to deploy in " + dir + ".");
  if (files.length > limits.maxFiles) {
    throw new Error(
      files.length + " files, and the limit is " + limits.maxFiles + ". Deploy a " +
        "subdirectory, or move build output into one of the ignored directories.",
    );
  }

  const mb = (bytes) => (bytes / 1048576).toFixed(1) + " MB";
  let total = 0;
  const tooBig = [];
  for (const rel of files) {
    const { size } = fs.statSync(path.join(dir, rel));
    if (size > limits.maxFileBytes) tooBig.push(rel + " (" + mb(size) + ")");
    total += size;
  }
  if (tooBig.length) {
    throw new Error(
      tooBig.slice(0, 3).join(", ") + (tooBig.length > 3 ? ", and " + (tooBig.length - 3) + " more" : "") +
        " over the " + mb(limits.maxFileBytes) + " limit for one file. Remove them, compress them, or have the app fetch them at runtime.",
    );
  }
  if (total > limits.maxTotalBytes) {
    throw new Error(
      mb(total) + " in total, and the limit is " + mb(limits.maxTotalBytes) + ". Leave out large " +
        "assets and build output, or have the app fetch them at runtime.",
    );
  }

  const chunks = [];
  // `portable` drops uid, gid and mtime noise, so an unchanged tree packs to an
  // identical archive, which is what lets the API answer "unchanged" rather
  // than rebuilding something byte-for-byte the same.
  for await (const chunk of tar.c({ gzip: true, cwd: dir, portable: true }, files)) {
    chunks.push(chunk);
  }
  return {
    archive: Buffer.concat(chunks),
    fileCount: files.length,
    totalBytes: total,
    envFilesNotSent,
    virtualenvsSkipped,
  };
}

/* ── Talking to the API ───────────────────────────────────────────────────── */

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const NOT_CONNECTED =
  "Not connected to Antideploy. Call the `login` tool: it gives the user one link to open and " +
  "approve, and after that this server can create the application, deploy and run it. " +
  "(A project key in ANTIDEPLOY_API_KEY also works.)";

/** One request with a credential. Throws an ApiError that names the code and the sentence. */
async function send(pathname, init, token) {
  const response = await fetch(BASE + pathname, {
    ...init,
    headers: { authorization: "Bearer " + token, ...(init.headers || {}) },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 800) };
  }
  if (!response.ok) {
    const code = body.code && body.code !== body.error ? body.code + ": " : "";
    let message = response.status + " from " + pathname + ": " + code + (body.error || response.statusText);
    if (response.status === 401) {
      message += " The credential was revoked or is for another server; call `login` to connect again.";
    }
    throw new ApiError(message, response.status, body);
  }
  return body;
}

/** The account token saved on this machine, or null. */
function accountToken() {
  return readToken(BASE);
}

/** The application a project key belongs to. A key sees only its own, so asked once. */
let keyApplication;
async function keyApplicationId() {
  if (!keyApplication) {
    const body = await send("/api/v1/applications", {}, KEY);
    const list = Array.isArray(body) ? body : body.applications;
    const first = Array.isArray(list) ? list[0] : null;
    keyApplication = first && (first.applicationId || first.id);
    if (!keyApplication) throw new Error("This key could not find its application. Has it been revoked?");
  }
  return keyApplication;
}

/**
 * The application a call is about.
 *
 * A server started with a project key is bound to that key's application. Without
 * one, the application is the one named in the call, or else the one recorded in
 * .antideploy.json in the project folder (or a parent). It is never guessed: an
 * account token can reach every project the person has, and deploying one
 * project's code over another's is not something to find out later.
 */
async function currentApplicationId(explicit, directory) {
  if (KEY) {
    const own = await keyApplicationId();
    if (explicit && explicit !== own) {
      throw new Error(
        "This server is bound to one application by ANTIDEPLOY_API_KEY. To work on another, " +
          "remove the key from this server's settings and use `login`.",
      );
    }
    return own;
  }
  if (explicit) {
    if (!isApplicationId(explicit)) {
      throw new Error("`" + String(explicit).slice(0, 40) + "` is not an application id. Take one from `list_applications`.");
    }
    return explicit;
  }
  const link = findLink(projectDir(directory));
  if (link) return link.applicationId;
  throw new Error(
    "This folder is not linked to an Antideploy application yet. Call `create_application` to make one " +
      "for this project, or `link_application` with an id from `list_applications`.",
  );
}

/** Add the application to the query, and to a JSON body, for a call made with an account token. */
function scoped(pathname, init, applicationId) {
  const url = pathname + (pathname.includes("?") ? "&" : "?") + "applicationId=" + encodeURIComponent(applicationId);
  let body = init.body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && !("applicationId" in parsed)) {
        body = JSON.stringify({ ...parsed, applicationId });
      }
    } catch {
      /* not JSON: the query carries it */
    }
  }
  return [url, { ...init, body }];
}

/**
 * A call about one application, made with whatever credential this server has:
 * its project key, or else the saved account token. `scope: false` is for calls
 * that are about the account or about an id already in the path.
 */
async function api(pathname, init = {}, options = {}) {
  const token = KEY || accountToken();
  if (!token) throw new Error(NOT_CONNECTED);
  // A key already names its application, but a call that names a different one
  // is an error to report, not a mistake to ignore.
  if (KEY && options.applicationId) await currentApplicationId(options.applicationId);
  if (KEY || options.scope === false) return send(pathname, init, token);
  const applicationId = await currentApplicationId(options.applicationId, options.directory);
  return send(...scoped(pathname, init, applicationId), token);
}

/**
 * A call a project key is not allowed to make: it needs the account token the
 * `login` tool saves. `what` completes "a project key cannot ...".
 */
async function accountApi(pathname, init, what, options = {}) {
  const token = accountToken();
  if (!token) {
    throw new Error(
      "No account token on this machine. A project key cannot " + what + ". " +
        "Call the `login` tool (the user clicks Approve once), then call this again.",
    );
  }
  if (options.scope === false) return send(pathname, init || {}, token);
  const applicationId = await currentApplicationId(options.applicationId, options.directory);
  return send(...scoped(pathname, init || {}, applicationId), token);
}

const asText = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

const server = new McpServer(
  { name: "antideploy", version: VERSION },
  {
    instructions:
      "Deploy applications to Antideploy and run them. Start with `login` unless the project already " +
      "has a key: it returns one link for the user to open and approve (it creates their account if " +
      "they have none), then call `login` again to finish. After that, `create_application` makes " +
      "the application for this folder and records it in .antideploy.json; there is nothing to " +
      "create in a dashboard. Deploys are asynchronous: `deploy` returns a taskId, and " +
      "`deployment_status` reports progress until the status is succeeded or failed. Warnings and " +
      "hazards in that response are structured data meant to be relayed to the user, not decoration. " +
      "Tell the user where it went live and on which account. " +
      "While a project is still being written, `database_create` gives it its Postgres now and " +
      "`database_env_to_file` puts the connection in .env without printing it, so it is built against " +
      "the real database and the deploy later reuses it; do not send the user to sign up for another, " +
      "and do not push DATABASE_URL through `set_env`. A project that takes uploads gets its private S3 " +
      "bucket the same way, with `storage_create` and `storage_env_to_file`, instead of writing to disk, " +
      "and a project with accounts gets sign-in for its own users with `auth_create` and " +
      "`auth_env_to_file`, instead of a library and a table of passwords of your own, and a project that " +
      "sends mail can send it with `email_create` and `email_env_to_file`, with the `resend` package and " +
      "no account to open; once it is on, `email_activity` and `email_deliverability` show what it sent " +
      "and how it is landing, and `email_pause` stops it at once. A .env file is never uploaded: store the " +
      "variables the app needs with `set_env_from_file` (it names them and never shows the values) or " +
      "`set_env`. Once something is live, the other tools run it: `logs`, `health`, `metrics` and " +
      "`deployment_history` to see what happened, `redeploy` after changing a variable, `rollback` to " +
      "undo a bad release, `add_schedule` for jobs, and `update_app_settings` for the address and " +
      "deploy-on-push. Deleting an application or its database is not offered here; the user does that " +
      "in the console.",
  },
);

/*
 * Hints a client can use to decide when to ask the person first. Reads are
 * read-only. A tool that adds something (a database, an application) is not
 * destructive. A tool that replaces or removes something that exists (a deploy
 * replaces what is live, set_env replaces a value, rollback replaces a release)
 * says so, because the MCP default for an unannotated write is "may destroy".
 */
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const NOT_DESTRUCTIVE = { destructiveHint: false, openWorldHint: false };
const REPLACES = { destructiveHint: true, openWorldHint: false };

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

/* ── Signing in ───────────────────────────────────────────────────────────── */

/**
 * A login that has been started and not yet approved. Held in memory only: the
 * device code is what redeems the token, so it never goes to the agent, and a
 * server that restarts simply starts a new login.
 */
let pendingLogin = null;
// Under the 60 s some clients give a tool call. The variable is for tests and slow links.
const LOGIN_WAIT_SECONDS = Math.min(Number(process.env.ANTIDEPLOY_LOGIN_WAIT_SECONDS) || 40, 50);

/* How long one deployment_status call waits for the deploy to finish. An agent that gets an answer at
   once polls in a tight loop: in the first acceptance run on 20 Oct 2026 one did about twenty calls in
   forty seconds, spent 0.44 USD, and gave up on a deploy that went live two minutes later. Kept well
   under the 60 seconds Codex allows a tool call by default. */
const STATUS_WAIT_SECONDS = 20;
const STATUS_WAIT_MAX_SECONDS = 40;
const STATUS_POLL_MS = Number(process.env.ANTIDEPLOY_STATUS_POLL_MS) || 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describeAccount(account) {
  return account && (account.label || account.email) ? account.label || account.email : null;
}

/** Whether the saved token still works, and for whom. A revoked token is forgotten. */
async function checkSavedToken(token) {
  try {
    const body = await send("/api/v1/applications", {}, token);
    return { valid: true, account: body.account || null, applications: (body.applications || []).length };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      clearToken(BASE);
      return { valid: false };
    }
    throw error;
  }
}

function connectedAnswer(account, applications, extra = {}) {
  const link = findLink(projectDir());
  return asText({
    status: "connected",
    account: describeAccount(account),
    applications,
    folderLinkedTo: link ? link.applicationId : null,
    next: link
      ? "This folder is linked to an application. Deploy it, or use the other tools."
      : "Call `create_application` for this project, or `link_application` to use one the user already has.",
    tell: "Tell the user which account they connected" + (describeAccount(account) ? ": " + describeAccount(account) + "." : "."),
    ...extra,
  });
}

server.registerTool(
  "login",
  {
    title: "Sign in to Antideploy",
    description:
      "Connect this machine to the user's Antideploy account. First call: returns a link and a short code; " +
      "show both to the user, who opens the link, checks the code matches and clicks Approve (that is the " +
      "only thing they do; if they have no account the same link creates one). Then call `login` again: it " +
      "waits for the approval, saves the login in ~/.antideploy and tells you which account was connected, " +
      "which you must tell the user. Later calls just confirm the connection. The login can be revoked any " +
      "time at https://antideploy.com/tokens. If the user declines, stop and do not start another unless they " +
      "ask. The token is never shown to you.",
    inputSchema: {
      force: z
        .boolean()
        .optional()
        .describe("Start a new login even if one is saved, to switch to a different account."),
    },
    annotations: NOT_DESTRUCTIVE,
  },
  async ({ force }) => {
    const saved = accountToken();
    if (saved && !force && !pendingLogin) {
      const check = await checkSavedToken(saved);
      if (check.valid) return connectedAnswer(check.account, check.applications, { savedAt: configPath(BASE) });
    }
    if (force) pendingLogin = null;
    if (pendingLogin && Date.now() > pendingLogin.expiresAt) pendingLogin = null;

    if (pendingLogin) {
      const deadline = Date.now() + LOGIN_WAIT_SECONDS * 1000;
      let result;
      for (;;) {
        result = await pollDeviceLogin(BASE, pendingLogin.deviceCode);
        if (result.state !== "pending") break;
        if (Date.now() + pendingLogin.interval * 1000 > deadline) break;
        await sleep(pendingLogin.interval * 1000);
      }
      if (result.state === "granted") {
        const file = saveToken(BASE, result.token);
        pendingLogin = null;
        const check = result.account ? { account: result.account, applications: null } : await checkSavedToken(result.token);
        return connectedAnswer(check.account, check.applications, { savedAt: file });
      }
      if (result.state === "denied") {
        pendingLogin = null;
        return asText({
          status: "denied",
          message: "The user declined the login. Do not start another unless they ask you to.",
        });
      }
      if (result.state === "pending") {
        return asText({
          status: "waiting_for_approval",
          url: pendingLogin.url,
          code: pendingLogin.code,
          message:
            "Not approved yet. Remind the user to open the link, check the code reads " + pendingLogin.code +
            " and click Approve, then call `login` again. Do not start a new login.",
        });
      }
      pendingLogin = null; // expired: fall through and start again
    }

    const name = clientNameFor(server.server.getClientVersion()?.name, VERSION);
    const started = await startDeviceLogin(BASE, name);
    pendingLogin = {
      deviceCode: started.deviceCode,
      code: started.userCode,
      url: started.verificationUriComplete,
      interval: started.interval,
      expiresAt: Date.now() + started.expiresIn * 1000,
    };
    return asText({
      status: "approval_needed",
      url: pendingLogin.url,
      code: pendingLogin.code,
      expiresInMinutes: Math.round(started.expiresIn / 60),
      say:
        "Open " + pendingLogin.url + " and confirm the code reads " + pendingLogin.code + ", then click Approve. " +
        "If you do not have an account yet, that link creates one.",
      next: "After they approve, call `login` again. It waits for the approval and saves the login.",
    });
  },
);

server.registerTool(
  "logout",
  {
    title: "Forget the saved login",
    description:
      "Delete the account token saved on this machine, only when the user asked to sign out. It does not " +
      "revoke the token on the server; for that the user opens https://antideploy.com/tokens. A project key " +
      "in ANTIDEPLOY_API_KEY is not affected.",
    inputSchema: {},
    annotations: REPLACES,
  },
  async () => {
    pendingLogin = null;
    const had = clearToken(BASE);
    return asText({
      signedOut: had,
      message: had
        ? "The saved login is deleted from this machine. To revoke it on the server too, the user opens https://antideploy.com/tokens."
        : "There was no saved login.",
    });
  },
);

/* ── Applications ─────────────────────────────────────────────────────────── */

server.registerTool(
  "list_applications",
  {
    title: "The account's applications",
    description:
      "Every application on the account (or the one this server's key belongs to), with its id, name " +
      "and address, and which account this is. Use it to pick an id for `link_application`.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => asText(await api("/api/v1/applications", {}, { scope: false })),
);

server.registerTool(
  "create_application",
  {
    title: "Create the application for this project",
    description:
      "Create an Antideploy application for the project in this folder and record it in " +
      ".antideploy.json, so every later call knows which application it is about. This is the step the " +
      "dashboard used to be for: there is no application or key to make by hand. Do it once per project, " +
      "before `database_create` and `deploy`. A name already in use answers with the existing application, " +
      "which is then linked instead of duplicated. The address is the user's to choose: if they have said " +
      "what they want, pass it as `subdomain` after `check_address`; otherwise leave it out and settle it " +
      "with `update_app_settings` before the first deploy. A 402 means the plan's limit is reached: " +
      "that is not a rate limit, so do not retry, say what it says and let the user choose. Needs `login`.",
    inputSchema: {
      name: z.string().optional().describe("Letters, digits and hyphens. Defaults to the folder's name."),
      subdomain: z.string().optional().describe("The address label the user chose, like my-app."),
      directory: z.string().optional().describe("The project folder. Defaults to this server's working directory."),
    },
    annotations: NOT_DESTRUCTIVE,
  },
  async ({ name, subdomain, directory }) => {
    const dir = workFolder(directory);
    if (!fs.existsSync(dir)) throw new Error("No such directory: " + dir);
    const existing = fs.existsSync(path.join(dir, LINK_FILE)) ? findLink(dir) : null;
    if (existing) {
      throw new Error(
        dir + " is already linked to application " + existing.applicationId + " (" + LINK_FILE + "). " +
          "Use it, or delete that file first if this really is a new project.",
      );
    }
    const wanted = name || path.basename(dir);
    let created;
    let reused = false;
    try {
      created = await accountApi(
        "/api/v1/applications",
        asJson("POST", subdomain ? { name: wanted, subdomain } : { name: wanted }),
        "create an application",
        { scope: false },
      );
    } catch (error) {
      if (error instanceof ApiError && error.body && error.body.code === "name_taken" && error.body.applicationId) {
        created = { name: wanted, applicationId: error.body.applicationId, account: error.body.account };
        reused = true;
      } else {
        throw error;
      }
    }
    const file = writeLink(dir, created.applicationId, created.name);
    return asText({
      applicationId: created.applicationId,
      name: created.name,
      subdomain: created.subdomain ?? null,
      account: describeAccount(created.account),
      reusedExisting: reused,
      linkFile: file,
      dashboard: created.dashboard,
      next: "Create its database with `database_create` if the project needs one, then `deploy`. Tell the user which account this is on.",
    });
  },
);

server.registerTool(
  "link_application",
  {
    title: "Use an existing application for this folder",
    description:
      "Record an application the user already has in .antideploy.json for this folder, so deploys and the " +
      "other tools act on it. Take the id from `list_applications`. Only when the user said which one; never " +
      "guess, because deploying a project over another application replaces what is live there.",
    inputSchema: {
      applicationId: z.string().describe("An id from `list_applications`."),
      directory: z.string().optional().describe("The project folder. Defaults to this server's working directory."),
    },
    annotations: NOT_DESTRUCTIVE,
  },
  async ({ applicationId, directory }) => {
    if (!isApplicationId(applicationId)) {
      throw new Error("`" + String(applicationId).slice(0, 40) + "` is not an application id. Take one from `list_applications`.");
    }
    const dir = workFolder(directory);
    if (!fs.existsSync(dir)) throw new Error("No such directory: " + dir);
    const listed = await accountApi("/api/v1/applications", {}, "link a folder to an application", { scope: false });
    const match = (listed.applications || []).find((a) => a.applicationId === applicationId);
    if (!match) throw new Error("That application is not on this account. `list_applications` shows the ones that are.");
    const file = writeLink(dir, applicationId, match.name);
    return asText({ applicationId, name: match.name, subdomain: match.subdomain, account: describeAccount(listed.account), linkFile: file });
  },
);

server.registerTool(
  "check_address",
  {
    title: "Is this address free?",
    description:
      "Check whether an address label such as my-app is free to use as my-app.antideploy.app, before " +
      "creating the application with it. The address is the link the user shares, so it is theirs to choose.",
    inputSchema: { label: z.string().describe("The label to check, like my-app.") },
    annotations: READ_ONLY,
  },
  async ({ label }) => asText(await api("/api/v1/hostnames/check" + query({ label }), {}, { scope: false })),
);

/* ── Deploying ────────────────────────────────────────────────────────────── */

server.registerTool(
  "deploy",
  {
    title: "Deploy the project",
    description:
      "Package a project directory and deploy it. Sends the whole directory, not just an entry point: a " +
      "deploy containing one file builds successfully and then serves a page whose assets all 404. " +
      "Returns a taskId to poll with `deployment_status`. A .env file is never uploaded, and neither are " +
      "node_modules, build output, private keys or Python virtualenvs; the result names any .env files " +
      "that were left out. The application's variables come from `set_env`, `set_env_from_file` or the " +
      "`env` argument here, and the platform sets the database, storage, sign-in and email ones itself. " +
      "The folder must be linked to an application (`create_application`) unless this server has a project key. " +
      "When it succeeds, tell the user where it is live and on which account.",
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
      applicationId: z
        .string()
        .optional()
        .describe("Deploy to this application instead of the one the folder is linked to."),
    },
    annotations: REPLACES,
  },
  async ({ directory, env, force, applicationId }) => {
    const dir = workFolder(directory);
    if (!fs.existsSync(dir)) throw new Error("No such directory: " + dir);

    const limits = await fetchLimits(BASE);
    const { archive, fileCount, totalBytes, envFilesNotSent, virtualenvsSkipped } = await packDirectory(dir, limits);

    const form = new FormData();
    form.append("archive", new Blob([archive]), "project.tar.gz");
    if (env) form.append("env", JSON.stringify(env));
    if (force) form.append("force", "true");

    const body = await api("/api/v1/deploy", { method: "POST", body: form }, { applicationId, directory: dir });
    return asText({
      directory: dir,
      fileCount,
      uploadedBytes: totalBytes,
      ...(envFilesNotSent.length
        ? {
            envFilesNotSent,
            envNote:
              "These files hold values and are never uploaded. If the app needs variables from them, store those " +
              "with `set_env_from_file` (it never shows the values) or `set_env`. The database, storage, sign-in " +
              "and email variables are set by the platform and must not be copied.",
          }
        : {}),
      ...(virtualenvsSkipped.length ? { virtualenvsSkipped } : {}),
      ...body,
    });
  },
);

server.registerTool(
  "deployment_status",
  {
    title: "Check a deployment",
    description:
      "Progress for one deployment: status, per-step detail, the analyzed spec, warnings and hazards. " +
      "The call waits up to 20 seconds for the deploy to finish, so call it again straight away until the " +
      "status is succeeded or failed; do not add pauses or your own polling loop. A first deploy usually " +
      "takes one to three minutes. Once it is live, `summary` is the sentence to tell the user: the address " +
      "and the account. On a failure read `error`, `failedStep` and the logs, fix the cause, and only " +
      "then deploy again; an unchanged redeploy fails the same way.",
    inputSchema: {
      taskId: z.string().describe("The taskId returned by `deploy`."),
      waitSeconds: z
        .number()
        .int()
        .min(0)
        .max(STATUS_WAIT_MAX_SECONDS)
        .optional()
        .describe("How long to wait for the deploy to finish before answering. Default 20. 0 answers at once."),
    },
    annotations: READ_ONLY,
  },
  async ({ taskId, waitSeconds }) => {
    const deadline = Date.now() + Math.min(waitSeconds ?? STATUS_WAIT_SECONDS, STATUS_WAIT_MAX_SECONDS) * 1000;
    for (;;) {
      const status = await api("/api/v1/deployments/" + encodeURIComponent(taskId), {}, { scope: false });
      const finished = status?.finished === true || status?.status === "succeeded" || status?.status === "failed";
      if (finished) return asText(status);
      if (Date.now() + STATUS_POLL_MS > deadline) {
        return asText({
          ...status,
          next: "Not finished yet. Call deployment_status again now; it waits for you. First deploys usually take one to three minutes.",
        });
      }
      await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
    }
  },
);

server.registerTool(
  "list_env",
  {
    title: "List environment variable names",
    description: "Names only. The platform never returns values, by design.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => asText(await api("/api/v1/secrets")),
);

server.registerTool(
  "set_env",
  {
    title: "Set environment variables",
    description:
      "Store or replace environment variables for this application. Write-only. Do not pass DATABASE_URL, " +
      "PG*, storage, sign-in or email variables: the platform sets those itself. To take values from a local " +
      ".env without them passing through this conversation, use `set_env_from_file`.",
    inputSchema: {
      env: z.record(z.string(), z.string()).describe("Variables to store, as name/value pairs."),
    },
    annotations: REPLACES,
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
  "set_env_from_file",
  {
    title: "Store variables from a local .env file",
    description:
      "Read the named variables out of a .env file in the project directory and store them for the " +
      "application, so the values go from the file to Antideploy and never through this conversation. " +
      "Only the names you list are sent. Names the platform fills in itself (the database, storage, " +
      "sign-in and email variables, the application's own address and generated signing secrets) are " +
      "refused with the reason, and so are empty values and template placeholders like your-key-here. " +
      "The result names what was stored and what was skipped, never a value. Redeploy afterwards for " +
      "the running app to pick them up.",
    inputSchema: {
      names: z.array(z.string()).min(1).describe("The variable names to store, such as STRIPE_SECRET_KEY."),
      file: z.string().optional().describe("A .env file inside the project directory. Default .env."),
      directory: z.string().optional().describe("The project folder. Defaults to this server's working directory."),
    },
    annotations: REPLACES,
  },
  async ({ names, file, directory }) => {
    const target = envFileTarget(file, workFolder(directory));
    let text;
    try {
      text = fs.readFileSync(target, "utf8");
    } catch {
      throw new Error("Could not read " + target + ".");
    }
    const values = parseDotenv(text);
    const send_ = {};
    const skipped = [];
    for (const name of [...new Set(names)]) {
      const reason = platformManagedReason(name);
      if (reason) skipped.push({ name, reason: reason + "; do not copy it" });
      else if (!(name in values)) skipped.push({ name, reason: "not in " + path.basename(target) });
      else if (!values[name].trim()) skipped.push({ name, reason: "empty value" });
      else if (isPlaceholder(values[name])) skipped.push({ name, reason: "looks like a template placeholder" });
      else send_[name] = values[name];
    }
    const stored = Object.keys(send_);
    if (stored.length) {
      await api("/api/v1/secrets", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ env: send_ }),
      }, { directory });
    }
    return asText({
      stored,
      skipped,
      note: stored.length
        ? "Stored. Call `redeploy` (or `deploy`) so the running app picks them up. No value is shown here."
        : "Nothing was stored.",
    });
  },
);

server.registerTool(
  "request_keys",
  {
    title: "Ask the user for keys only they have",
    description:
      "For a value that is not in the project, such as a Stripe secret key, a bot token or an AI provider's key: " +
      "get a link where the user pastes it on an Antideploy page, so it goes straight into the application's " +
      "encrypted variables and never passes through this conversation. Show the user the `url`, say where they " +
      "find the value in that provider's dashboard, then poll `list_env` until every name appears, and " +
      "`redeploy`. Never ask the user to paste a key into the chat. Do not ask for what the platform fills in " +
      "itself (the database, storage, sign-in and email variables, the application's own address and signing secrets).",
    inputSchema: {
      names: z.array(z.string()).min(1).describe("The variable names to collect, such as STRIPE_SECRET_KEY."),
    },
    annotations: NOT_DESTRUCTIVE,
  },
  async ({ names }) => asText(await api("/api/v1/secrets/request", asJson("POST", { names }))),
);

server.registerTool(
  "api_info",
  {
    title: "Read the API's own manual",
    description:
      "The platform's self-description: endpoints, limits and current behaviour. " +
      "Worth reading whenever something here disagrees with what the server does.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    const response = await fetch(BASE + "/api/v1", { headers: { accept: "application/json" } });
    return asText(await response.json());
  },
);

/* ── Running what is deployed ──────────────────────────────────────────────
 *
 * Everything below is a thin shell over an endpoint that already exists. Before
 * these, an agent connected here could ship an app and then not look at it: no
 * logs, no history, no way to undo a bad release. Those were reachable only by
 * an agent that could run curl, which a chat client cannot.
 *
 * Which application a call is about comes from the key, or else from the
 * folder's .antideploy.json (see currentApplicationId), so none of these takes
 * an application id from the agent.
 *
 * Left out on purpose: reading rows from the database, minting more keys, and
 * deleting anything. Those need a person at the console.
 */

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
    annotations: REPLACES,
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
    annotations: READ_ONLY,
  },
  async ({ limit }) => asText(await api("/api/v1/deployments" + query({ limit }))),
);

server.registerTool(
  "logs",
  {
    title: "Read the application's logs",
    description: "What the running container has printed, newest last.",
    inputSchema: { limit: z.number().int().min(1).max(300).optional().describe("How many lines. Default 100.") },
    annotations: READ_ONLY,
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
    annotations: READ_ONLY,
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
    annotations: READ_ONLY,
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
    annotations: REPLACES,
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
    annotations: READ_ONLY,
  },
  async () => asText(await api("/api/v1/applications/" + (await currentApplicationId()))),
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
    annotations: REPLACES,
  },
  async ({ subdomain, deployOnPush, rootDirectory }) => {
    const body = {};
    if (subdomain !== undefined) body.subdomain = subdomain;
    if (deployOnPush !== undefined) body.deployOnPush = deployOnPush;
    if (rootDirectory !== undefined) body.rootDirectory = rootDirectory;
    return asText(await api("/api/v1/applications/" + (await currentApplicationId()), asJson("PATCH", body)));
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
    annotations: READ_ONLY,
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
    annotations: NOT_DESTRUCTIVE,
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
    annotations: NOT_DESTRUCTIVE,
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
    annotations: READ_ONLY,
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
 * be committed. So `database_env_to_file` uses the account token that `login`
 * (or https://antideploy.com/agent.md) saves on this machine, read from
 * ~/.antideploy/config.json at the moment it is needed and never taken from
 * this server's environment, where it would end up in a config file that gets
 * committed. It is only ever used for the one application the call is about.
 */

/**
 * Where the variables may be written: a `.env*` file inside the project
 * directory, and nowhere else. This tool writes a file on the user's machine at
 * an agent's request, so it is not given a free choice of path.
 */
function envFileTarget(file, root) {
  const target = path.resolve(root, file || ".env");
  const inside = target !== root && isInside(root, target);
  if (!inside || !path.basename(target).startsWith(".env")) {
    throw new Error("The file must be a .env file inside the project directory (" + root + "), such as .env or .env.local.");
  }
  refuseSymlink(target, "That .env file");
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
function ensureIgnored(target, root) {
  const rel = path.relative(root, target).split(path.sep).join("/");
  const ignoreFile = path.join(root, ".gitignore");
  refuseSymlink(ignoreFile, "The .gitignore file");
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

/**
 * Fetch a variables file the platform made for this application, using the account token, and write it into a
 * `.env` file, answering with the names only. The database's connection and the bucket's key travel the same
 * way for the same reason: both are a secret, a project key is not allowed to read either, and neither may
 * appear in a transcript. `what` names the secret in the message for a machine that has not connected yet.
 */
async function envToFile(apiPath, file, what, directory) {
  const root = workFolder(directory);
  const target = envFileTarget(file, root);
  const token = accountToken();
  if (!token) {
    throw new Error(
      "No account token on this machine. A project key cannot read " + what + ". " +
        "Call the `login` tool (the user clicks Approve once), then call this again.",
    );
  }

  const applicationId = await currentApplicationId(undefined, directory);
  const response = await fetch(BASE + apiPath + query({ applicationId }), {
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
    throw new Error(response.status + " from " + apiPath + ": " + detail);
  }

  const entries = envLines(body);
  // Keep git from seeing the file before the secrets are in it, not after.
  const gitignore = ensureIgnored(target, root);
  const { replaced, added } = mergeEnvFile(target, entries);
  return asText({
    file: target,
    variables: entries.map((e) => e.key),
    replaced,
    added,
    gitignore,
    note: "The values are in the file, not in this result. Do not print the file.",
  });
}

/** The optional arguments every `*_env_to_file` tool takes. */
const ENV_FILE_ARGS = {
  file: z
    .string()
    .optional()
    .describe("A .env file inside the project directory. Default .env; .env.local suits Next.js."),
  directory: z
    .string()
    .optional()
    .describe("The project folder. Defaults to this server's working directory."),
};

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
    annotations: NOT_DESTRUCTIVE,
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
      "token that `login` (or https://antideploy.com/agent.md) saves on this machine: a project " +
      "key cannot read a connection string. Once the app is live its database holds real data: " +
      "do not reset, truncate or drop it from here without asking.",
    inputSchema: ENV_FILE_ARGS,
    annotations: { openWorldHint: false },
  },
  async ({ file, directory }) => envToFile("/api/v1/database/env", file, "a database's connection string", directory),
);

/* ── File storage, the same way ─────────────────────────────────────────────
 *
 * A project that takes uploads used to write them to the container's disk,
 * which is replaced on every deploy, or send the user to sign up for a bucket
 * somewhere. The platform makes a private S3 bucket per application, and these
 * two put it in reach while the code is still being written.
 *
 * Same split as the database: creating one is allowed to a project key, and
 * reading its access key is not, so the key goes to a .env file by the account
 * token and never into the conversation.
 */

server.registerTool(
  "storage_create",
  {
    title: "Create the application's file storage now",
    description:
      "Create a private S3 bucket for this application now, while the project is still being written, " +
      "so uploads are built and tested against real storage instead of the container's disk, which is " +
      "wiped on every deploy. A later deploy gives the running app the same bucket. Safe to call twice. " +
      "Only for a project that stores uploads or generated files: skip it otherwise, and skip it when " +
      "the project already has a storage key of its own (an AWS_ACCESS_KEY_ID in .env that is not ours, " +
      "or a service the user named, such as Cloudinary or UploadThing): the answer is a 409 own_storage. " +
      "It counts against the plan's bucket allowance; a 402 storage_limit is not a rate limit, so do not " +
      "retry, say what it says and let the user choose. If the call is refused or blocked, do not look " +
      "for another route: tell the user. The key is not returned: call `storage_env_to_file` to put it " +
      "in .env. Addressing is path style, which current AWS SDKs and boto3 choose by themselves for " +
      "this bucket's name, so existing code that reads those variables works as it is; in new " +
      "JavaScript code set forcePathStyle: true anyway. A browser can upload straight to the bucket " +
      "with a presigned PUT URL. Tell the user what was created and on which account.",
    inputSchema: {},
    annotations: NOT_DESTRUCTIVE,
  },
  async () => asText(await api("/api/v1/storage", asJson("POST", {}))),
);

server.registerTool(
  "storage_env_to_file",
  {
    title: "Put the file storage's variables in .env",
    description:
      "Write the bucket's name, endpoint, region and access key (AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, " +
      "AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, AWS_REGION and the spellings other S3 libraries read) " +
      "into a .env file in the project directory, and return only the names of what was written. The " +
      "key goes into the file and never into this conversation, so do not read the file back out to the " +
      "user. These are the same variables the deployed app receives, so do not copy them into " +
      "`set_env`. Variables already in the file are replaced, everything else is kept, and the file is " +
      "added to .gitignore. The bucket has to exist first: `storage_create` makes it. Needs the account " +
      "token that `login` (or https://antideploy.com/agent.md) saves on this machine: a project " +
      "key cannot read the access key.",
    inputSchema: ENV_FILE_ARGS,
    annotations: { openWorldHint: false },
  },
  async ({ file, directory }) => envToFile("/api/v1/storage/env", file, "a bucket's access key", directory),
);

/* ── Sign-in for the application's own users, the same way ──────────────────
 *
 * A project with accounts used to get a library and a table of passwords of
 * the agent's own choosing, or a stop to ask its user for an account at some
 * third party. The platform switches on Neon Auth for the application's own
 * Postgres, so the people who sign up are rows beside the application's tables.
 *
 * Same split as the database and the bucket: creating it is allowed to a project
 * key, and reading the secret that signs session cookies is not, so that goes to
 * a .env file by the account token and never into the conversation.
 */

server.registerTool(
  "auth_create",
  {
    title: "Switch on sign-in for the application's own users now",
    description:
      "Switch on sign-in (Neon Auth) for this application now, while the project is still being written, " +
      "so a login page is built and tested against the real thing instead of a library and a table of " +
      "passwords of your own. The people who sign up are rows in a neon_auth schema of the application's " +
      "own Postgres, so it makes the database first if there is none, and that counts against the plan's " +
      "databases. Safe to call twice. Only for a project that has accounts: skip it otherwise, and skip " +
      "it when the user already chose a service (Clerk, Auth0, Supabase Auth), or when the project " +
      "connects to a database of its own: the answers are 409 own_auth and own_database. A 402 " +
      "database_limit is not a rate limit, so do not retry, say what it says and let the user choose. If " +
      "the call is refused or blocked, do not look for another route: tell the user. The cookie secret is " +
      "not returned: call `auth_env_to_file` to put the variables in .env. In Next.js, install " +
      "@neondatabase/auth and follow https://neon.com/docs/auth/quick-start/nextjs (a beta library, so " +
      "that page is the source of truth for its code). Anywhere else it is Better Auth over HTTP at " +
      "NEON_AUTH_BASE_URL: POST /sign-up/email and /sign-in/email, GET /get-session, and GET /token for a " +
      "JWT that verifies against NEON_AUTH_JWKS_URL, every request carrying an Origin that is the " +
      "application's own address. Localhost works while you build, and the platform registers the " +
      "application's address and any custom domain itself. Sign-up and sign-in allow about nine attempts " +
      "per ten seconds, then answer 429, so show a person a try-again message. Tell the user what was " +
      "created and on which account.",
    inputSchema: {},
    annotations: NOT_DESTRUCTIVE,
  },
  async () => asText(await api("/api/v1/auth", asJson("POST", {}))),
);

server.registerTool(
  "auth_env_to_file",
  {
    title: "Put the sign-in variables in .env",
    description:
      "Write NEON_AUTH_BASE_URL, NEON_AUTH_COOKIE_SECRET, NEON_AUTH_JWKS_URL and VITE_NEON_AUTH_URL into a " +
      ".env file in the project directory, and return only the names of what was written. The cookie " +
      "secret goes into the file and never into this conversation, so do not read the file back out to " +
      "the user. These are the same variables the deployed app receives, so do not copy them into " +
      "`set_env`. Variables already in the file are replaced, everything else is kept, and the file is " +
      "added to .gitignore. Sign-in has to exist first: `auth_create` makes it. Needs the account token " +
      "that `login` (or https://antideploy.com/agent.md) saves on this machine: a project key " +
      "cannot read the secret.",
    inputSchema: ENV_FILE_ARGS,
    annotations: { openWorldHint: false },
  },
  async ({ file, directory }) => envToFile("/api/v1/auth/env", file, "the secret that signs session cookies", directory),
);

/* ── Email, the same way ──────────────────────────────────────────────────────
 *
 * A project that sends mail used to leave it out, or stop to send its user to
 * open a Resend account, verify a domain by editing DNS and paste a key in. The
 * platform runs a relay that speaks Resend's own API, so the `resend` package
 * works unchanged: the address it sends to is RESEND_BASE_URL (Node) or
 * RESEND_API_URL (Python), and the key is a token that only the relay accepts.
 *
 * Same split as the others: switching it on is allowed to a project key, and
 * reading the token is not, so that goes to a .env file by the account token and
 * never into the conversation.
 */

server.registerTool(
  "email_create",
  {
    title: "Let the application send email now",
    description:
      "Let this application send email now, while the project is still being written, so a welcome or a " +
      "password reset is built and tested against the real thing instead of being left out or sending the " +
      "user to open a Resend account and verify a domain. There is nothing to sign up for. Safe to call " +
      "twice. Only for a project that sends mail: skip it otherwise, and skip it when the project already " +
      "sets a RESEND_API_KEY of its own (409 own_email). A 503 email_unavailable means email is not set up " +
      "on this server: carry on without it and tell the user. If the call is refused or blocked, do not " +
      "look for another route: tell the user. The token is not returned: call `email_env_to_file` to put " +
      "the variables in .env. Send with the `resend` package written as for any Resend account: new " +
      "Resend(process.env.RESEND_API_KEY), then resend.emails.send({ from: process.env.EMAIL_FROM, to, " +
      "subject, html }); in Python resend.api_key = os.environ['RESEND_API_KEY']. The package reads " +
      "RESEND_BASE_URL or RESEND_API_URL, which point at the platform's relay. The message always leaves " +
      "from the application's own address under the platform's sending domain, whatever `from` says, with " +
      "the application's name as the display name, and nothing receives replies at that address, so set " +
      "reply_to (replyTo in Node) to a real one if people may answer. It is transactional mail: at most five " +
      "addresses on a message, a limited " +
      "number a day by the owner's plan (fewer for an account only days old), and a 429 with " +
      "daily_quota_exceeded or rate_limit_exceeded means try later, so show a person a message and do not " +
      "retry in a loop. Attachments, scheduled sending, templates and resend.batch.send are refused. Never " +
      "use it for newsletters or bulk mail. Tell the user what was set up and on which account.",
    inputSchema: {},
    annotations: NOT_DESTRUCTIVE,
  },
  async () => asText(await api("/api/v1/email", asJson("POST", {}))),
);

server.registerTool(
  "email_env_to_file",
  {
    title: "Put the email variables in .env",
    description:
      "Write RESEND_API_KEY, RESEND_BASE_URL, RESEND_API_URL and EMAIL_FROM into a .env file in the project " +
      "directory, and return only the names of what was written. RESEND_API_KEY here is a token for the " +
      "platform's relay, not a Resend key, and it goes into the file and never into this conversation, so " +
      "do not read the file back out to the user. These are the same variables the deployed app receives, " +
      "so do not copy them into `set_env`. Variables already in the file are replaced, everything else is " +
      "kept, and the file is added to .gitignore. Email has to be set up first: `email_create` does it. " +
      "Needs the account token that `login` (or https://antideploy.com/agent.md) saves on this " +
      "machine: a project key cannot read the token.",
    inputSchema: ENV_FILE_ARGS,
    annotations: { openWorldHint: false },
  },
  async ({ file, directory }) => envToFile("/api/v1/email/env", file, "the email token", directory),
);

/*
 * Once email is on: look at it and run it. The reads take the project key. Stopping, starting, removing and testing change
 * how the application sends mail, so they use the account token, as reading the token does.
 */

server.registerTool(
  "email_status",
  {
    title: "How the application's email stands",
    description:
      "Whether this application can send email, from which address, its allowance and what it has sent in the last " +
      "24 hours, who stopped it if it is stopped (pausedBy, pausedReason), the last 14 days, when it last sent and " +
      "how its mail is landing (`health`). Read it before telling the user whether email works. Never returns the token.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => asText(await api("/api/v1/email")),
);

server.registerTool(
  "email_activity",
  {
    title: "What the application's email has sent",
    description:
      "The relay's log for this application, newest first: when, how many addresses, whether it was handed to Resend " +
      "or turned away, and what Resend reported afterwards (delivered, bounced, complained, delayed, failed, " +
      "suppressed) with a reason. Use it to answer \"did my email go out\" and \"why did that one not arrive\". It never " +
      "has a subject, a body or an address, because none is kept. `outcome` is null until Resend has reported, and " +
      "always while `reporting` is false. Page with `before` set to the `next` of the last answer.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe("How many rows, 1 to 200. Default 50."),
      before: z.string().optional().describe("Only rows older than this time: the `next` of the previous answer."),
      status: z.enum(["accepted", "rejected"]).optional().describe("Only messages the relay handed to Resend, or only ones turned away."),
      outcome: z
        .enum(["delivered", "bounced", "complained", "delayed", "failed", "suppressed"])
        .optional()
        .describe("Only messages Resend reported this about."),
    },
    annotations: READ_ONLY,
  },
  async ({ limit, before, status, outcome }) => asText(await api("/api/v1/email/activity" + query({ limit, before, status, outcome }))),
);

server.registerTool(
  "email_deliverability",
  {
    title: "How the application's mail is landing",
    description:
      "The last 7 days of this application's mail: delivered, bounced and reported as spam, whether it is healthy or one " +
      "to watch, the recent problems with the reason Resend gave, and the rules the platform uses to stop an " +
      "application's email by itself (at least three addresses bouncing that are a fifth of a day's mail, or two spam " +
      "reports in a week). While `reporting` is false the counts are zero because Resend's reports are not connected: " +
      "that means unknown, not healthy.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => asText(await api("/api/v1/email/deliverability")),
);

server.registerTool(
  "email_domain",
  {
    title: "Where the application's mail comes from",
    description:
      "The platform's sending domain, this application's own address under it, and the From value. Sending from the " +
      "user's own domain is not offered, so never send the user to add DNS records for email.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => asText(await api("/api/v1/email/domain")),
);

server.registerTool(
  "email_overview",
  {
    title: "Email across the account's applications",
    description:
      "Every application on the account and where its email stands (state, who paused it, what it sent in the last day " +
      "against its allowance, how its mail is landing), and which have none. Uses the account token when this machine " +
      "has one; with only a project key it shows this application alone.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () =>
    asText(
      accountToken()
        ? await accountApi("/api/v1/email/overview", undefined, "list the account's email", { scope: false })
        : await api("/api/v1/email/overview", {}, { scope: false }),
    ),
);

server.registerTool(
  "email_pause",
  {
    title: "Stop the application's email now",
    description:
      "Stop this application's email at once, for a leaked token or a loop in the code. Its token is refused (403 " +
      "suspended_api_key) until `email_resume`. The application itself keeps running. Needs the account token that " +
      "`login` (or https://antideploy.com/agent.md) saves: a project key cannot do it. Tell the user it is paused.",
    inputSchema: {},
    annotations: NOT_DESTRUCTIVE,
  },
  async () => asText(await accountApi("/api/v1/email/pause", asJson("POST", { applicationId: await currentApplicationId() }), "pause an application's email")),
);

server.registerTool(
  "email_resume",
  {
    title: "Start the application's email again",
    description:
      "Start this application's email again after `email_pause`. A pause the platform made because the mail was bouncing " +
      "or reported as spam answers 409 paused_for_deliverability and is not lifted from here: tell the user, who replies " +
      "to the notice they were emailed. Do not remove email and set it up again to get round it. Needs the account token.",
    inputSchema: {},
    annotations: NOT_DESTRUCTIVE,
  },
  async () => asText(await accountApi("/api/v1/email/resume", asJson("POST", { applicationId: await currentApplicationId() }), "resume an application's email")),
);

server.registerTool(
  "email_test",
  {
    title: "Send a test email to the account's own address",
    description:
      "Send one real message to the address of the account that owns this application, through the relay exactly as the " +
      "application's code would, so the user can see that email works. The recipient is always the account's own address. " +
      "It counts as one address against the day. Needs the account token.",
    inputSchema: {},
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  async () => asText(await accountApi("/api/v1/email/test", asJson("POST", { applicationId: await currentApplicationId() }), "send a test email")),
);

server.registerTool(
  "email_remove",
  {
    title: "Take email away from the application",
    description:
      "Take email away from this application. Its token is refused from then on, and the running app keeps the variables it " +
      "was given, so its mail fails until `email_create` sets it up again. Only when the user asked for it. Refused with " +
      "409 while the platform has it paused. Needs the account token.",
    inputSchema: {},
    annotations: REPLACES,
  },
  async () => asText(await accountApi("/api/v1/email", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ applicationId: await currentApplicationId() }) }, "remove an application's email")),
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
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  async () => asText(await api("/api/v1/security/scans", asJson("POST", { applicationId: await currentApplicationId() }))),
);

server.registerTool(
  "security_scan_status",
  {
    title: "Result of a security scan",
    description:
      "Status and findings, each with a severity, a plain explanation and a `recommendation`. " +
      "Poll until completed or failed. Fix each finding at its root, then scan again.",
    inputSchema: { scanId: z.string().describe("The scanId returned by `security_scan`.") },
    annotations: READ_ONLY,
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
    annotations: READ_ONLY,
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
    annotations: NOT_DESTRUCTIVE,
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

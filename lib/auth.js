/**
 * Signing in: where the account token lives and how the device flow gets one.
 *
 * The flow is the platform's own (RFC 8628, `POST /api/v1/device/code` then
 * `POST /api/v1/device/token`), the same one https://antideploy.com/agent.md
 * walks an agent through by hand. The token lands in the file agent.md names,
 * `~/.antideploy/config.json`, as `{"token":"adu_..."}`, so a token saved by
 * this server works for an agent following agent.md and the other way round.
 *
 * Nothing in here prints a token. Functions that hold one return it to the
 * caller and nothing else, and the caller's job is to write it to disk.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_BASE = "https://antideploy.com";

/** A request that has gone nowhere in this long is not going to answer. */
const TIMEOUT_MS = 15000;

export function normalizeBase(raw) {
  return (raw || DEFAULT_BASE).replace(/\/+$/, "");
}

/**
 * The file that holds the token for this server.
 *
 * A token is issued by one server and means nothing to another. So the default
 * host keeps the file agent.md names, and any other host (a local or staging
 * instance) gets a file of its own. Without that, signing in to a test server
 * would replace the production token in the shared file.
 */
export function configPath(base, home = os.homedir()) {
  const dir = path.join(home, ".antideploy");
  if (normalizeBase(base) === DEFAULT_BASE) return path.join(dir, "config.json");
  const host = new URL(normalizeBase(base)).host.replace(/[^a-zA-Z0-9.-]/g, "_");
  return path.join(dir, "config-" + host + ".json");
}

/** The account token saved for this server, or null. */
export function readToken(base, home) {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(configPath(base, home), "utf8"));
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
 * Save the token where agent.md says to: mode 0600 in a 0700 directory, as
 * `{"token":"..."}`. Other fields in the file are kept. The write goes through a
 * temporary file and a rename, so a crash cannot leave a half-written file in
 * place of a token that was valid a moment ago and cannot be issued again.
 *
 * On Windows the mode bits do nothing; the file inherits the access of the
 * user's profile directory, which is the user and administrators.
 */
export function saveToken(base, token, home) {
  if (typeof token !== "string" || !token.startsWith("adu_")) {
    throw new Error("Refusing to save something that is not an account token.");
  }
  const file = configPath(base, home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  let saved = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed;
  } catch {
    /* a new file, or one that was not JSON and is replaced */
  }
  // Exactly one token in the file, so the one written is the one read back.
  for (const [key, value] of Object.entries(saved)) {
    if (typeof value === "string" && value.startsWith("adu_")) delete saved[key];
  }
  saved.token = token;

  const temp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(saved) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* not supported on this file system */
  }
  return file;
}

/** Forget the saved token. Returns whether there was one. */
export function clearToken(base, home) {
  const file = configPath(base, home);
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  if (!saved || typeof saved !== "object") return false;
  let had = false;
  for (const [key, value] of Object.entries(saved)) {
    if (typeof value === "string" && value.startsWith("adu_")) {
      delete saved[key];
      had = true;
    }
  }
  if (!had) return false;
  if (Object.keys(saved).length === 0) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, JSON.stringify(saved) + "\n", { mode: 0o600 });
  return true;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON; the status still says what happened */
  }
  return { status: response.status, ok: response.ok, body: parsed };
}

/** Ask the platform for a code. Nothing here needs a credential. */
export async function startDeviceLogin(base, clientName) {
  const { ok, status, body } = await postJson(normalizeBase(base) + "/api/v1/device/code", {
    clientName,
  });
  if (!ok || !body || typeof body.deviceCode !== "string" || typeof body.userCode !== "string") {
    throw new Error(
      "Could not start a login (" + status + "). " +
        (body && (body.error || body.code) ? String(body.error || body.code) : "The server did not answer as expected."),
    );
  }
  return {
    deviceCode: body.deviceCode,
    userCode: body.userCode,
    verificationUri: body.verificationUri,
    verificationUriComplete: body.verificationUriComplete,
    expiresIn: Number(body.expiresIn) || 900,
    interval: Math.max(2, Number(body.interval) || 5),
  };
}

/**
 * Ask once whether the person has approved. One of `pending`, `granted`,
 * `denied` or `expired`; a granted answer carries the token and the account.
 *
 * Granting is the redemption: the platform hands the token out once and never
 * again, so the caller must save it before doing anything else with it.
 */
export async function pollDeviceLogin(base, deviceCode) {
  const { ok, status, body } = await postJson(normalizeBase(base) + "/api/v1/device/token", {
    deviceCode,
  });
  if (ok && body && typeof body.token === "string") {
    if (!body.token.startsWith("adu_")) {
      throw new Error("The server answered with something that is not an account token.");
    }
    return { state: "granted", token: body.token, account: body.account || null };
  }
  const code = body && (body.error || body.code);
  if (code === "authorization_pending" || status === 429) return { state: "pending" };
  if (code === "access_denied") return { state: "denied" };
  if (code === "expired_token") return { state: "expired" };
  throw new Error(
    "Could not check the login (" + status + "). " + (code ? String(code) : "The server did not answer as expected."),
  );
}

/** What the person sees on the approval screen: which tool is asking. */
const KNOWN_CLIENTS = [
  [/claude/i, "Claude Code"],
  [/cursor/i, "Cursor"],
  [/codex/i, "Codex"],
  [/opencode/i, "OpenCode"],
  [/windsurf/i, "Windsurf"],
  [/antigravity/i, "Antigravity"],
  [/cline/i, "Cline"],
  [/zed/i, "Zed"],
];

/**
 * "Claude Code (antideploy-mcp 0.2.0)". The platform stores this next to the
 * login, which is what lets us count sign-ins by agent and by route in. The
 * agent's name comes from what it called itself when it connected; a name this
 * does not recognise is passed on as given, trimmed.
 */
export function clientNameFor(clientInfoName, version) {
  const raw = typeof clientInfoName === "string" ? clientInfoName.trim().slice(0, 40) : "";
  let agent = raw || "An MCP client";
  for (const [pattern, label] of KNOWN_CLIENTS) {
    if (pattern.test(raw)) {
      agent = label;
      break;
    }
  }
  return agent + " (antideploy-mcp " + version + ")";
}

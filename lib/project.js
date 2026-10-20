/**
 * The project folder: what travels in an upload, which application a folder
 * belongs to, and how a `.env` file is read.
 *
 * The upload rules mirror the platform's own, `src/lib/upload-filter.ts` in the
 * platform repository. They are copied rather than imported because this
 * package runs on someone else's machine; `test/project.test.js` compares the
 * two when both repositories are checked out side by side, so a change on one
 * side that the other has not followed shows up as a failing test.
 */

import fs from "node:fs";
import path from "node:path";

/* ── What travels ─────────────────────────────────────────────────────────── */

/** Directory names that are always dependencies or build output. */
export const SKIP_SEGMENTS = new Set([
  "node_modules", ".git", ".next", ".nuxt", ".svelte-kit", "dist", "build",
  "out", "coverage", "vendor", "__pycache__", ".pytest_cache", ".mypy_cache",
  ".ruff_cache", ".venv", "venv", "env", ".turbo", ".cache", ".parcel-cache",
  "target", ".gradle", ".idea", ".vscode", ".terraform",
]);

export const SKIP_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * A `.env` that holds values, as opposed to `.env.example` and friends. The
 * platform drops these from every upload, because anything uploaded ends up in
 * a container layer that outlives the deploy. Variables reach the application
 * through `set_env` or `set_env_from_file`, never through the archive.
 */
export function isRealEnvFile(name) {
  if (!/^\.env(\.|$)/.test(name)) return false;
  return !/\.(example|sample|template|dist)$/.test(name);
}

/** Real env files, private keys and certificates: never uploaded. */
export function isSecretFile(name) {
  return isRealEnvFile(name) || /\.(pem|key|p12|pfx|keystore|jks)$/.test(name) || name === "id_rsa";
}

/** What the platform allows when it cannot be asked: its contract's own numbers. */
export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 4000,
  maxFileBytes: 28 * 1024 * 1024,
  maxTotalBytes: 28 * 1024 * 1024,
});

/**
 * The limits the platform publishes at `GET /api/v1`. They are read from there
 * so this package follows the contract instead of repeating it: the numbers here
 * were once copied by hand and the per-file one was wrong for weeks. Any trouble
 * reading them falls back to the defaults above.
 */
export async function fetchLimits(base) {
  try {
    const response = await fetch(base + "/api/v1", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { ...DEFAULT_LIMITS };
    const contract = await response.json();
    const limits = contract && contract.limits;
    const positive = (value, fallback) =>
      Number.isFinite(value) && value > 0 ? Number(value) : fallback;
    return {
      maxFiles: positive(limits && limits.maxFiles, DEFAULT_LIMITS.maxFiles),
      maxFileBytes: positive(limits && limits.maxFileBytes, DEFAULT_LIMITS.maxFileBytes),
      maxTotalBytes: positive(limits && limits.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes),
    };
  } catch {
    return { ...DEFAULT_LIMITS };
  }
}

/**
 * Every file under `dir` that belongs in an upload, as POSIX paths relative to
 * it, plus what was left out and is worth telling the user about.
 *
 * A directory holding a `pyvenv.cfg` is a Python virtualenv whatever it is
 * called (`venv312` is as common as `venv`), so it is skipped whole. The
 * platform does the same, and a project that sent one used to be refused for
 * having 34,000 files.
 */
export function listProjectFiles(dir) {
  const files = [];
  const envFilesNotSent = [];
  const virtualenvsSkipped = [];

  const visit = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // an unreadable directory is not worth failing a deploy over
    }
    if (rel && entries.some((e) => e.isFile() && e.name === "pyvenv.cfg")) {
      virtualenvsSkipped.push(rel);
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? rel + "/" + entry.name : entry.name;
      if (SKIP_SEGMENTS.has(entry.name)) continue;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        visit(childAbs, childRel);
      } else if (entry.isFile()) {
        if (SKIP_FILES.has(entry.name)) continue;
        if (isRealEnvFile(entry.name)) {
          envFilesNotSent.push(childRel);
          continue;
        }
        if (isSecretFile(entry.name)) continue;
        files.push(childRel);
      }
    }
  };
  visit(dir, "");
  return { files, envFilesNotSent, virtualenvsSkipped };
}

/* ── Staying inside the project ───────────────────────────────────────────── */

/*
 * An agent often works in a repository somebody else wrote, and anything in it
 * (a README, a comment, a file name) can try to steer it. These three rules keep
 * the damage that steering can do small: the tools only touch the folder they
 * were started in, they never write through a symbolic link, and they will not
 * take a whole home directory or drive for a project.
 */

/** `p` with every link resolved. For a path that does not exist yet, its nearest existing parent is resolved. */
export function realPath(p) {
  let current = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** Is `child` the same as `parent`, or inside it? Compared on real paths, so a link cannot lead out. */
export function isInside(parent, child) {
  const relative = path.relative(realPath(parent), realPath(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Refuse to write to `file` when it is a symbolic link: the content would land wherever the link points. */
export function refuseSymlink(file, what) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return; // it does not exist yet, which is the ordinary case
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      what + " (" + file + ") is a symbolic link, and writing through it would put the content outside this project. " +
        "Remove the link and try again.",
    );
  }
}

/** Refuse a home directory, anything that contains one, or a drive root, as a project. */
export function refuseBroadFolder(dir, home) {
  const real = realPath(dir);
  if (real === path.parse(real).root || isInside(real, home)) {
    throw new Error(
      real + " is too broad to be a project (it is, or contains, a home directory or a drive). " +
        "Open the agent in the project folder, or set ANTIDEPLOY_PROJECT_DIR to it.",
    );
  }
}

/* ── Which application a folder belongs to ────────────────────────────────── */

export const LINK_FILE = ".antideploy.json";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isApplicationId = (value) => typeof value === "string" && UUID.test(value);

/**
 * The application recorded for this folder, looking in the folder and then in
 * each parent, the way git looks for `.git`. The file holds an id and no
 * secret, and is meant to be committed.
 */
export function findLink(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const file = path.join(dir, LINK_FILE);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && isApplicationId(parsed.applicationId)) {
        return { applicationId: parsed.applicationId, file };
      }
    } catch {
      /* none here, or not readable as JSON: keep looking upward */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Record the application for a folder. Returns the file written. */
export function writeLink(dir, applicationId, name) {
  if (!isApplicationId(applicationId)) throw new Error("That is not an application id.");
  const file = path.join(path.resolve(dir), LINK_FILE);
  refuseSymlink(file, "The application link");
  const body = { applicationId };
  if (name) body.name = name;
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
  return file;
}

/* ── .env files ───────────────────────────────────────────────────────────── */

/** `KEY=value` lines out of a `.env` body, read the way the platform reads them. */
export function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = unquote(withoutExport.slice(eq + 1).trim());
  }
  return out;
}

function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = value.slice(1, -1);
      return first === '"' ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"') : inner;
    }
  }
  // An inline comment ends an unquoted value, but only after whitespace, so a
  // password or URL containing # is not cut short.
  return value.replace(/\s+#.*$/, "").trim();
}

/** Values that are placeholders from a template: importing one is worse than nothing. */
const PLACEHOLDER = /^(your[-_ ]?|xxx+$|<.*>$|changeme$|todo$|replace[-_ ]?me$|placeholder$|\.\.\.$)/i;
export const isPlaceholder = (value) => PLACEHOLDER.test(value.trim());

/* ── Names the platform fills in itself ───────────────────────────────────── */

/*
 * agent.md is firm about these: "Do not copy ... into PUT /api/v1/secrets, the
 * platform sets them in the deployed app itself." The server does not enforce
 * it, and a value set by hand wins over the platform's, so a copy taken from a
 * local `.env` would quietly replace the real database or bucket with whatever
 * the file held. `set_env_from_file` therefore refuses them.
 *
 * The last two lists are the platform's `OWN_ADDRESS_KEYS` and
 * `GENERATED_SECRET_KEYS` (src/lib/known-values.ts); the test compares them.
 */
export const OWN_ADDRESS_KEYS = [
  "APP_URL", "SITE_URL", "APP_BASE_URL", "NEXTAUTH_URL", "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SITE_URL", "VITE_APP_URL", "VITE_SITE_URL",
];
export const GENERATED_SECRET_KEYS = [
  "JWT_SECRET", "JWT_SECRET_KEY", "SESSION_SECRET", "SECRET_KEY", "AUTH_SECRET",
  "NEXTAUTH_SECRET", "COOKIE_SECRET", "APP_SECRET", "CSRF_SECRET",
  "JWT_REFRESH_SECRET", "REFRESH_TOKEN_SECRET", "ACCESS_TOKEN_SECRET",
];

const MANAGED = [
  [/^DATABASE_URL$|^PG(HOST|PORT|USER|PASSWORD|DATABASE|SSLMODE)$/, "the platform sets the database variables itself"],
  [/^(AWS_ENDPOINT_URL_S3|AWS_REGION|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_S3_BUCKET|BUCKET_NAME)$|^S3_/, "the platform sets the file storage variables itself"],
  [/^(NEON_AUTH_BASE_URL|NEON_AUTH_COOKIE_SECRET|NEON_AUTH_JWKS_URL|VITE_NEON_AUTH_URL)$/, "the platform sets the sign-in variables itself"],
  [/^(RESEND_API_KEY|RESEND_BASE_URL|RESEND_API_URL|EMAIL_FROM)$/, "the platform sets the email variables itself"],
  [/^PORT$/, "the platform sets the port"],
];

/**
 * Why a variable must not be copied from a local file, or null when it may be.
 * Only the automatic route is closed: `set_env` still stores any name it is
 * given, for the person who really does bring their own bucket or database.
 */
export function platformManagedReason(name) {
  const upper = name.toUpperCase();
  if (OWN_ADDRESS_KEYS.includes(upper)) return "the platform sets the application's own address itself";
  if (GENERATED_SECRET_KEYS.includes(upper)) return "the platform generates this signing secret itself";
  for (const [pattern, reason] of MANAGED) if (pattern.test(upper)) return reason;
  return null;
}

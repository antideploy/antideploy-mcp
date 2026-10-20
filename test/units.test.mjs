/**
 * The pieces that do not need a server: where the login is kept, what travels in
 * an upload, how a .env is read, and whether this package still agrees with the
 * platform's own rules.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { clearToken, clientNameFor, configPath, readToken, saveToken } from "../lib/auth.js";
import {
  DEFAULT_LIMITS,
  findLink,
  GENERATED_SECRET_KEYS,
  isInside,
  isPlaceholder,
  isRealEnvFile,
  listProjectFiles,
  OWN_ADDRESS_KEYS,
  parseDotenv,
  platformManagedReason,
  refuseBroadFolder,
  refuseSymlink,
  SKIP_SEGMENTS,
  writeLink,
} from "../lib/project.js";

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), "adunit-" + label + "-"));

describe("where the login is kept", () => {
  it("uses the file agent.md names for the real service and a separate file for any other host", () => {
    const home = path.join(os.tmpdir(), "h");
    assert.equal(configPath("https://antideploy.com", home), path.join(home, ".antideploy", "config.json"));
    assert.equal(configPath("https://antideploy.com/", home), path.join(home, ".antideploy", "config.json"));
    assert.equal(configPath("http://localhost:3100", home), path.join(home, ".antideploy", "config-localhost_3100.json"));
    assert.equal(configPath("https://staging.example.com", home), path.join(home, ".antideploy", "config-staging.example.com.json"));
  });

  it("saves {token} privately, keeps other fields, and leaves exactly one token", () => {
    const home = tmp("save");
    const base = "https://antideploy.com";
    const file = configPath(base, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ note: "keep me", old: "adu_old" }));
    saveToken(base, "adu_new", home);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(saved, { note: "keep me", token: "adu_new" });
    assert.equal(readToken(base, home), "adu_new");
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"], "a temporary file was left behind");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it("refuses to save anything that is not an account token", () => {
    const home = tmp("refuse");
    assert.throws(() => saveToken("https://antideploy.com", "ad_projectkey", home), /not an account token/);
    assert.throws(() => saveToken("https://antideploy.com", undefined, home), /not an account token/);
    assert.equal(readToken("https://antideploy.com", home), null);
  });

  it("reads a token from any field, as agent.md-written files may vary", () => {
    const home = tmp("read");
    const file = configPath("https://antideploy.com", home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ apiToken: "adu_abc" }));
    assert.equal(readToken("https://antideploy.com", home), "adu_abc");
    fs.writeFileSync(file, "not json");
    assert.equal(readToken("https://antideploy.com", home), null);
  });

  it("forgets the token and removes a file that held nothing else", () => {
    const home = tmp("clear");
    const base = "https://antideploy.com";
    assert.equal(clearToken(base, home), false);
    saveToken(base, "adu_x", home);
    assert.equal(clearToken(base, home), true);
    assert.equal(fs.existsSync(configPath(base, home)), false);
  });

  it("names the agent and the route in, so sign-ins can be counted by both", () => {
    assert.equal(clientNameFor("claude-code", "0.2.0"), "Claude Code (antideploy-mcp 0.2.0)");
    assert.equal(clientNameFor("Cursor", "0.2.0"), "Cursor (antideploy-mcp 0.2.0)");
    assert.equal(clientNameFor("codex-mcp-client", "0.2.0"), "Codex (antideploy-mcp 0.2.0)");
    assert.equal(clientNameFor("opencode", "0.2.0"), "OpenCode (antideploy-mcp 0.2.0)");
    assert.equal(clientNameFor("some-new-agent", "0.2.0"), "some-new-agent (antideploy-mcp 0.2.0)");
    assert.equal(clientNameFor(undefined, "0.2.0"), "An MCP client (antideploy-mcp 0.2.0)");
    assert.ok(clientNameFor("x".repeat(500), "0.2.0").length < 80);
  });
});

describe("what travels in an upload", () => {
  it("recognises env files that hold values and keeps the examples", () => {
    for (const name of [".env", ".env.local", ".env.production", ".env.development.local"]) assert.equal(isRealEnvFile(name), true, name);
    for (const name of [".env.example", ".env.sample", ".env.template", ".env.dist", "env.js", ".envrc"]) assert.equal(isRealEnvFile(name), false, name);
  });

  it("leaves out dependencies, secrets, junk and virtualenvs, whatever the venv is called", () => {
    const dir = tmp("walk");
    const write = (rel, body = "x") => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    };
    write("src/app.js");
    write("package.json");
    write(".env");
    write(".env.production");
    write(".env.example");
    write("key.pem");
    write("deploy/id_rsa");
    write("node_modules/a/index.js");
    write("dist/out.js");
    write(".DS_Store");
    write("venv312/pyvenv.cfg");
    write("venv312/lib/x.py");
    write("services/api/.venv/lib/y.py");
    write("pyvenv.cfg"); // at the root it describes the project, not a virtualenv to skip
    const found = listProjectFiles(dir);
    assert.deepEqual(found.files.sort(), [".env.example", "package.json", "pyvenv.cfg", "src/app.js"].sort());
    assert.deepEqual(found.envFilesNotSent.sort(), [".env", ".env.production"]);
    assert.deepEqual(found.virtualenvsSkipped, ["venv312"]);
  });

  it("uses the contract's numbers when the platform cannot be asked", () => {
    assert.equal(DEFAULT_LIMITS.maxFiles, 4000);
    assert.equal(DEFAULT_LIMITS.maxFileBytes, 28 * 1024 * 1024);
    assert.equal(DEFAULT_LIMITS.maxTotalBytes, 28 * 1024 * 1024);
  });
});

describe("staying inside the project", () => {
  // A junction needs no privilege on Windows; a file symbolic link does, so those cases skip where they cannot be made.
  const link = (target, at, type) => {
    try {
      fs.symlinkSync(target, at, type);
      return true;
    } catch {
      return false;
    }
  };

  it("knows what is inside a folder, with or without the folder existing yet", () => {
    const root = tmp("inside");
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    assert.equal(isInside(root, root), true);
    assert.equal(isInside(root, path.join(root, "a", "b")), true);
    assert.equal(isInside(root, path.join(root, "not", "yet")), true);
    assert.equal(isInside(path.join(root, "a"), root), false);
    assert.equal(isInside(root, path.join(root, "..")), false);
    assert.equal(isInside(root, path.join(root, "..", path.basename(root) + "-sibling")), false);
  });

  it("does not let a link lead out of a folder", (t) => {
    const root = tmp("lead-in");
    const outside = tmp("lead-out");
    fs.writeFileSync(path.join(outside, "secret.txt"), "x");
    if (!link(outside, path.join(root, "docs"), "junction")) return t.skip("cannot create a directory link here");
    assert.equal(isInside(root, path.join(root, "docs")), false);
    assert.equal(isInside(root, path.join(root, "docs", "secret.txt")), false);
  });

  it("refuses to write through a symbolic link, and allows a plain file or none", (t) => {
    const dir = tmp("symlink");
    assert.doesNotThrow(() => refuseSymlink(path.join(dir, "missing"), "x"));
    fs.writeFileSync(path.join(dir, "plain"), "x");
    assert.doesNotThrow(() => refuseSymlink(path.join(dir, "plain"), "x"));
    const outside = tmp("symlink-target");
    if (!link(outside, path.join(dir, "linked"), "junction")) return t.skip("cannot create a link here");
    assert.throws(() => refuseSymlink(path.join(dir, "linked"), "That .env file"), /That \.env file .* is a symbolic link/);
  });

  it("will not record an application through a link", (t) => {
    const dir = tmp("link-file");
    const outside = tmp("link-file-target");
    // A file link where the platform allows it, else a directory junction: either is a link at that path.
    const made = link(path.join(outside, "victim.txt"), path.join(dir, ".antideploy.json"), "file") ||
      link(outside, path.join(dir, ".antideploy.json"), "junction");
    if (!made) return t.skip("cannot create a link here");
    assert.throws(() => writeLink(dir, "4054421c-4789-47a4-a469-c055178278f6", "x"), /symbolic link/);
    assert.deepEqual(fs.readdirSync(outside), [], "something was written through the link");
  });

  it("will not take a home directory, one that holds it, or a drive for a project", () => {
    const home = tmp("home-guard");
    const project = path.join(home, "work", "app");
    fs.mkdirSync(project, { recursive: true });
    assert.throws(() => refuseBroadFolder(home, home), /too broad/);
    assert.throws(() => refuseBroadFolder(path.dirname(home), home), /too broad/, "a folder holding the home directory");
    assert.throws(() => refuseBroadFolder(path.parse(home).root, home), /too broad/, "a drive root");
    assert.doesNotThrow(() => refuseBroadFolder(project, home));
    assert.doesNotThrow(() => refuseBroadFolder(path.join(home, "work"), home));
  });
});

describe("which application a folder belongs to", () => {
  const id = "4054421c-4789-47a4-a469-c055178278f6";

  it("finds the link in the folder and in a parent, like git finds .git", () => {
    const root = tmp("link");
    const nested = path.join(root, "packages", "web");
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(findLink(nested), null);
    writeLink(root, id, "demo");
    assert.equal(findLink(nested).applicationId, id);
    assert.equal(findLink(root).file, path.join(root, ".antideploy.json"));
  });

  it("ignores a file that does not hold an application id", () => {
    const root = tmp("badlink");
    fs.writeFileSync(path.join(root, ".antideploy.json"), JSON.stringify({ applicationId: "undefined" }));
    assert.equal(findLink(root), null);
    assert.throws(() => writeLink(root, "undefined"), /not an application id/);
  });
});

describe("reading a .env", () => {
  it("reads what tools write: export, quotes, comments, and a # that is part of a value", () => {
    const parsed = parseDotenv(
      [
        "# a comment",
        "A=plain",
        "export B='single quoted # not a comment'",
        'C="double\\nquoted"',
        "D=value # trailing comment",
        "E=pass#word",
        "bad line",
        "1BAD=x",
        "",
        "F=",
      ].join("\r\n"),
    );
    assert.deepEqual(parsed, { A: "plain", B: "single quoted # not a comment", C: "double\nquoted", D: "value", E: "pass#word", F: "" });
  });

  it("spots template placeholders", () => {
    for (const v of ["your-key-here", "YOUR_API_KEY", "xxxxxx", "<token>", "changeme", "TODO", "replace-me", "..."]) assert.equal(isPlaceholder(v), true, v);
    for (const v of ["sk_live_abc", "postgres://u:p@h/db", "true"]) assert.equal(isPlaceholder(v), false, v);
  });

  it("refuses the names the platform fills in, and allows the user's own keys", () => {
    for (const name of [
      "DATABASE_URL", "PGPASSWORD", "AWS_ACCESS_KEY_ID", "S3_BUCKET", "BUCKET_NAME", "NEON_AUTH_BASE_URL",
      "RESEND_API_KEY", "EMAIL_FROM", "PORT", "APP_URL", "NEXTAUTH_URL", "JWT_SECRET", "nextauth_secret",
    ]) {
      assert.ok(platformManagedReason(name), name + " should be refused");
    }
    for (const name of ["STRIPE_SECRET_KEY", "OPENAI_API_KEY", "SENTRY_DSN", "GITHUB_TOKEN", "BASE_URL", "API_URL", "PUBLIC_URL"]) {
      assert.equal(platformManagedReason(name), null, name + " belongs to the user");
    }
  });
});

/*
 * The rules above are copied from the platform. When its repository is checked
 * out beside this one, compare them, so a change on one side shows up here.
 */
describe("agreement with the platform's source", () => {
  const platform = fileURLToPath(new URL("../../antideploy/src/lib/", import.meta.url));
  const have = fs.existsSync(path.join(platform, "upload-filter.ts")) && fs.existsSync(path.join(platform, "known-values.ts"));
  const skip = have ? false : "the platform repository is not checked out next to this one";

  const setIn = (source, name) => {
    const at = source.indexOf("export const " + name);
    assert.ok(at >= 0, name + " not found in the platform source");
    const open = source.indexOf("new Set([", at);
    const close = source.indexOf("])", open);
    return [...source.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  };

  it("skips the same directories", { skip }, () => {
    const source = fs.readFileSync(path.join(platform, "upload-filter.ts"), "utf8");
    assert.deepEqual([...SKIP_SEGMENTS].sort(), setIn(source, "SKIP_SEGMENTS"));
  });

  it("allows the same sizes and file counts", { skip }, () => {
    const source = fs.readFileSync(path.join(platform, "upload-filter.ts"), "utf8");
    assert.match(source, /export const MAX_FILES = 4000;/);
    assert.match(source, /export const MAX_TOTAL_BYTES = 28 \* 1024 \* 1024;/);
    assert.match(source, /export const MAX_FILE_BYTES = MAX_TOTAL_BYTES;/);
  });

  it("refuses the same names it fills in itself", { skip }, () => {
    const source = fs.readFileSync(path.join(platform, "known-values.ts"), "utf8");
    assert.deepEqual([...OWN_ADDRESS_KEYS].sort(), setIn(source, "OWN_ADDRESS_KEYS"));
    assert.deepEqual([...GENERATED_SECRET_KEYS].sort(), setIn(source, "GENERATED_SECRET_KEYS"));
  });
});

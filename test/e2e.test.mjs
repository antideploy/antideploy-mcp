/**
 * The connector, run the way an agent runs it: as a child process over stdio,
 * driven by the MCP SDK's own client, against a stand-in for the platform.
 *
 * Every test uses a throwaway home directory and a throwaway project, so no real
 * login on this machine is read and nothing is sent to antideploy.com.
 *
 * Run: npm test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { startFake } from "./fake-antideploy.mjs";
import { configPath } from "../lib/auth.js";

// The source by default; `npm run test:bundle` points the same suite at the bundle.
const INDEX = process.env.ANTIDEPLOY_ENTRY || fileURLToPath(new URL("../index.js", import.meta.url));
const PKG = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), "adtest-" + label + "-"));

function project(files) {
  const dir = tmp("project");
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return dir;
}

/** Every tool result seen, so the end of the run can prove no secret was in one. */
const transcript = [];

async function connect(fake, { home, cwd, env = {}, name = "claude-code" }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [INDEX],
    cwd,
    env: {
      HOME: home,
      USERPROFILE: home,
      ANTIDEPLOY_URL: fake.url,
      ANTIDEPLOY_LOGIN_WAIT_SECONDS: "3",
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  const call = async (tool, args = {}) => {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = (result.content || []).map((c) => c.text).join("\n");
    transcript.push(text);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* an error message, not JSON */
    }
    return { isError: !!result.isError, text, json };
  };
  return { client, call, close: () => client.close() };
}

describe("signing in and deploying with an account token", () => {
  let fake, home, dir, agent, issuedUserCode;

  before(async () => {
    fake = await startFake();
    home = tmp("home");
    dir = project({
      "index.js": "console.log('hello')",
      "package.json": "{}",
      "public/app.css": "body{}",
      ".env": "STRIPE_SECRET_KEY=sk_live_abc\nDATABASE_URL=postgres://local/dev\nJWT_SECRET=dev\nEMPTY=\nTEMPLATE=your-key-here\n",
      ".env.example": "STRIPE_SECRET_KEY=\n",
      "node_modules/left-pad/index.js": "// must not travel",
      ".git/config": "// must not travel",
      "server.pem": "// must not travel",
      ".DS_Store": "junk",
      "venv312/pyvenv.cfg": "home = /usr/bin",
      "venv312/lib/site.py": "# a virtualenv under a name no list contains",
      "assets/video.bin": Buffer.alloc(6 * 1024 * 1024, 7), // over the old 5 MB per-file cap
    });
    agent = await connect(fake, { home, cwd: dir });
  });

  after(async () => {
    await agent.close();
    await fake.close();
  });

  it("lists every tool with an annotation that says whether it reads, adds or replaces", async () => {
    const { tools } = await agent.client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [
      "login", "logout", "list_applications", "create_application", "link_application", "check_address",
      "deploy", "deployment_status", "set_env", "set_env_from_file", "request_keys", "database_create", "database_env_to_file",
      "logs", "health", "metrics", "redeploy", "rollback", "email_create", "security_scan",
    ]) {
      assert.ok(names.includes(expected), expected + " is missing");
    }
    assert.equal(new Set(names).size, names.length, "duplicate tool names");
    for (const tool of tools) {
      const a = tool.annotations || {};
      const classified = a.readOnlyHint === true || typeof a.destructiveHint === "boolean" || a.openWorldHint === false;
      assert.ok(classified, tool.name + " has no annotation");
      assert.ok(tool.description && tool.description.length > 40, tool.name + " has a thin description");
    }
    const flagged = (n) => tools.find((t) => t.name === n).annotations;
    for (const n of ["logs", "health", "metrics", "list_applications", "deployment_status"]) assert.equal(flagged(n).readOnlyHint, true, n);
    for (const n of ["deploy", "rollback", "set_env", "remove_env", "logout", "email_remove", "redeploy"]) assert.equal(flagged(n).destructiveHint, true, n);
    for (const n of ["database_create", "create_application", "login"]) assert.equal(flagged(n).destructiveHint, false, n);
    console.log("      " + names.length + " tools");
  });

  it("reports the package version as the server version", async () => {
    assert.equal(agent.client.getServerVersion().version, PKG.version);
  });

  it("refuses to deploy before login and says to call login", async () => {
    const r = await agent.call("deploy");
    assert.equal(r.isError, true);
    assert.match(r.text, /Call the `login` tool/);
  });

  it("login returns a link and a code and keeps the device code to itself", async () => {
    const r = await agent.call("login");
    assert.equal(r.json.status, "approval_needed");
    assert.match(r.json.url, /\/activate\?code=/);
    assert.match(r.json.code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
    assert.doesNotMatch(r.text, /dc_/, "the device code must not reach the agent");
    issuedUserCode = r.json.code;
    const issued = [...fake.state.codes.values()].find((c) => c.userCode === issuedUserCode);
    assert.equal(issued.clientName, "Claude Code (antideploy-mcp " + PKG.version + ")");
  });

  it("login waits while nobody has approved and does not start a second login", async () => {
    const before = fake.state.codes.size;
    const r = await agent.call("login");
    assert.equal(r.json.status, "waiting_for_approval");
    assert.equal(r.json.code, issuedUserCode);
    assert.equal(fake.state.codes.size, before);
  });

  it("login saves the token after approval, privately, and never shows it", async () => {
    await fake.approve(issuedUserCode);
    const r = await agent.call("login");
    assert.equal(r.json.status, "connected");
    assert.match(r.json.account, /tester@example\.com/);
    const file = configPath(fake.url, home);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.match(saved.token, /^adu_/);
    assert.ok(!r.text.includes(saved.token), "the token appeared in a tool result");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it("keeps a test server's login out of the production config file", async () => {
    assert.ok(!fs.existsSync(path.join(home, ".antideploy", "config.json")));
    assert.match(path.basename(configPath(fake.url, home)), /^config-127\.0\.0\.1_\d+\.json$/);
  });

  it("confirms an existing login without starting another", async () => {
    const before = fake.state.codes.size;
    const r = await agent.call("login");
    assert.equal(r.json.status, "connected");
    assert.equal(fake.state.codes.size, before);
  });

  it("will not guess an application: an unlinked folder is told to create one", async () => {
    const r = await agent.call("deploy");
    assert.equal(r.isError, true);
    assert.match(r.text, /not linked to an Antideploy application/);
    assert.equal(fake.state.deploys.length, 0);
  });

  it("creates the application with no dashboard and records it in .antideploy.json", async () => {
    const r = await agent.call("create_application", { name: "demo" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.applicationId, /^[0-9a-f-]{36}$/);
    const link = JSON.parse(fs.readFileSync(path.join(dir, ".antideploy.json"), "utf8"));
    assert.equal(link.applicationId, r.json.applicationId);
    const again = await agent.call("create_application", { name: "demo" });
    assert.equal(again.isError, true);
    assert.match(again.text, /already linked/);
  });

  it("still will not guess when the account has applications: an unlinked folder is refused", async () => {
    // A second agent, started in a different project, with the same login.
    const stranger = await connect(fake, { home, cwd: project({ "index.js": "1" }) });
    try {
      const before = fake.state.deploys.length;
      const r = await stranger.call("deploy");
      assert.equal(r.isError, true);
      assert.match(r.text, /not linked to an Antideploy application/);
      assert.equal(fake.state.deploys.length, before, "a folder with no link was deployed over some application");
    } finally {
      await stranger.close();
    }
  });

  it("links an existing application when the name is already in use", async () => {
    const otherDir = project({ "index.html": "<h1>x</h1>" });
    const second = await connect(fake, { home, cwd: otherDir });
    let r;
    try {
      r = await second.call("create_application", { name: "demo" });
    } finally {
      await second.close();
    }
    assert.equal(r.json.reusedExisting, true);
    const mine = JSON.parse(fs.readFileSync(path.join(dir, ".antideploy.json"), "utf8"));
    assert.equal(r.json.applicationId, mine.applicationId);
  });

  it("creates the database and writes its variables to .env without printing them", async () => {
    const created = await agent.call("database_create");
    assert.equal(created.isError, false, created.text);
    fs.writeFileSync(path.join(dir, ".env"), fs.readFileSync(path.join(dir, ".env"), "utf8"));
    const r = await agent.call("database_env_to_file");
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json.variables.sort(), ["DATABASE_URL", "PGHOST", "PGPASSWORD"]);
    assert.ok(!r.text.includes("secretpw") && !r.text.includes("postgres://user"), "a value appeared in the result");
    const env = fs.readFileSync(path.join(dir, ".env"), "utf8");
    assert.match(env, /DATABASE_URL='postgres:\/\/user:secretpw@db\.example\.com\/app'/);
    assert.equal((env.match(/^DATABASE_URL=/gm) || []).length, 1, "DATABASE_URL was duplicated");
    assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /\.env/);
  });

  it("deploys what should travel, over the old 5 MB cap, and says what it left out", async () => {
    const r = await agent.call("deploy");
    assert.equal(r.isError, false, r.text);
    const sent = fake.state.deploys.at(-1);
    assert.equal(sent.credential, "account");
    assert.equal(sent.applicationId, JSON.parse(fs.readFileSync(path.join(dir, ".antideploy.json"), "utf8")).applicationId);
    // .gitignore is there because database_env_to_file added .env to it; it is an ordinary file.
    assert.deepEqual(sent.names, [".antideploy.json", ".env.example", ".gitignore", "assets/video.bin", "index.js", "package.json", "public/app.css"].sort());
    assert.deepEqual(r.json.envFilesNotSent, [".env"]);
    assert.deepEqual(r.json.virtualenvsSkipped, ["venv312"]);
    assert.equal(sent.env, null, "no variables were asked for, so none are sent");
    assert.match(r.json.taskId, /^task_/);
  });

  it("follows the deploy to the sentence to tell the user", async () => {
    const first = await agent.call("deployment_status", { taskId: "task_1" });
    assert.equal(first.json.status, "building");
    const done = await agent.call("deployment_status", { taskId: "task_1" });
    assert.equal(done.json.status, "succeeded");
    assert.match(done.json.summary, /live at https:\/\/demo\.antideploy\.app, on the Antideploy account/);
  });

  it("refuses a file over the contract's limit before uploading anything", async () => {
    const bigDir = project({ "index.js": "1", "huge.bin": Buffer.alloc(29 * 1024 * 1024 + 1, 1) });
    const big = await connect(fake, { home, cwd: bigDir });
    try {
      await big.call("link_application", {
        applicationId: JSON.parse(fs.readFileSync(path.join(dir, ".antideploy.json"), "utf8")).applicationId,
      });
      const before = fake.state.deploys.length;
      const r = await big.call("deploy");
      assert.equal(r.isError, true);
      assert.match(r.text, /huge\.bin \(29\.0 MB\)/);
      assert.match(r.text, /limit for one file/);
      assert.equal(fake.state.deploys.length, before);
    } finally {
      await big.close();
    }
  });

  it("only acts inside the folder it was started in: another folder is refused, named or by a link", async () => {
    const elsewhere = project({ "index.html": "<h1>private</h1>" });
    const before = fake.state.deploys.length;
    for (const tool of ["deploy", "create_application", "link_application", "set_env_from_file", "database_env_to_file"]) {
      const args = tool === "link_application"
        ? { applicationId: JSON.parse(fs.readFileSync(path.join(dir, ".antideploy.json"), "utf8")).applicationId, directory: elsewhere }
        : tool === "set_env_from_file" ? { names: ["X"], directory: elsewhere } : { directory: elsewhere };
      const r = await agent.call(tool, args);
      assert.equal(r.isError, true, tool + " accepted a folder outside the project");
      assert.match(r.text, /outside the project this server was started in/, tool);
    }
    assert.equal(fake.state.deploys.length, before, "something was uploaded from outside the project");
    assert.ok(!fs.existsSync(path.join(elsewhere, ".antideploy.json")) && !fs.existsSync(path.join(elsewhere, ".env")));

    // A link inside the project that leads out is no way in. A junction needs no privilege on Windows.
    const inside = path.join(dir, "docs-link");
    try {
      fs.symlinkSync(elsewhere, inside, "junction");
    } catch {
      console.log("      (could not create a link here; the leading-out case is covered by units.test.mjs)");
      return;
    }
    const viaLink = await agent.call("deploy", { directory: "docs-link" });
    assert.equal(viaLink.isError, true, "a folder reached through a link was uploaded");
    assert.match(viaLink.text, /outside the project/);
    fs.rmSync(inside, { recursive: true, force: true });
  });

  it("will not write a database password through a link that stands in for .env", async (t) => {
    const victim = project({ "keep.txt": "private" });
    const poisoned = project({ "index.js": "1" });
    try {
      fs.symlinkSync(victim, path.join(poisoned, ".env"), "junction");
    } catch {
      return t.skip("cannot create a link here");
    }
    const hostile = await connect(fake, { home, cwd: poisoned });
    try {
      const appId = JSON.parse(fs.readFileSync(path.join(dir, ".antideploy.json"), "utf8")).applicationId;
      await hostile.call("link_application", { applicationId: appId });
      const r = await hostile.call("database_env_to_file");
      assert.equal(r.isError, true);
      // Refused by the containment check (the link leads outside) or by the link check; either way, nothing is written.
      assert.match(r.text, /must be a .env file inside the project directory|symbolic link/);
      assert.deepEqual(fs.readdirSync(victim), ["keep.txt"], "something was written through the link");
    } finally {
      await hostile.close();
    }
  });

  it("will not add a line to a .gitignore that is really a link to somewhere else", async (t) => {
    const victim = project({ "keep.txt": "private" });
    const poisoned = project({ "index.js": "1" });
    try {
      fs.symlinkSync(victim, path.join(poisoned, ".gitignore"), "junction");
    } catch {
      return t.skip("cannot create a link here");
    }
    const hostile = await connect(fake, { home, cwd: poisoned });
    try {
      const appId = JSON.parse(fs.readFileSync(path.join(dir, ".antideploy.json"), "utf8")).applicationId;
      await hostile.call("link_application", { applicationId: appId });
      const r = await hostile.call("database_env_to_file");
      assert.equal(r.isError, true);
      assert.match(r.text, /The .gitignore file .* is a symbolic link/);
      assert.deepEqual(fs.readdirSync(victim), ["keep.txt"], "something was written through the link");
      assert.ok(!fs.existsSync(path.join(poisoned, ".env")), "the password was written to .env after the guard should have stopped it");
    } finally {
      await hostile.close();
    }
  });

  it("will not take a home directory for a project", async () => {
    const atHome = await connect(fake, { home, cwd: home });
    try {
      const before = fake.state.deploys.length;
      const r = await atHome.call("deploy");
      assert.equal(r.isError, true);
      assert.match(r.text, /too broad to be a project/);
      assert.equal(fake.state.deploys.length, before);
    } finally {
      await atHome.close();
    }
  });

  it("takes the project folder from ANTIDEPLOY_PROJECT_DIR when the client starts it elsewhere", async () => {
    const root = project({ "index.js": "1", "sub/app.js": "2" });
    const started = await connect(fake, { home, cwd: os.tmpdir(), env: { ANTIDEPLOY_PROJECT_DIR: root } });
    try {
      const made = await started.call("create_application", { name: "elsewhere-app" });
      assert.equal(made.isError, false, made.text);
      assert.ok(fs.existsSync(path.join(root, ".antideploy.json")), "the link was not written in the named project");
      const sent = await started.call("deploy", { directory: "sub" });
      assert.equal(sent.isError, false, sent.text);
      assert.ok(fake.state.deploys.at(-1).names.includes("app.js"));
    } finally {
      await started.close();
    }
  });

  it("stores only the variables asked for from .env, and only ones the platform does not own", async () => {
    const r = await agent.call("set_env_from_file", {
      names: ["STRIPE_SECRET_KEY", "DATABASE_URL", "JWT_SECRET", "EMPTY", "TEMPLATE", "NOT_THERE"],
    });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json.stored, ["STRIPE_SECRET_KEY"]);
    const why = Object.fromEntries(r.json.skipped.map((s) => [s.name, s.reason]));
    assert.match(why.DATABASE_URL, /database variables/);
    assert.match(why.JWT_SECRET, /signing secret/);
    assert.match(why.EMPTY, /empty/);
    assert.match(why.TEMPLATE, /placeholder/);
    assert.match(why.NOT_THERE, /not in/);
    assert.ok(!r.text.includes("sk_live_abc"), "a value appeared in the result");
    const appId = JSON.parse(fs.readFileSync(path.join(dir, ".antideploy.json"), "utf8")).applicationId;
    assert.deepEqual([...fake.state.secrets.get(appId).keys()], ["STRIPE_SECRET_KEY"]);
  });

  it("gives the user a page to paste a key on instead of asking for it in the chat", async () => {
    const r = await agent.call("request_keys", { names: ["OPENAI_API_KEY"] });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.url, /\/secrets\?names=OPENAI_API_KEY/);
    assert.deepEqual(r.json.alreadySet, []);
  });

  it("runs the live app with the linked application on every call", async () => {
    const appId = JSON.parse(fs.readFileSync(path.join(dir, ".antideploy.json"), "utf8")).applicationId;
    for (const [tool, args] of [["logs"], ["health"], ["metrics"], ["deployment_history"], ["list_env"], ["redeploy"], ["rollback"], ["app_settings"]]) {
      const r = await agent.call(tool, args);
      assert.equal(r.isError, false, tool + ": " + r.text);
    }
    const scoped = fake.state.calls.filter((c) => ["/api/v1/logs", "/api/v1/health", "/api/v1/metrics", "/api/v1/redeploy", "/api/v1/rollback"].includes(c.path));
    assert.equal(scoped.length, 5);
    for (const c of scoped) assert.equal(c.applicationId, appId, c.path);
  });

  it("leaves the account's applications to the console to delete: no delete tool exists", async () => {
    const { tools } = await agent.client.listTools();
    assert.ok(!tools.some((t) => /delete|destroy/i.test(t.name)));
  });

  it("forgets a login the server has revoked and starts a fresh one", async () => {
    await fake.revokeAll();
    const r = await agent.call("login");
    assert.equal(r.json.status, "approval_needed");
    assert.ok(!fs.existsSync(configPath(fake.url, home)), "the dead token was left on disk");
  });

  it("stops quietly when the person declines", async () => {
    const code = [...fake.state.codes.values()].at(-1).userCode;
    await fake.deny(code);
    const r = await agent.call("login");
    assert.equal(r.json.status, "denied");
    assert.match(r.json.message, /Do not start another/);
    assert.ok(!fs.existsSync(configPath(fake.url, home)));
  });

  it("logout removes the saved login", async () => {
    const started = await agent.call("login");
    await fake.approve(started.json.code);
    const connected = await agent.call("login");
    assert.equal(connected.json.status, "connected");
    const r = await agent.call("logout");
    assert.equal(r.json.signedOut, true);
    assert.ok(!fs.existsSync(configPath(fake.url, home)));
    const after = await agent.call("list_env");
    assert.equal(after.isError, true);
    assert.match(after.text, /Call the `login` tool/);
  });

  it("never put a token or a device code in any result", async () => {
    const all = transcript.join("\n");
    assert.doesNotMatch(all, /adu_[0-9a-f]{10}/);
    assert.doesNotMatch(all, /dc_[0-9a-f]{6}/);
  });
});

describe("the Claude Code plugin with nothing configured", () => {
  it("treats the empty values it passes for an unset key and address as not set", async () => {
    const fake = await startFake();
    // Claude Code passes ANTIDEPLOY_API_KEY="" for an unset optional field. Here
    // the address is the stand-in server, so nothing can reach the real service.
    const agent = await connect(fake, { home: tmp("home"), cwd: project({ "index.js": "1" }), env: { ANTIDEPLOY_API_KEY: "" } });
    try {
      const r = await agent.call("deploy");
      assert.equal(r.isError, true);
      assert.match(r.text, /Call the `login` tool/);
      const started = await agent.call("login");
      assert.equal(started.json.status, "approval_needed");
    } finally {
      await agent.close();
      await fake.close();
    }
  });
});

describe("a project key, as before", () => {
  let fake, home, dir, agent, key;

  before(async () => {
    fake = await startFake();
    key = fake.issueProjectKey("keyed-app");
    home = tmp("home");
    dir = project({ "index.js": "1", "package.json": "{}", ".env": "A=1\n" });
    agent = await connect(fake, { home, cwd: dir, env: { ANTIDEPLOY_API_KEY: key.key } });
  });

  after(async () => {
    await agent.close();
    await fake.close();
  });

  it("deploys without a login and without a linked folder", async () => {
    const r = await agent.call("deploy");
    assert.equal(r.isError, false, r.text);
    const sent = fake.state.deploys.at(-1);
    assert.equal(sent.credential, "project");
    assert.equal(sent.applicationId, key.applicationId);
    assert.ok(!sent.names.includes(".env"));
  });

  it("reads and runs the one application it is bound to", async () => {
    for (const tool of ["logs", "health", "deployment_history", "list_env", "app_settings", "list_applications"]) {
      const r = await agent.call(tool);
      assert.equal(r.isError, false, tool + ": " + r.text);
    }
    const listed = await agent.call("list_applications");
    assert.equal(listed.json.applications.length, 1);
  });

  it("cannot create applications or read a connection string, and says how to get that", async () => {
    const create = await agent.call("create_application", { name: "other" });
    assert.equal(create.isError, true);
    assert.match(create.text, /Call the `login` tool/);
    const env = await agent.call("database_env_to_file");
    assert.equal(env.isError, true);
    assert.match(env.text, /Call the `login` tool/);
  });

  it("refuses to be pointed at a different application than its key", async () => {
    const r = await agent.call("deploy", { applicationId: "11111111-1111-4111-8111-111111111111" });
    assert.equal(r.isError, true);
    assert.match(r.text, /bound to one application/);
  });

  it("uses a saved account token for what a key cannot do, on the key's own application", async () => {
    const started = await agent.call("login");
    await fake.approve(started.json.code);
    const done = await agent.call("login");
    assert.equal(done.json.status, "connected");
    assert.equal((await agent.call("database_create")).isError, false);
    const env = await agent.call("database_env_to_file");
    assert.equal(env.isError, false, env.text);
    const used = fake.state.calls.filter((c) => c.path === "/api/v1/database/env").at(-1);
    assert.equal(used.credential, "account");
    assert.equal(used.applicationId, key.applicationId);
  });
});

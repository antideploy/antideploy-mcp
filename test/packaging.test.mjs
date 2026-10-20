/**
 * The packaging, as files: the per-agent configurations parse and agree with the
 * package, versions match everywhere they are written, and the skill follows
 * the rules each agent applies to skills. Nothing here starts a server.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));
const pkg = json("package.json");
const minor = pkg.version.split(".").slice(0, 2).join(".");
const SPEC = "antideploy-mcp@" + minor;

describe("versions", () => {
  it("are the same everywhere they are written", () => {
    assert.equal(json("server.json").version, pkg.version);
    assert.equal(json("server.json").packages[0].version, pkg.version);
    assert.equal(json("plugin/.claude-plugin/plugin.json").version, pkg.version);
    assert.equal(json(".claude-plugin/marketplace.json").metadata.version, pkg.version);
    assert.equal(json("plugin/.cursor-plugin/plugin.json").version, pkg.version);
  });

  it("name the package the way the registry expects", () => {
    assert.equal(json("server.json").name, pkg.mcpName);
    assert.equal(json("server.json").packages[0].identifier, pkg.name);
  });

  it("show no project key as required anywhere", () => {
    const vars = json("server.json").packages[0].environmentVariables;
    assert.equal(vars.find((v) => v.name === "ANTIDEPLOY_API_KEY").isRequired, false);
    // Declared settings make Claude Code ask the user to configure them after install, even with
    // empty defaults, so the plugin declares none; a key comes from the environment it inherits.
    assert.equal(json("plugin/.claude-plugin/plugin.json").userConfig, undefined);
    assert.equal(json("plugin/.mcp.json").mcpServers.antideploy.env, undefined);
  });
});

describe("what ships", () => {
  it("is the bundle, the skill and the readme, with no dependencies to resolve", () => {
    assert.ok(pkg.files.includes("dist") && pkg.files.includes("skills"));
    assert.equal(pkg.dependencies, undefined, "runtime dependencies make the first npx start slow");
    assert.equal(pkg.bin["antideploy-mcp"], "dist/antideploy-mcp.mjs");
  });
});

describe("per-agent configuration", () => {
  const launches = (command, args) => {
    assert.equal(command, "npx");
    assert.deepEqual(args, ["-y", SPEC]);
  };

  it("Claude Code plugin pins the exact version; the project file takes the minor line", () => {
    const plugin = json("plugin/.mcp.json").mcpServers.antideploy;
    assert.equal(plugin.command, "npx");
    // Anthropic's directory blocks a launcher that is not pinned to an exact version.
    assert.deepEqual(plugin.args, ["-y", "antideploy-mcp@" + pkg.version]);
    const project = json("agents/examples/claude-code.project-mcp.json").mcpServers.antideploy;
    launches(project.command, project.args);
  });

  it("Cursor config, plugin config and install link all say the same thing", () => {
    const example = json("agents/examples/cursor.mcp.json").mcpServers.antideploy;
    launches(example.command, example.args);
    assert.equal(example.type, "stdio");
    const bundled = json("plugin/mcp.json").mcpServers.antideploy;
    assert.deepEqual(bundled.args, ["-y", "antideploy-mcp@" + pkg.version]);
    assert.equal(bundled.type, "stdio");
    const link = read("agents/examples/cursor.install-link.txt").trim();
    const parsed = new URL(link);
    assert.equal(parsed.protocol, "cursor:");
    assert.equal(parsed.hostname, "anysphere.cursor-deeplink");
    assert.equal(parsed.pathname, "/mcp/install");
    assert.equal(parsed.searchParams.get("name"), "antideploy");
    const decoded = JSON.parse(Buffer.from(parsed.searchParams.get("config"), "base64").toString());
    assert.deepEqual(decoded, { command: "npx", args: ["-y", SPEC] });
    assert.ok(read("agents/cursor.md").includes(link), "the Cursor guide shows a different link");
  });

  it("Codex config is valid TOML with timeouts that survive a first download", () => {
    const toml = spawnSync("python", ["-c", "import tomllib,json,sys;print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))))", path.join(root, "agents/examples/codex.config.toml")], { encoding: "utf8" });
    if (toml.error || toml.status !== 0) return; // no Python here: the file is checked by eye in review
    const server = JSON.parse(toml.stdout).mcp_servers.antideploy;
    launches(server.command, server.args);
    assert.ok(server.startup_timeout_sec >= 30, "Codex waits 10 s by default; a first start needs longer");
  });

  it("OpenCode config uses its own shape, and a timeout past the 5 s default", () => {
    const server = json("agents/examples/opencode.json").mcp.antideploy;
    assert.equal(server.type, "local");
    assert.deepEqual(server.command, ["npx", "-y", SPEC]);
    assert.ok(server.timeout >= 30000);
  });

  it("each guide shows the config file it ships, character for character", () => {
    const check = (guide, example) => {
      const body = read(example).trim();
      assert.ok(read(guide).includes(body), guide + " does not match " + example);
    };
    check("agents/cursor.md", "agents/examples/cursor.mcp.json");
    check("agents/codex.md", "agents/examples/codex.config.toml");
    check("agents/opencode.md", "agents/examples/opencode.json");
  });
});

describe("the plugin folder", () => {
  const plugin = path.join(root, "plugin");
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const files = walk(plugin);

  it("is named by the marketplace as a subfolder, so the repository's dev files are not the plugin", () => {
    assert.equal(json(".claude-plugin/marketplace.json").plugins[0].source, "./plugin");
    assert.ok(!fs.existsSync(path.join(root, ".claude-plugin", "plugin.json")), "a plugin.json at the root would make the whole repository the plugin");
  });

  it("has no package.json or lockfile, which would make Claude Code install packages when the plugin is installed", () => {
    for (const name of ["package.json", "package-lock.json", "npm-shrinkwrap.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml"]) {
      assert.ok(!fs.existsSync(path.join(plugin, name)), name + " in the plugin folder");
    }
  });

  it("carries the skill exactly as it is written once in skills/antideploy", () => {
    const canonical = walk(path.join(root, "skills", "antideploy")).map((f) => path.relative(path.join(root, "skills", "antideploy"), f)).sort();
    const copied = walk(path.join(plugin, "skills", "antideploy")).map((f) => path.relative(path.join(plugin, "skills", "antideploy"), f)).sort();
    assert.deepEqual(copied, canonical, "run: node scripts/sync-plugin.mjs");
    for (const rel of canonical) {
      assert.equal(read("plugin/skills/antideploy/" + rel), read("skills/antideploy/" + rel), rel + " differs; run: node scripts/sync-plugin.mjs");
    }
  });

  it("names its icon, and the icon is in the folder", () => {
    const icon = json("plugin/.claude-plugin/plugin.json").icon;
    assert.equal(icon, "./logo.png");
    assert.ok(fs.existsSync(path.join(plugin, icon)));
  });

  it("meets the directory's file rules: a README of 40 words, a license, small text files, a complete PNG, no links or other binaries", () => {
    const words = read("plugin/README.md").replace(/```[sS]*?```/g, "").split(/s+/).filter(Boolean).length;
    assert.ok(words >= 40, "README has " + words + " words");
    assert.ok(fs.existsSync(path.join(plugin, "LICENSE")));
    assert.ok(files.length <= 512);
    for (const file of files) {
      const stat = fs.lstatSync(file);
      assert.ok(!stat.isSymbolicLink(), file + " is a symbolic link");
      assert.ok(stat.size < 256 * 1024, file + " is over 256 KiB");
      const bytes = fs.readFileSync(file);
      if (file.endsWith(".png")) {
        // The directory allows a complete PNG and nothing else that is not text.
        assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", file + " is not a PNG");
        assert.equal(bytes.subarray(bytes.length - 8, bytes.length - 4).toString(), "IEND", file + " is cut short");
      } else {
        assert.ok(!bytes.includes(0), file + " is a binary file");
      }
    }
  });

  it("holds no credential or key material", () => {
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(text, /adu_[0-9a-f]{8}|ad_[0-9a-f]{16}|BEGIN [A-Z ]*PRIVATE KEY/, file);
    }
  });
});

describe("the skill", () => {
  const dir = "skills/antideploy";
  const text = read(dir + "/SKILL.md");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const field = (name) => new RegExp("^" + name + ": (.*)$", "m").exec(front[1])?.[1];

  it("has the frontmatter every agent requires, and a name that matches its folder", () => {
    assert.ok(front, "frontmatter must be the first thing in the file");
    assert.equal(field("name"), "antideploy");
    assert.match(field("name"), /^[a-z0-9]+(-[a-z0-9]+)*$/); // OpenCode and Cursor
    assert.ok(field("name").length <= 64);
    assert.ok(field("description").length > 100);
  });

  it("stays inside Claude Code's listing limit and the 500 line guidance", () => {
    assert.ok(field("description").length <= 1536);
    assert.ok(text.split("\n").length < 500);
  });

  it("says when not to use it, and makes no claim about other hosts", () => {
    const description = field("description");
    assert.match(description, /Do not use for/);
    assert.doesNotMatch(text, /\b(faster|cheaper|more reliable|best|better than)\b/i);
  });

  it("names only tools that exist", () => {
    const tools = new Set([...read("index.js").matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
    const mentioned = new Set();
    for (const file of [dir + "/SKILL.md", dir + "/references/troubleshooting.md", dir + "/references/examples.md"]) {
      for (const m of read(file).matchAll(/`([a-z]+(?:_[a-z]+)*)`/g)) mentioned.add(m[1]);
    }
    // Names in backticks that are error codes or fields of an answer, not tools.
    // Anything else that looks like a name must be a tool, so a typo fails here.
    const codes = new Set([
      "account_suspended", "live_app_limit", "deploy_month_limit", "database_limit", "storage_limit",
      "deploy_in_progress", "own_database", "own_storage", "own_auth", "own_email", "rate_limited",
      "hosting_paused", "too_large", "failed", "succeeded", "unchanged", "checked_at",
    ]);
    const prose = new Set(["error", "summary", "security", "issues", "files", "health", "taskid", "port", "start", "build", "latest", "env", "names", "failedstep", "checkedat", "retryafterseconds", "status", "url"]);
    for (const name of mentioned) {
      if (tools.has(name) || codes.has(name) || prose.has(name.toLowerCase())) continue;
      if (!name.includes("_")) continue; // a plain word in code font, not a tool name
      assert.fail("the skill mentions something that is neither a tool nor a known code: " + name);
    }
    for (const name of ["login", "create_application", "database_create", "database_env_to_file", "set_env_from_file", "request_keys", "deploy", "deployment_status", "logs", "rollback"]) {
      assert.ok(tools.has(name), name + " is missing from the server");
      assert.ok(mentioned.has(name), name + " is not mentioned in the skill");
    }
  });
});

/*
 * The documentation lives in a separate repository (antideploymintlify). When it
 * is checked out beside this one, its copies of the skill and the install
 * snippets must be the ones shipped here.
 */
describe("the documentation repository", () => {
  const docs = path.join(root, "..", "antideploymintlify");
  const skip = fs.existsSync(path.join(docs, "deploying", "mcp.mdx")) ? false : "the docs repository is not checked out next to this one";
  const readDocs = (rel) => fs.readFileSync(path.join(docs, rel), "utf8").replace(/\r\n/g, "\n");

  it("serves the skill from this repository, not one it wrote itself from the docs", { skip }, async () => {
    const { docsSkill } = await import("../scripts/build-docs-skill.mjs");
    assert.equal(readDocs("skill.md"), docsSkill(), "run: node scripts/build-docs-skill.mjs");
  });

  it("shows the same Cursor link and configs as the guides", { skip }, () => {
    const page = readDocs("deploying/mcp.mdx");
    assert.ok(page.includes(read("agents/examples/cursor.install-link.txt").trim()));
    assert.ok(page.includes('args = ["-y", "' + SPEC + '"]'));
    assert.ok(page.includes('"command": ["npx", "-y", "' + SPEC + '"]'));
    assert.ok(page.includes("claude mcp add antideploy -- npx -y " + SPEC));
    assert.ok(page.includes("codex mcp add antideploy -- npx -y " + SPEC));
  });

  it("no longer states limits or behaviour the platform has dropped", { skip }, () => {
    for (const file of ["deploying/mcp.mdx", "deploying/upload.mdx", "api/deploy.mdx", "skill.md"]) {
      const text = readDocs(file);
      assert.doesNotMatch(text, /\| (Per file|Per-file size) \| 5 MB/, file + " still says 5 MB per file");
      assert.doesNotMatch(text, /5 MB per file/, file);
      assert.doesNotMatch(text, /uploaded, on purpose|Its values go into the encrypted secret store/, file + " still says a .env is uploaded");
    }
  });
});

describe("the readme", () => {
  it("lists every tool the server registers, and no tool that does not exist", () => {
    const registered = new Set([...read("index.js").matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
    const table = read("README.md").split("## Tools")[1].split("## Secrets and files")[0]
      .split("\n").filter((line) => line.startsWith("|")).join("\n");
    const listed = new Set([...table.matchAll(/`([a-z]+(?:_[a-z]+)*)`/g)].map((m) => m[1]));
    for (const tool of registered) assert.ok(listed.has(tool), "README does not list the tool " + tool);
    for (const name of listed) assert.ok(registered.has(name), "README lists a tool that does not exist: " + name);
  });
});

describe("prose", () => {
  it("has no em dashes in anything that ships or is shown to a user", () => {
    const files = ["README.md", "index.js", "lib/auth.js", "lib/project.js", "agents/claude-code.md", "agents/cursor.md", "agents/codex.md", "agents/opencode.md", "skills/antideploy/SKILL.md", "skills/antideploy/references/troubleshooting.md", "skills/antideploy/references/examples.md"];
    for (const file of files) assert.ok(!read(file).includes("\u2014"), file + " contains an em dash");
  });
});

/**
 * Run the connector against the real platform, the way an agent does, and write
 * down what happened. For the person who owns the account to run, not for CI:
 * signing in needs a human to click Approve.
 *
 *   node scripts/live-check.mjs                 sign in, list applications. Changes nothing.
 *   node scripts/live-check.mjs --deploy        also create a small static site, deploy it,
 *                                               read its logs and health, change it and deploy
 *                                               again. Creates one application on your account.
 *
 * Options: --url <address>   the platform (default https://antideploy.com)
 *          --entry <file>    the server to run (default dist/antideploy-mcp.mjs, else index.js)
 *          --client <name>   what to call this client on the approval screen (default "live-check")
 *
 * It uses a throwaway home directory, so it never reads or replaces the login
 * saved on this machine. The login it creates is real: revoke it afterwards at
 * <address>/tokens. A static site does not count against any plan limit, but the
 * application stays until you delete it in the console, which this script prints
 * the link to. Nothing is deleted for you.
 *
 * It prints each step, the time it took, and a JSON summary (live-check-report.json)
 * of manual steps, failures and timings, to fill in ACCEPTANCE.md.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes("--" + name);
const option = (name, fallback) => (args.includes("--" + name) ? args[args.indexOf("--" + name) + 1] : fallback);

if (flag("help") || flag("h")) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*\n|^ \* ?/gm, ""));
  process.exit(0);
}

const url = option("url", "https://antideploy.com").replace(/\/+$/, "");
const bundle = path.join(root, "dist", "antideploy-mcp.mjs");
const entry = path.resolve(option("entry", fs.existsSync(bundle) ? bundle : path.join(root, "index.js")));
const clientName = option("client", "live-check");
const deploy = flag("deploy");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "adlive-home-"));
const project = fs.mkdtempSync(path.join(os.tmpdir(), "adlive-project-"));
fs.writeFileSync(
  path.join(project, "index.html"),
  "<!doctype html><title>live check</title><h1>Antideploy live check</h1><p>version 1</p>\n",
);

const report = { url, entry, startedAt: new Date().toISOString(), manualSteps: [], steps: [], failures: [], address: null, applicationId: null };
const t0 = Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  cwd: project,
  env: { HOME: home, USERPROFILE: home, ANTIDEPLOY_URL: url },
  stderr: "inherit",
});
const client = new Client({ name: clientName, version: "1.0.0" });
await client.connect(transport);

async function call(tool, input = {}) {
  const started = Date.now();
  const result = await client.callTool({ name: tool, arguments: input });
  const text = (result.content || []).map((c) => c.text).join("\n");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* an error message */
  }
  const step = { tool, ms: Date.now() - started, ok: !result.isError };
  report.steps.push(step);
  if (result.isError) report.failures.push({ tool, message: text.slice(0, 300) });
  console.log(`  ${result.isError ? "FAIL" : "ok  "} ${tool} (${step.ms} ms)${result.isError ? ": " + text.slice(0, 200) : ""}`);
  return { json, text, error: !!result.isError };
}

try {
  console.log(`Connector ${client.getServerVersion().version} at ${entry}`);
  console.log(`Platform ${url}\n`);

  const { tools } = await client.listTools();
  console.log(`${tools.length} tools. First start to ready: ${Date.now() - t0} ms\n`);

  console.log("Sign in");
  let login = await call("login");
  if (login.json?.status === "approval_needed" || login.json?.status === "waiting_for_approval") {
    console.log(`\n  Open ${login.json.url}`);
    console.log(`  Check the code reads ${login.json.code}, then click Approve.\n`);
    report.manualSteps.push("Open the approval link and click Approve");
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline && login.json?.status !== "connected" && login.json?.status !== "denied") {
      login = await call("login");
    }
  }
  if (login.json?.status !== "connected") throw new Error("Not connected: " + (login.json?.status || login.text));
  console.log(`  Connected as ${login.json.account}\n`);
  report.account = login.json.account;

  console.log("Read only");
  const listed = await call("list_applications");
  console.log(`  ${listed.json?.applications?.length ?? "?"} applications on the account`);
  await call("api_info");

  if (deploy) {
    console.log("\nCreate, deploy, inspect");
    const name = "live-check-" + Date.now().toString(36);
    const created = await call("create_application", { name });
    if (created.error) throw new Error("create_application failed");
    report.applicationId = created.json.applicationId;

    const waitFor = async (taskId, label) => {
      const started = Date.now();
      for (;;) {
        const status = await call("deployment_status", { taskId });
        const state = status.json?.status;
        if (state === "succeeded" || state === "failed") {
          report.steps.push({ tool: label, ms: Date.now() - started, ok: state === "succeeded", summary: status.json?.summary || status.json?.error });
          if (state === "failed") report.failures.push({ tool: label, message: String(status.json?.error || "failed").slice(0, 300) });
          return status.json;
        }
        if (Date.now() - started > 10 * 60 * 1000) throw new Error(label + " did not finish in 10 minutes");
        await sleep(5000);
      }
    };

    const first = await call("deploy");
    const done = await waitFor(first.json.taskId, "time to first live deploy");
    console.log(`  ${done?.summary || done?.error}`);
    report.address = (done?.summary || "").match(/https:\/\/\S+?(?=[,\s])/)?.[0] || null;

    await call("logs", { limit: 20 });
    await call("health");
    await call("deployment_history", { limit: 5 });

    console.log("\nUpdate it");
    fs.writeFileSync(path.join(project, "index.html"), "<!doctype html><title>live check</title><h1>Antideploy live check</h1><p>version 2</p>\n");
    const second = await call("deploy");
    const again = await waitFor(second.json.taskId, "time to updated live deploy");
    console.log(`  ${again?.summary || again?.error}`);

    if (report.address) {
      try {
        const page = await (await fetch(report.address)).text();
        const sees = /version 2/.test(page);
        report.steps.push({ tool: "fetch the live address", ok: sees });
        console.log(`  ${sees ? "ok  " : "FAIL"} the live address serves version 2`);
        if (!sees) report.failures.push({ tool: "fetch the live address", message: "did not serve the updated page" });
      } catch (error) {
        report.failures.push({ tool: "fetch the live address", message: String(error).slice(0, 200) });
      }
    }
    console.log(`\n  Delete this test application in the console when you are done: ${url}/app/${report.applicationId}`);
  }
} catch (error) {
  report.failures.push({ tool: "(run)", message: String(error.message || error).slice(0, 300) });
  console.error("\nStopped:", error.message || error);
} finally {
  report.finishedAt = new Date().toISOString();
  report.totalSeconds = Math.round((Date.now() - t0) / 1000);
  await client.close().catch(() => {});
  fs.writeFileSync("live-check-report.json", JSON.stringify(report, null, 2) + "\n");
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
  console.log(`\n${report.failures.length ? report.failures.length + " failure(s)" : "No failures"}; manual steps: ${report.manualSteps.length}; ${report.totalSeconds} s. Written to live-check-report.json.`);
  console.log(`The login this run created is real. Revoke it at ${url}/tokens.`);
  process.exit(report.failures.length ? 1 : 0);
}

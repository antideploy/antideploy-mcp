import { spawn } from "node:child_process";
import fs from "node:fs";

const key = fs.readFileSync(process.argv[2], "utf8").trim();
const dir = process.argv[3];

const child = spawn(process.execPath, ["index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, ANTIDEPLOY_API_KEY: key },
});
let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
let id = 0;
const send = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
const call = async (name, args = {}) => {
  const out = await send("tools/call", { name, arguments: args });
  const text = out.result?.content?.[0]?.text ?? JSON.stringify(out.error);
  try { return JSON.parse(text); } catch { return { raw: text }; }
};

await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "h", version: "0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

console.log("=== deploy ===");
const dep = await call("deploy", { directory: dir });
console.log(JSON.stringify(dep, null, 2).slice(0, 900));

const taskId = dep.taskId;
if (!taskId) { console.log("\nno taskId; stopping."); child.kill(); process.exit(1); }

console.log("\n=== polling deployment_status ===");
let last = "";
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = await call("deployment_status", { taskId });
  const line = `${st.status ?? "?"}  step=${st.step ?? st.currentStep ?? "-"}`;
  if (line !== last) { console.log(`  [${(i + 1) * 5}s] ${line}`); last = line; }
  if (st.status === "succeeded" || st.status === "failed") {
    console.log("\n=== final ===");
    console.log(JSON.stringify(st, null, 2).slice(0, 2500));
    break;
  }
}
child.kill();

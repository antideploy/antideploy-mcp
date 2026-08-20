import { spawn } from "node:child_process";
import fs from "node:fs";

const key = fs.readFileSync(process.argv[2], "utf8").trim();
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

await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "h", version: "0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

for (const name of ["api_info", "list_env"]) {
  const out = await send("tools/call", { name, arguments: {} });
  const text = out.result?.content?.[0]?.text ?? JSON.stringify(out.error);
  console.log(`\n===== ${name} =====`);
  console.log(text.length > 1500 ? text.slice(0, 1500) + "\n  …truncated" : text);
}
child.kill();

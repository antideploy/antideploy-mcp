import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ANTIDEPLOY_API_KEY: "ad_test_not_a_real_key" },
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch {}
  }
});
child.stderr.on("data", (d) => process.stderr.write("[stderr] " + d));

let id = 0;
const send = (method, params) =>
  new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msgId, method, params }) + "\n");
  });

const init = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "harness", version: "0" },
});
console.log("initialize ->", init.result?.serverInfo, "| protocol", init.result?.protocolVersion);
console.log("instructions present:", Boolean(init.result?.instructions));

child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const tools = await send("tools/list", {});
console.log("\ntools:");
for (const t of tools.result.tools) {
  const req = t.inputSchema?.required || [];
  const props = Object.keys(t.inputSchema?.properties || {});
  console.log(`  ${t.name.padEnd(20)} args: [${props.join(", ")}] required: [${req.join(", ")}]`);
}

const bad = await send("tools/call", { name: "deployment_status", arguments: { taskId: "nope" } });
const text = bad.result?.content?.[0]?.text || JSON.stringify(bad.error);
console.log("\nauth/error path ->", String(text).slice(0, 140).replace(/\n/g, " "));

child.kill();

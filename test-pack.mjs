import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { Readable } from "node:stream";

// --- a project with exactly the things that should and should not travel ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adtest-"));
const write = (rel, body) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
write("index.js", "console.log(1)");
write("package.json", "{}");
write("public/app.css", "body{}");
write(".env", "API_KEY=shhh");
write(".env.example", "API_KEY=");
write("node_modules/left-pad/index.js", "// must not travel");
write(".git/config", "// must not travel");
write("server.pem", "// must not travel");
write(".DS_Store", "junk");

let received = null;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const form = await new Response(body, { headers: { "content-type": req.headers["content-type"] } }).formData();
  const archive = form.get("archive");
  const names = [];
  await new Promise((resolve, reject) => {
    Readable.from(Buffer.from(archive instanceof Blob ? Buffer.from(new Uint8Array()) : new Uint8Array()));
    resolve();
  });
  const buf = Buffer.from(await archive.arrayBuffer());
  const tmp = path.join(os.tmpdir(), "adtest-arc.tar.gz");
  fs.writeFileSync(tmp, buf);
  await tar.t({ file: tmp, onReadEntry: (e) => names.push(e.path) });
  received = { names: names.sort(), env: form.get("env"), bytes: buf.length };
  res.writeHead(202, { "content-type": "application/json" });
  res.end(JSON.stringify({ taskId: "t_local", watch: "http://localhost/watch" }));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const child = spawn(process.execPath, ["index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, ANTIDEPLOY_API_KEY: "ad_fake", ANTIDEPLOY_URL: `http://localhost:${port}` },
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
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });

await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "h", version: "0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const out = await send("tools/call", { name: "deploy", arguments: { directory: dir, env: { EXTRA: "1" } } });
console.log("tool result:", (out.result?.content?.[0]?.text || JSON.stringify(out.error)).slice(0, 300));

console.log("\narchive contained:");
for (const n of received.names) console.log("   " + n);

const must = ["index.js", "package.json", "public/app.css", ".env", ".env.example"];
const mustNot = ["node_modules/left-pad/index.js", ".git/config", "server.pem", ".DS_Store"];
const has = (n) => received.names.some((x) => x.replace(/^\.\//, "") === n);
console.log("\nincluded as required:", must.every(has) ? "PASS" : "FAIL " + must.filter((n) => !has(n)));
console.log("excluded as required:", mustNot.every((n) => !has(n)) ? "PASS" : "FAIL " + mustNot.filter(has));
console.log("env part forwarded:", received.env);

child.kill(); server.close(); fs.rmSync(dir, { recursive: true, force: true });

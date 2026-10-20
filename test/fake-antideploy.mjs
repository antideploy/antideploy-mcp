/**
 * A stand-in for the Antideploy API, for testing this package without the
 * platform. It follows the behaviour the platform documents at GET /api/v1 and
 * the rules in its source (src/lib/caller.ts, src/app/api/v1/*):
 *
 *  - the device flow, where a token is handed out once
 *  - account tokens (adu_) must name the application; project keys (ad_) are
 *    bound to one and cannot create applications or read connection variables
 *  - a deploy is a multipart upload of a tar, and real .env files never arrive
 *
 * It is not the platform. What it proves is that this package speaks the
 * contract; whether the real platform keeps that contract is checked by the
 * acceptance run in ACCEPTANCE.md.
 */

import http from "node:http";
import crypto from "node:crypto";
import * as tar from "tar";

const rand = (n = 16) => crypto.randomBytes(n).toString("hex");
const uuid = () => crypto.randomUUID();

export async function startFake() {
  const state = {
    codes: new Map(), // deviceCode -> { userCode, clientName, approved, denied, redeemed }
    accountTokens: new Map(), // token -> userId
    projectKeys: new Map(), // key -> applicationId
    applications: [], // { applicationId, name, subdomain, userId }
    deploys: [], // what each upload carried
    tasks: new Map(), // taskId -> polls
    secrets: new Map(), // applicationId -> Map(name -> value)
    databases: new Set(),
    calls: [], // { method, path, applicationId, credential }
    approveNext: false,
  };

  const account = { label: "tester@example.com (signs in with GitHub)", email: "tester@example.com" };
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const text = (res, status, body) => {
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const ctype = req.headers["content-type"] || "";
    const route = req.method + " " + url.pathname;

    /* test controls, not part of the API */
    if (url.pathname === "/__control/approve") {
      for (const c of state.codes.values()) if (c.userCode === url.searchParams.get("code")) c.approved = true;
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/__control/deny") {
      for (const c of state.codes.values()) if (c.userCode === url.searchParams.get("code")) c.denied = true;
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/__control/revoke-all") {
      state.accountTokens.clear();
      return json(res, 200, { ok: true });
    }

    /* unauthenticated */
    if (route === "GET /api/v1") {
      return json(res, 200, {
        name: "Antideploy API",
        version: "v1",
        limits: { maxFiles: 4000, maxFileBytes: 29360128, maxTotalBytes: 29360128 },
      });
    }
    if (route === "POST /api/v1/device/code") {
      const body = JSON.parse(raw.toString() || "{}");
      const deviceCode = "dc_" + rand(12);
      const userCode = (rand(2) + "-" + rand(2)).toUpperCase();
      state.codes.set(deviceCode, { userCode, clientName: body.clientName, approved: false, denied: false, redeemed: false });
      return json(res, 201, {
        deviceCode,
        userCode,
        verificationUri: "http://localhost/activate",
        verificationUriComplete: "http://localhost/activate?code=" + userCode,
        expiresIn: 900,
        interval: 2,
      });
    }
    if (route === "POST /api/v1/device/token") {
      const body = JSON.parse(raw.toString() || "{}");
      const code = state.codes.get(body.deviceCode);
      if (!code || code.redeemed) return json(res, 400, { error: "expired_token", code: "expired_token" });
      if (code.denied) return json(res, 400, { error: "access_denied", code: "access_denied" });
      if (!code.approved) return json(res, 400, { error: "authorization_pending", code: "authorization_pending" });
      code.redeemed = true;
      const token = "adu_" + rand(20);
      state.accountTokens.set(token, "user-1");
      return json(res, 200, { token, tokenType: "Bearer", account });
    }

    /* authenticated */
    const presented = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "")?.[1];
    const isAccount = presented && state.accountTokens.has(presented);
    const keyApp = presented && state.projectKeys.get(presented);
    if (!isAccount && !keyApp) {
      return json(res, 401, { error: "Unknown or revoked credential.", code: "unauthorized" });
    }
    let jsonBody = null;
    if (ctype.includes("application/json") && raw.length) {
      try {
        jsonBody = JSON.parse(raw.toString());
      } catch {
        /* leave null */
      }
    }

    /* The same rule as forApplication() in the platform. */
    const resolveApp = () => {
      const named = url.searchParams.get("applicationId") || (jsonBody && jsonBody.applicationId) || null;
      if (keyApp) {
        if (named && named !== keyApp) return { error: [404, { error: "No such application.", code: "not_found" }] };
        return { applicationId: keyApp };
      }
      if (!named) {
        return {
          error: [400, { error: "This token belongs to an account rather than one application, so the request has to say which application it is for.", code: "application_required" }],
        };
      }
      if (!state.applications.some((a) => a.applicationId === named)) {
        return { error: [404, { error: "No such application.", code: "not_found" }] };
      }
      return { applicationId: named };
    };
    state.calls.push({
      method: req.method,
      path: url.pathname,
      applicationId: url.searchParams.get("applicationId") || (jsonBody && jsonBody.applicationId) || null,
      credential: isAccount ? "account" : "project",
    });

    if (route === "GET /api/v1/applications") {
      const apps = isAccount ? state.applications : state.applications.filter((a) => a.applicationId === keyApp);
      return json(res, 200, {
        account,
        applications: apps.map(({ applicationId, name, subdomain }) => ({ applicationId, name, subdomain, sourceType: "push" })),
      });
    }
    if (route === "POST /api/v1/applications") {
      if (!isAccount) {
        return json(res, 403, { error: "A project key can only act on its own application.", code: "account_token_required" });
      }
      const name = String(jsonBody?.name || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
      if (!name) return json(res, 400, { error: "Send a name.", code: "bad_request" });
      const clash = state.applications.find((a) => a.name === name);
      if (clash) {
        return json(res, 409, { error: "You already have a project called " + name + ".", code: "name_taken", applicationId: clash.applicationId, account });
      }
      const application = { applicationId: uuid(), name, subdomain: jsonBody?.subdomain || null, userId: "user-1" };
      state.applications.push(application);
      return json(res, 201, { ...application, account, dashboard: "http://localhost/app/" + application.applicationId });
    }
    if (route === "GET /api/v1/hostnames/check") {
      return json(res, 200, { label: url.searchParams.get("label"), available: true });
    }

    /* the deployment status route is by task id, not by application */
    const taskMatch = /^\/api\/v1\/deployments\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && taskMatch) {
      const polls = (state.tasks.get(taskMatch[1]) ?? 0) + 1;
      state.tasks.set(taskMatch[1], polls);
      return json(res, 200, polls < 2
        ? { status: "building", account }
        : { status: "succeeded", account, summary: "demo is live at https://demo.antideploy.app, on the Antideploy account " + account.label });
    }

    const resolved = resolveApp();
    if (resolved.error) return json(res, resolved.error[0], resolved.error[1]);
    const { applicationId } = resolved;

    if (route === "POST /api/v1/deploy") {
      const form = await new Response(raw, { headers: { "content-type": ctype } }).formData();
      const archive = form.get("archive");
      const bytes = Buffer.from(await archive.arrayBuffer());
      const names = [];
      await new Promise((resolve, reject) => {
        const parser = new tar.Parser();
        parser.on("entry", (entry) => {
          names.push(entry.path.replace(/^\.\//, ""));
          entry.resume();
        });
        parser.on("end", resolve);
        parser.on("error", reject);
        parser.end(bytes);
      });
      const env = form.get("env") ? JSON.parse(form.get("env")) : null;
      state.deploys.push({ applicationId, names: names.sort(), env, archiveBytes: bytes.length, credential: isAccount ? "account" : "project" });
      const taskId = "task_" + state.deploys.length;
      return json(res, 202, { status: "queued", taskId, applicationId, fileCount: names.length, files: names.slice(0, 50), account, watch: "http://localhost/api/v1/deployments/" + taskId });
    }
    if (route === "POST /api/v1/database") {
      state.databases.add(applicationId);
      return json(res, 201, { status: "ready", account });
    }
    if (route === "GET /api/v1/database/env") {
      if (!isAccount) return json(res, 403, { error: "A project key cannot read a connection string.", code: "account_token_required" });
      if (!state.databases.has(applicationId)) return json(res, 404, { error: "No database yet.", code: "not_found" });
      return text(res, 200, "DATABASE_URL='postgres://user:secretpw@db.example.com/app'\nPGHOST='db.example.com'\nPGPASSWORD='secretpw'\n");
    }
    if (route === "PUT /api/v1/secrets") {
      const map = state.secrets.get(applicationId) ?? new Map();
      for (const [k, v] of Object.entries(jsonBody?.env || {})) map.set(k, v);
      state.secrets.set(applicationId, map);
      return json(res, 200, { stored: Object.keys(jsonBody?.env || {}).length });
    }
    if (route === "GET /api/v1/secrets") {
      return json(res, 200, { keys: [...(state.secrets.get(applicationId)?.keys() ?? [])] });
    }
    if (route === "DELETE /api/v1/secrets") {
      state.secrets.get(applicationId)?.delete(url.searchParams.get("key"));
      return json(res, 200, { removed: url.searchParams.get("key") });
    }
    if (route === "POST /api/v1/secrets/request") {
      const names = jsonBody?.names || [];
      const set = state.secrets.get(applicationId) ?? new Map();
      return json(res, 200, { url: "http://localhost/app/" + applicationId + "/secrets?names=" + names.join(","), names, alreadySet: names.filter((n) => set.has(n)) });
    }
    if (route === "POST /api/v1/redeploy" || route === "POST /api/v1/rollback") {
      return json(res, 202, { status: "queued", taskId: "task_x" + state.calls.length, applicationId });
    }
    if (route === "GET /api/v1/deployments") return json(res, 200, { deployments: [{ id: "d1", status: "live", url: "https://demo.antideploy.app" }] });
    if (route === "GET /api/v1/logs") return json(res, 200, { lines: ["listening on 8080"] });
    if (route === "GET /api/v1/health") return json(res, 200, { state: "healthy", checkedAt: new Date().toISOString() });
    if (route === "GET /api/v1/metrics") return json(res, 200, { requests: 3 });
    if (req.method === "GET" && url.pathname === "/api/v1/applications/" + applicationId) {
      return json(res, 200, { applicationId, subdomain: "demo", deployOnPush: false });
    }

    return json(res, 404, { error: "The stand-in server has no route " + route, code: "not_found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    url: "http://127.0.0.1:" + port,
    host: "127.0.0.1:" + port,
    state,
    /** A project key bound to a new application, as the console would issue one. */
    issueProjectKey(name = "keyed-app") {
      const applicationId = uuid();
      state.applications.push({ applicationId, name, subdomain: null, userId: "user-1" });
      const key = "ad_" + rand(16);
      state.projectKeys.set(key, applicationId);
      return { key, applicationId };
    },
    async approve(userCode) {
      await fetch(this.url + "/__control/approve?code=" + userCode);
    },
    async deny(userCode) {
      await fetch(this.url + "/__control/deny?code=" + userCode);
    },
    async revokeAll() {
      await fetch(this.url + "/__control/revoke-all");
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

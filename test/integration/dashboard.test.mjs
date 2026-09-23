import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { openDatabase, createWriter } from "../../src/telemetry/store.mjs";
import { databasePath } from "../../src/telemetry/config.mjs";
import { startDashboard } from "../../src/dashboard/server.mjs";

const require = createRequire(import.meta.url);
let driver = null;
try {
  driver = require("better-sqlite3");
} catch {}
const needsDriver = { skip: driver ? false : "better-sqlite3 is not installed" };
const CLI = fileURLToPath(new URL("../../bin/jev.mjs", import.meta.url));
const NOW = 1_700_000_000_000;
const CANARY = "PROMPT-CANARY-7f3a";
const SECRET = "sk-ant-api03-DASHBOARDSECRETSHOULDNEVERAPPEAR";
const INJECTION = "<img src=x onerror=alert(1)><script>alert(2)</script>";

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "jev-dashboard-"));
  const project = join(root, "project");
  const data = join(root, "data");
  mkdirSync(project);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, data, env: { ...process.env, JEV_DATA_DIR: data, JEV_API_KEY: SECRET } };
}

function seed({ data }, entries) {
  const { db } = openDatabase(databasePath({ JEV_DATA_DIR: data }), { driver });
  createWriter(db).applyBatch(entries);
  db.close();
}

const session = (id, projectPath, startedAt = NOW) => ({
  kind: "session",
  row: {
    id,
    claudeSessionId: `claude-${id}`,
    projectPath,
    startedAt,
    endedAt: startedAt + 5000,
    routerVersion: "0.3.0",
    claudeVersion: null,
    launchMode: "cli",
    jevProvider: "mock",
  },
});
const actor = (id, sessionId, over = {}) => ({
  kind: "actor",
  row: {
    id,
    sessionId,
    parentActorId: null,
    actorType: "main",
    agentName: null,
    createdAt: NOW,
    lastSeenAt: NOW,
    ...over,
  },
});
const route = (id, sessionId, actorId, over = {}) => ({
  kind: "route",
  row: {
    id,
    sessionId,
    actorId,
    logicalTurnId: `turn-${id}`,
    timestamp: NOW,
    classification: "main_fresh",
    source: "jev",
    provider: "mock",
    jevDecisionId: `decision-${id}`,
    recommendedProfile: "opus-high",
    effectiveProfile: "opus-high",
    model: "claude-opus-5",
    tier: "strong",
    requestedEffort: "high",
    effectiveEffort: "high",
    confidence: 0.9,
    fallbackReason: null,
    normalizationJson: "[]",
    jevLatencyMs: 20,
    jevInputTokens: 10,
    jevOutputTokens: 2,
    jevCostUsd: 0.0002,
    requestHash: "hash",
    promptPreview: CANARY,
    ...over,
  },
});
const request = (id, sessionId, actorId, routeId, over = {}) => ({
  kind: "request",
  row: {
    id,
    sessionId,
    actorId,
    routeId,
    timestamp: NOW,
    classification: "main_fresh",
    isContinuation: 0,
    model: "claude-opus-5",
    effort: "high",
    requestBytes: 100,
    responseBytes: 200,
    latencyMs: 30,
    httpStatus: 200,
    success: 1,
    ...over,
  },
});
const usage = (requestId, over = {}) => ({
  kind: "usage",
  row: {
    requestId,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 70,
    cacheCreationInputTokens: 5,
    rawUsageJson: "{}",
    ...over,
  },
});

/** Session s1: main + a subagent with an unrecorded parent + one with a missing parent, 60 routes. */
function populated(t) {
  const space = workspace(t);
  const entries = [
    session("s1", space.project),
    session("s2", space.project, NOW - 60_000),
    actor("a1", "s1"),
    actor("sub", "s1", { actorType: "subagent", agentName: INJECTION, parentActorId: "a1" }),
    actor("orphan", "s1", { actorType: "subagent", agentName: "Explore" }),
    actor("lost", "s1", { actorType: "subagent", agentName: "Plan", parentActorId: "gone" }),
    actor("a2", "s2"),
  ];
  for (let index = 0; index < 60; index++) {
    const id = `r${String(index).padStart(2, "0")}`;
    entries.push(route(id, "s1", index % 7 === 0 ? "sub" : "a1", {
      timestamp: NOW + index,
      model: index % 3 === 0 ? "claude-haiku-4" : "claude-opus-5",
      effectiveProfile: index % 3 === 0 ? "haiku-default" : "opus-high",
      effectiveEffort: index % 3 === 0 ? null : "high",
      jevCostUsd: index === 5 ? null : 0.0002,
      source: index === 9 ? "fallback" : "jev",
      fallbackReason: index === 9 ? "timeout" : null,
      normalizationJson: index % 10 === 0 ? JSON.stringify(["effort xhigh -> high"]) : "[]",
    }));
    entries.push(request(`q${index}`, "s1", "a1", id));
    if (index % 4 !== 0) entries.push(usage(`q${index}`, index % 8 === 1 ? { cacheCreationInputTokens: null } : {}));
  }
  entries.push(request("qc", "s1", "a1", "r01", { classification: "main_continuation", isContinuation: 1 }));
  entries.push(route("x1", "s2", "a2"));
  seed(space, entries);
  return space;
}

function get(base, path, { method = "GET", headers = {} } = {}) {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function serve(t, space) {
  const dashboard = await startDashboard({ env: space.env, cwd: space.project });
  t.after(() => dashboard.close());
  return dashboard.url;
}

function cli(space, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: space.project,
    env: space.env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("summary is identical to jev stats --json for the same session", needsDriver, async (t) => {
  const space = populated(t);
  const base = await serve(t, space);
  const api = await get(base, "/api/v1/sessions/s1/summary");
  assert.equal(api.status, 200);
  const stats = cli(space, ["stats", "--session", "s1", "--json"]);
  // `period.endedAt` uses "now" only for active sessions; both sessions here have ended.
  assert.deepEqual(api.json, stats);
  assert.equal(api.json.jev.costComplete, false, "a route without cost stays visible as partial");
  assert.equal(api.json.usage.complete, false);
  assert.ok(api.json.models.length === 2);
  assert.deepEqual(api.json.rewrites, [{ note: "effort xhigh -> high", routes: 6 }]);
});

test("routes paginate newest-first and match jev routes --json", needsDriver, async (t) => {
  const space = populated(t);
  const base = await serve(t, space);
  const cliRoutes = cli(space, ["routes", "--session", "s1", "--json"]).routes;
  const first = (await get(base, "/api/v1/sessions/s1/routes")).json;
  assert.deepEqual(first.page, { limit: 50, offset: 0, total: 60 });
  assert.equal(first.routes.length, 50);
  const second = (await get(base, "/api/v1/sessions/s1/routes?limit=50&offset=50")).json;
  assert.equal(second.routes.length, 10);
  assert.deepEqual([...first.routes, ...second.routes], [...cliRoutes].reverse());
  assert.equal((await get(base, "/api/v1/sessions/s1/routes?limit=201")).json.code, "invalid_parameter");
  assert.equal((await get(base, "/api/v1/sessions/s1/routes?offset=-1")).status, 400);
  assert.equal((await get(base, "/api/v1/sessions/s1/routes?limit=abc")).status, 400);
});

test("sessions list pages with a total and resolves the current session", needsDriver, async (t) => {
  const space = populated(t);
  const base = await serve(t, space);
  const page = (await get(base, "/api/v1/sessions?limit=1&offset=1")).json;
  assert.deepEqual(page.page, { limit: 1, offset: 1, total: 2 });
  assert.equal(page.sessions[0].id, "s2");
  assert.equal(page.current.id, "s1");
  assert.equal(page.current.source, "most_recent");
});

test("usage groups add up to totals and keep partial usage visible", needsDriver, async (t) => {
  const space = populated(t);
  const base = await serve(t, space);
  const report = (await get(base, "/api/v1/sessions/s1/usage")).json;
  assert.equal(report.kind, "usage");
  const stats = cli(space, ["stats", "--session", "s1", "--json"]);
  for (const key of ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "requestsMissingUsage", "requests", "complete"]) {
    assert.equal(report.totals[key], stats.usage[key], key);
  }
  for (const key of ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "requests"]) {
    assert.equal(report.byProfile.reduce((n, row) => n + (row[key] ?? 0), 0), report.totals[key], key);
  }
});

test("actor tree shows unrecorded and missing parents honestly", needsDriver, async (t) => {
  const space = populated(t);
  const base = await serve(t, space);
  const report = (await get(base, "/api/v1/sessions/s1/actors")).json;
  assert.deepEqual(report.tree.roots.map(({ id }) => id), ["a1"]);
  assert.deepEqual(report.tree.roots[0].children.map(({ id }) => id), ["sub"]);
  assert.equal(report.tree.roots[0].children[0].agentName, INJECTION, "labels are data, rendered as text");
  assert.deepEqual(report.tree.parentNotRecorded.map(({ id }) => id), ["orphan"]);
  assert.deepEqual(report.tree.parentMissing.map(({ id }) => id), ["lost"]);
});

test("static assets are served from the allowlist with security headers and no CORS", needsDriver, async (t) => {
  const space = populated(t);
  const base = await serve(t, space);
  for (const [path, type] of [["/", /text\/html/], ["/app.js", /javascript/], ["/format.js", /javascript/], ["/app.css", /text\/css/]]) {
    const res = await get(base, path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers["content-type"], type);
    assert.match(res.headers["content-security-policy"], /default-src 'none'/);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.equal(res.headers["cross-origin-resource-policy"], "same-origin");
  }
  for (const path of ["/../package.json", "/%2e%2e/package.json", "/server.mjs", "/public/app.js", "/api/v2/status", "/api/v1/unknown"]) {
    assert.equal((await get(base, path)).status, 404, path);
  }
  const headers = { Origin: "http://127.0.0.1:1" };
  for (const path of ["/", "/api/v1/status", "/api/v1/sessions"]) {
    const res = await get(base, path, { headers });
    assert.ok(!Object.keys(res.headers).some((key) => key.startsWith("access-control-")), path);
  }
  const head = await get(base, "/api/v1/status", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
});

test("non-loopback Host or Origin is refused and write methods are rejected", needsDriver, async (t) => {
  const space = populated(t);
  const base = await serve(t, space);
  for (const host of ["evil.test", "evil.test:80", "127.0.0.1.evil.test", "192.168.1.2"]) {
    const res = await get(base, "/api/v1/sessions", { headers: { Host: host } });
    assert.equal(res.status, 403, host);
    assert.equal(res.json.code, "forbidden");
  }
  for (const origin of ["https://evil.test", "null", "http://localhost.evil.test"]) {
    assert.equal((await get(base, "/api/v1/sessions", { headers: { Origin: origin } })).status, 403, origin);
  }
  assert.equal((await get(base, "/", { headers: { Host: "localhost:9" } })).status, 200);
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
    const res = await get(base, "/api/v1/sessions", { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, "GET, HEAD");
    assert.ok(!Object.keys(res.headers).some((key) => key.startsWith("access-control-")));
  }
});

test("no secret or prompt content appears in any response", needsDriver, async (t) => {
  const space = populated(t);
  const base = await serve(t, space);
  const paths = [
    "/", "/app.js", "/format.js", "/app.css", "/api/v1/status", "/api/v1/sessions",
    ...["summary", "actors", "routes", "usage"].map((view) => `/api/v1/sessions/s1/${view}`),
  ];
  for (const path of paths) {
    const { body } = await get(base, path);
    assert.ok(!body.includes(CANARY), `${path} leaks prompt content`);
    assert.ok(!body.includes(SECRET), `${path} leaks a credential`);
    assert.ok(!/promptPreview|requestHash/.test(body), `${path} exposes prompt-derived fields`);
  }
});

test("unknown and deleted sessions are 404, not a fallback", needsDriver, async (t) => {
  const space = populated(t);
  const base = await serve(t, space);
  const missing = await get(base, "/api/v1/sessions/nope/summary");
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { ok: false, code: "not_found", message: "Session not found." });
  const db = new driver(databasePath({ JEV_DATA_DIR: space.data }));
  db.pragma("foreign_keys = OFF");
  for (const table of ["usage_events", "inference_requests", "routes", "actors"]) {
    db.prepare(`DELETE FROM ${table} WHERE ${table === "usage_events" ? "request_id IN (SELECT id FROM inference_requests WHERE session_id = 's2')" : "session_id = 's2'"}`).run();
  }
  db.prepare("DELETE FROM sessions WHERE id = 's2'").run();
  db.close();
  for (const view of ["summary", "actors", "routes", "usage"]) {
    assert.equal((await get(base, `/api/v1/sessions/s2/${view}`)).status, 404, view);
  }
});

test("empty, missing and unreadable databases are distinct states", needsDriver, async (t) => {
  const space = workspace(t);
  const base = await serve(t, space);
  const status = (await get(base, "/api/v1/status")).json;
  assert.equal(status.database, "missing");
  const sessions = await get(base, "/api/v1/sessions");
  assert.equal(sessions.status, 503);
  assert.equal(sessions.json.code, "telemetry_unavailable");

  seed(space, []);
  assert.equal((await get(base, "/api/v1/status")).json.database, "available");
  const empty = (await get(base, "/api/v1/sessions")).json;
  assert.deepEqual(empty.sessions, []);
  assert.equal(empty.page.total, 0);
  assert.equal(empty.current.id, null);

  const broken = workspace(t);
  mkdirSync(broken.data);
  writeFileSync(databasePath({ JEV_DATA_DIR: broken.data }), "not a sqlite database at all");
  const brokenBase = await serve(t, broken);
  const unreadable = await get(brokenBase, "/api/v1/sessions");
  assert.ok([500, 503].includes(unreadable.status));
  assert.ok(["telemetry_read_failed", "telemetry_unavailable"].includes(unreadable.json.code));
});

test("a legacy schema yields a redacted telemetry_read_failed error", needsDriver, async (t) => {
  const space = workspace(t);
  mkdirSync(space.data);
  const db = new driver(databasePath({ JEV_DATA_DIR: space.data }));
  db.exec("CREATE TABLE legacy_only (id TEXT)");
  db.close();
  const base = await serve(t, space);
  const res = await get(base, "/api/v1/sessions");
  assert.equal(res.status, 500);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.code, "telemetry_read_failed");
});

test("jev dashboard prints a URL, serves, and exits 0 on SIGTERM without touching the DB", needsDriver, async (t) => {
  const space = populated(t);
  const file = databasePath({ JEV_DATA_DIR: space.data });
  const before = readFileSync(file);
  const child = spawn(process.execPath, [CLI, "dashboard"], {
    cwd: space.project,
    env: space.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  const url = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+\//.exec(out);
      if (match) resolve(match[0]);
    });
    child.once("exit", (code) => reject(new Error(`exited early with ${code}`)));
  });
  const res = await get(url, "/api/v1/sessions/s1/summary");
  assert.equal(res.status, 200);
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  assert.deepEqual(await exit, { code: 0, signal: null });
  assert.ok(readFileSync(file).equals(before), "the dashboard must not modify the database");
});

test("jev dashboard rejects a bad port and documents itself in help", () => {
  const bad = spawnSync(process.execPath, [CLI, "dashboard", "--port", "x"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--port/);
  const help = spawnSync(process.execPath, [CLI, "dashboard", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /jev dashboard \[--port <n>\]/);
});

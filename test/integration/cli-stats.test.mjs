import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { openDatabase, createWriter } from "../../src/telemetry/store.mjs";
import { databasePath } from "../../src/telemetry/config.mjs";

const require = createRequire(import.meta.url);
let driver = null;
try {
  driver = require("better-sqlite3");
} catch {}
const needsDriver = { skip: driver ? false : "better-sqlite3 is not installed" };
const CLI = fileURLToPath(new URL("../../bin/jev.mjs", import.meta.url));
const NOW = 1_700_000_000_000;

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "jev-cli-stats-"));
  const project = join(root, "project");
  const data = join(root, "data");
  mkdirSync(project);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, data, env: { ...process.env, JEV_DATA_DIR: data } };
}

function seed({ data }, entries) {
  const env = { JEV_DATA_DIR: data };
  const { db } = openDatabase(databasePath(env), { driver });
  createWriter(db).applyBatch(entries);
  db.close();
}

const session = (id, projectPath, endedAt = NOW + 5000) => ({
  kind: "session",
  row: {
    id,
    claudeSessionId: `claude-${id}`,
    projectPath,
    startedAt: NOW,
    endedAt,
    routerVersion: "0.3.0",
    claudeVersion: null,
    launchMode: "cli",
    jevProvider: "mock",
  },
});
const actor = (id, sessionId, actorType = "main") => ({
  kind: "actor",
  row: {
    id,
    sessionId,
    parentActorId: null,
    actorType,
    agentName: actorType === "subagent" ? "Explore" : null,
    createdAt: NOW,
    lastSeenAt: NOW,
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
    promptPreview: null,
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
const usage = (requestId) => ({
  kind: "usage",
  row: {
    requestId,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 70,
    cacheCreationInputTokens: 5,
    rawUsageJson: "{}",
  },
});

function populated(t, { endedAt = NOW + 5000 } = {}) {
  const space = workspace(t);
  seed(space, [
    session("s1", space.project, endedAt),
    actor("a1", "s1"),
    route("r1", "s1", "a1"),
    request("q1", "s1", "a1", "r1"),
    request("q2", "s1", "a1", "r1", {
      classification: "main_continuation",
      isContinuation: 1,
    }),
    usage("q1"),
  ]);
  return space;
}

function run(space, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: space.project,
    env: { ...space.env, ...env },
    encoding: "utf8",
  });
}

test("help documents stats, routes, privacy, and cost semantics", () => {
  const result = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /jev stats/);
  assert.match(result.stdout, /jev routes/);
  assert.match(result.stdout, /never contact Jev/);
  assert.match(result.stdout, /subscription usage/);
});

test("missing or disabled telemetry is a clean read-only error", needsDriver, (t) => {
  const space = workspace(t);
  const human = run(space, ["stats"]);
  assert.equal(human.status, 1);
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /No readable telemetry/);
  const json = run(space, ["stats", "--json"], { JEV_ENABLE_TELEMETRY: "0" });
  assert.equal(JSON.parse(json.stdout).code, "telemetry_unavailable");
  assert.equal(json.stderr, "");
});

test("stats JSON is deterministic, separates continuations, and needs no provider credentials", needsDriver, (t) => {
  const space = populated(t);
  const result = run(space, ["stats", "--session", "s1", "--json"], {
    JEV_PROVIDER: "definitely-invalid",
    JEV_API_KEY: "",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.scope.id, "s1");
  assert.equal(report.routes[0].freshRoutes, 1);
  assert.equal(report.actors.continuations, 1);
  assert.equal(report.usage.requestsMissingUsage, 1);
  assert.equal(report.usage.complete, false);
  assert.equal(report.jev.actualRoutingCostUsd, 0.0002);
});

test("human stats labels partial usage and subscription semantics", needsDriver, (t) => {
  const result = run(populated(t), ["stats", "--session", "s1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Routes \(fresh decisions\)/);
  assert.match(result.stdout, /partial\/unknown/);
  assert.match(result.stdout, /subscription usage/);
});

test("routes exposes actor, effective route, source, and upstream outcome", needsDriver, (t) => {
  const space = populated(t);
  const result = run(space, ["routes", "--session", "s1", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.routes[0].actorType, "main");
  assert.equal(report.routes[0].effectiveProfile, "opus-high");
  assert.equal(report.routes[0].source, "jev");
  assert.equal(report.routes[0].requests, 2);
  assert.equal(report.routes[0].succeeded, 2);
});

test("invalid explicit session IDs fail without falling back", needsDriver, (t) => {
  const result = run(populated(t), ["stats", "--session", "missing", "--json"]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).code, "not_found");
  assert.equal(result.stderr, "");
});

test("project filtering aggregates only the exact resolved project", needsDriver, (t) => {
  const space = populated(t);
  const other = join(space.root, "other");
  mkdirSync(other);
  seed(space, [session("s2", other), actor("a2", "s2"), route("r2", "s2", "a2")]);
  const result = run(space, ["stats", "--project", ".", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scope.type, "project");
  assert.equal(report.scope.sessions, 1);
  assert.equal(report.routes.reduce((n, row) => n + row.freshRoutes, 0), 1);
});

test("ambiguous current sessions list IDs and require explicit selection", needsDriver, (t) => {
  const space = populated(t, { endedAt: null });
  seed(space, [session("s2", space.project, null), actor("a2", "s2")]);
  const result = run(space, ["stats"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Multiple active sessions/);
  assert.match(result.stderr, /s1/);
  assert.match(result.stderr, /s2/);
});

test("caller session identity resolves current even when project sessions are ambiguous", needsDriver, (t) => {
  const space = populated(t, { endedAt: null });
  seed(space, [session("s2", space.project, null), actor("a2", "s2")]);
  const result = run(space, ["stats", "--json"], { JEV_SESSION_ID: "s2" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).scope.id, "s2");
});

test("no sessions for the current project stays distinct from no database", needsDriver, (t) => {
  const space = populated(t);
  const empty = join(space.root, "empty");
  mkdirSync(empty);
  const result = spawnSync(process.execPath, [CLI, "stats", "--json"], {
    cwd: empty,
    env: space.env,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).code, "no_sessions");
});

test("an unreadable legacy schema returns a structured error instead of crashing", needsDriver, (t) => {
  const space = workspace(t);
  mkdirSync(space.data);
  const db = new driver(databasePath({ JEV_DATA_DIR: space.data }));
  db.exec("CREATE TABLE legacy_only (id TEXT)");
  db.close();
  const result = run(space, ["stats", "--json"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).code, "telemetry_read_failed");
});

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, SCHEMA_VERSION, migrate } from "../../../src/telemetry/schema.mjs";
import { createWriter, openDatabase, pruneRetention } from "../../../src/telemetry/store.mjs";
import {
  actorBreakdown,
  listSessions,
  requestBreakdown,
  routeDistribution,
  routingCost,
  sessionSummary,
  usageByRoute,
  usageTotals,
} from "../../../src/telemetry/read.mjs";

const require = createRequire(import.meta.url);
let driver = null;
try {
  driver = require("better-sqlite3");
} catch {
  // The native driver is an optional dependency; these tests skip without it.
}
const needsDriver = { skip: driver ? false : "better-sqlite3 is not installed" };

const NOW = 1_700_000_000_000;

const open = (t, path = ":memory:") => {
  const { db, ...rest } = openDatabase(path, { driver });
  t.after(() => {
    try {
      db.close();
    } catch {
      // Already closed by the test.
    }
  });
  return { db, ...rest };
};

const session = (id, over = {}) => ({
  kind: "session",
  row: {
    id,
    claudeSessionId: `claude-${id}`,
    projectPath: "/work/project",
    startedAt: NOW,
    endedAt: null,
    routerVersion: "0.3.0",
    claudeVersion: null,
    launchMode: "cli",
    jevProvider: "mock",
    ...over,
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
    jevDecisionId: `dec-${id}`,
    recommendedProfile: "opus-high",
    effectiveProfile: "opus-high",
    model: "claude-opus-5",
    tier: "strong",
    requestedEffort: null,
    effectiveEffort: "high",
    confidence: 0.9,
    fallbackReason: null,
    normalizationJson: null,
    jevLatencyMs: 20,
    jevInputTokens: 100,
    jevOutputTokens: 10,
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
    requestBytes: 500,
    responseBytes: 900,
    latencyMs: 1200,
    httpStatus: 200,
    success: 1,
    ...over,
  },
});

const usage = (requestId, over = {}) => ({
  kind: "usage",
  row: {
    requestId,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadInputTokens: 300,
    cacheCreationInputTokens: 50,
    rawUsageJson: '{"input_tokens":1000}',
    ...over,
  },
});

test("a fresh database migrates to the current version", needsDriver, (t) => {
  const { db, migration } = open(t);
  assert.deepEqual(migration, { from: 0, to: SCHEMA_VERSION });
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map(({ name }) => name)
    .filter((name) => !name.startsWith("sqlite_"));
  assert.deepEqual(tables, ["actors", "inference_requests", "routes", "sessions", "usage_events"]);
});

test("migrating an already-current database is a no-op that preserves data", needsDriver, (t) => {
  const { db } = open(t);
  createWriter(db).applyBatch([session("s1"), actor("a1", "s1")]);
  const again = migrate(db);
  assert.deepEqual(again, { from: SCHEMA_VERSION, to: SCHEMA_VERSION });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions").get().c, 1, "data survived");
});

test("a database newer than this build is refused rather than rewritten", needsDriver, (t) => {
  const { db } = open(t);
  db.pragma(`user_version = ${SCHEMA_VERSION + 5}`);
  assert.throws(() => migrate(db), /newer than this router understands/);
});

test("a failed migration leaves a populated version-zero database intact", needsDriver, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jev-store-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "telemetry.sqlite3");
  const seeded = new driver(path);
  seeded.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, marker TEXT)");
  seeded.prepare("INSERT INTO sessions (id, marker) VALUES (?, ?)").run("legacy", "keep-me");
  seeded.close();

  assert.throws(() => openDatabase(path, { driver }), /sessions already exists/);

  const after = new driver(path);
  t.after(() => after.close());
  assert.equal(after.pragma("user_version", { simple: true }), 0);
  assert.deepEqual(after.prepare("SELECT id, marker FROM sessions").all(), [
    { id: "legacy", marker: "keep-me" },
  ]);
  assert.equal(
    after.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table'").get().c,
    1,
    "no table from the failed migration was left behind",
  );
});

test("migrations are append-only and uniquely versioned", () => {
  const versions = MIGRATIONS.map(({ version }) => version);
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
  assert.equal(new Set(versions).size, versions.length);
  assert.equal(versions[0], 1);
});

test("an on-disk database and its sidecars are owner-only", {
  skip: driver ? process.platform === "win32" && "POSIX modes only" : needsDriver.skip,
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jev-telemetry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "nested", "telemetry.sqlite3");
  const { db, journalMode } = open(t, path);
  db.prepare("SELECT 1").get();
  assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  if (journalMode === "wal") {
    assert.equal(statSync(`${path}-wal`).mode & 0o777, 0o600);
  }
});

test("WAL is requested and reported", needsDriver, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jev-telemetry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { journalMode } = open(t, join(dir, "telemetry.sqlite3"));
  assert.equal(journalMode, "wal");
});

test("a batch is applied parents-first and is order-independent", needsDriver, (t) => {
  const { db } = open(t);
  // Deliberately reversed: children arrive before the rows they reference.
  const result = createWriter(db).applyBatch([
    usage("q1"),
    request("q1", "s1", "a1", "r1"),
    route("r1", "s1", "a1"),
    actor("a1", "s1"),
    session("s1"),
  ]);
  assert.equal(result.written, 5);
  assert.deepEqual(result.rejected, []);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_events").get().c, 1);
});

test("a row with a missing parent is dropped alone, not the batch", needsDriver, (t) => {
  const { db } = open(t);
  const result = createWriter(db).applyBatch([
    session("s1"),
    actor("a1", "s1"),
    route("orphan", "no-such-session", "a1"),
    route("r1", "s1", "a1"),
  ]);
  assert.equal(result.written, 3);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].message, /FOREIGN KEY/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM routes").get().c, 1);
});

test("repeated events deduplicate by identity instead of double counting", needsDriver, (t) => {
  const { db } = open(t);
  const writer = createWriter(db);
  const batch = [session("s1"), actor("a1", "s1"), route("r1", "s1", "a1"), request("q1", "s1", "a1", "r1"), usage("q1")];
  writer.applyBatch(batch);
  writer.applyBatch(batch);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM routes").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM inference_requests").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM usage_events").get().c, 1);
});

test("a later usage report supersedes an earlier partial one", needsDriver, (t) => {
  const { db } = open(t);
  const writer = createWriter(db);
  writer.applyBatch([session("s1"), actor("a1", "s1"), route("r1", "s1", "a1"), request("q1", "s1", "a1", "r1")]);
  writer.applyBatch([usage("q1", { inputTokens: 100, outputTokens: 1, cacheReadInputTokens: null })]);
  writer.applyBatch([usage("q1", { inputTokens: 100, outputTokens: 57, cacheReadInputTokens: 20 })]);
  const stored = db.prepare("SELECT * FROM usage_events").all();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].output_tokens, 57);
  assert.equal(stored[0].cache_read_input_tokens, 20);
});

test("a session's end time and a request's outcome can be filled in later", needsDriver, (t) => {
  const { db } = open(t);
  const writer = createWriter(db);
  writer.applyBatch([
    session("s1"),
    actor("a1", "s1"),
    route("r1", "s1", "a1"),
    request("q1", "s1", "a1", "r1", { httpStatus: null, success: null, responseBytes: null }),
  ]);
  writer.applyBatch([
    session("s1", { endedAt: NOW + 5000 }),
    request("q1", "s1", "a1", "r1", { httpStatus: 200, success: 1, responseBytes: 4242 }),
  ]);
  assert.equal(db.prepare("SELECT ended_at e FROM sessions").get().e, NOW + 5000);
  const stored = db.prepare("SELECT * FROM inference_requests").get();
  assert.equal(stored.http_status, 200);
  assert.equal(stored.response_bytes, 4242);
});

test("prompt_preview defaults to NULL", needsDriver, (t) => {
  const { db } = open(t);
  createWriter(db).applyBatch([session("s1"), actor("a1", "s1"), route("r1", "s1", "a1")]);
  const stored = db.prepare("SELECT prompt_preview p, request_hash h FROM routes").get();
  assert.equal(stored.p, null);
  assert.equal(stored.h, "hash", "a hash is stored where the prompt is not");
});

function populate(db) {
  const writer = createWriter(db);
  writer.applyBatch([
    session("s1"),
    actor("main", "s1"),
    actor("sub", "s1", { actorType: "subagent", parentActorId: "main", agentName: "Explore" }),
    route("r-main", "s1", "main"),
    route("r-sub", "s1", "sub", {
      classification: "subagent_fresh",
      effectiveProfile: "haiku-default",
      model: "claude-haiku-4-5-20251001",
      tier: "fast",
      effectiveEffort: null,
      jevCostUsd: 0.0001,
      jevLatencyMs: 40,
    }),
    request("q1", "s1", "main", "r-main"),
    request("q2", "s1", "main", "r-main", {
      classification: "main_continuation",
      isContinuation: 1,
    }),
    request("q3", "s1", "sub", "r-sub", {
      classification: "subagent_fresh",
      model: "claude-haiku-4-5-20251001",
      effort: null,
    }),
    usage("q1"),
    usage("q2", { inputTokens: 2000, outputTokens: 400, cacheReadInputTokens: 1500, cacheCreationInputTokens: 0 }),
    // q3 deliberately has no usage row: an unobserved response.
  ]);
  return writer;
}

test("aggregates attribute routes, continuations, and tokens without double counting", needsDriver, (t) => {
  const { db } = open(t);
  populate(db);

  const distribution = routeDistribution(db, { sessionId: "s1" });
  assert.equal(distribution.length, 2);
  assert.equal(
    distribution.reduce((total, { routes }) => total + routes, 0),
    2,
    "route counts are fresh decisions only",
  );

  const requests = requestBreakdown(db, { sessionId: "s1" });
  assert.equal(
    requests.reduce((total, { requests: count }) => total + count, 0),
    3,
  );
  assert.equal(requests.find(({ isContinuation }) => isContinuation === 1).requests, 1);

  const actors = actorBreakdown(db, { sessionId: "s1" });
  assert.deepEqual(
    actors.map(({ id, routes, requests: count, continuations }) => [id, routes, count, continuations]),
    [
      ["main", 1, 2, 1],
      ["sub", 1, 1, 0],
    ],
  );
  assert.equal(actors[1].parentActorId, "main");
  assert.equal(actors[1].agentName, "Explore");
});

test("token totals carry their own completeness figures", needsDriver, (t) => {
  const { db } = open(t);
  populate(db);
  const totals = usageTotals(db, { sessionId: "s1" });
  assert.equal(totals.inputTokens, 3000);
  assert.equal(totals.outputTokens, 600);
  assert.equal(totals.cacheReadInputTokens, 1800);
  assert.equal(totals.cacheCreationInputTokens, 50);
  assert.equal(totals.requests, 3);
  assert.equal(totals.requestsWithUsage, 2);
  assert.equal(totals.requestsMissingUsage, 1);
  assert.equal(totals.complete, false, "one response was never observed, so totals are partial");
});

test("an empty database reports unknown totals rather than zeros", needsDriver, (t) => {
  const { db } = open(t);
  const totals = usageTotals(db, {});
  assert.equal(totals.inputTokens, null);
  assert.equal(totals.outputTokens, null);
  assert.equal(totals.requests, 0);
  assert.equal(totals.complete, false);
});

test("usage is attributable to the route that produced it", needsDriver, (t) => {
  const { db } = open(t);
  populate(db);
  const byRoute = usageByRoute(db, { sessionId: "s1" });
  const main = byRoute.find(({ routeId }) => routeId === "r-main");
  const sub = byRoute.find(({ routeId }) => routeId === "r-sub");
  assert.equal(main.requests, 2);
  assert.equal(main.outputTokens, 600);
  assert.equal(sub.requests, 1);
  assert.equal(sub.outputTokens, null, "an unobserved response leaves tokens unknown");
  assert.equal(byRoute[0].routeId, "r-main", "heaviest route first");
});

test("routing cost reports the provider's actual figures and never a Claude bill", needsDriver, (t) => {
  const { db } = open(t);
  populate(db);
  const cost = routingCost(db, { sessionId: "s1" });
  assert.equal(cost.routes, 2);
  assert.equal(cost.jevCalls, 2);
  assert.ok(Math.abs(cost.jevCostUsd - 0.0003) < 1e-9);
  assert.equal(cost.averageLatencyMs, 30);
  assert.equal(cost.callsWithoutCost, 0);
  assert.equal(cost.costComplete, true);
  assert.equal("claudeCostUsd" in cost, false, "no inference cost is inferred for a subscription");
});

test("a routing call with no reported cost is visibly incomplete", needsDriver, (t) => {
  const { db } = open(t);
  createWriter(db).applyBatch([
    session("s1"),
    actor("a1", "s1"),
    route("r1", "s1", "a1", { jevCostUsd: null }),
  ]);
  const cost = routingCost(db, { sessionId: "s1" });
  assert.equal(cost.callsWithoutCost, 1);
  assert.equal(cost.costComplete, false);
});

test("sessionSummary gathers one session and misses cleanly", needsDriver, (t) => {
  const { db } = open(t);
  populate(db);
  const summary = sessionSummary(db, "s1");
  assert.equal(summary.session.claudeSessionId, "claude-s1");
  assert.equal(summary.actors.length, 2);
  assert.equal(summary.usage.requestsMissingUsage, 1);
  assert.equal(sessionSummary(db, "no-such-session"), null);
  assert.equal(listSessions(db)[0].id, "s1");
  assert.equal(listSessions(db)[0].routes, 2);
});

test("retention removes a whole expired session transactionally", needsDriver, (t) => {
  const { db } = open(t);
  populate(db);
  createWriter(db).applyBatch([session("s1", { endedAt: NOW - 1 })]);
  const removed = pruneRetention(db, NOW);
  assert.deepEqual(removed, { sessions: 1, routes: 2, requests: 3, usage: 2, actors: 2 });
  for (const table of ["sessions", "actors", "routes", "inference_requests", "usage_events"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c, 0, `${table} not cleared`);
  }
});

test("retention never removes a session that is still active", needsDriver, (t) => {
  const { db } = open(t);
  populate(db);
  // s1 has no ended_at and an old start time; an ended session is also present.
  createWriter(db).applyBatch([
    session("s-old", { startedAt: NOW - 1_000_000, endedAt: NOW - 999_999 }),
    actor("a-old", "s-old"),
  ]);
  const removed = pruneRetention(db, NOW - 500_000);
  assert.equal(removed.sessions, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions").get().c, 1);
  assert.equal(db.prepare("SELECT id FROM sessions").get().id, "s1");
});

test("retention with nothing expired touches nothing", needsDriver, (t) => {
  const { db } = open(t);
  populate(db);
  const removed = pruneRetention(db, NOW - 1_000_000);
  assert.deepEqual(removed, { sessions: 0, routes: 0, requests: 0, usage: 0, actors: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM routes").get().c, 2);
});

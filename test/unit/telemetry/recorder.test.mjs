import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_BATCH, MAX_IN_FLIGHT_BATCHES, MAX_QUEUED_EVENTS, createRecorder, disabledRecorder } from "../../../src/telemetry/recorder.mjs";
import { openReader, usageTotals } from "../../../src/telemetry/read.mjs";

const require = createRequire(import.meta.url);
let driver = null;
try {
  driver = require("better-sqlite3");
} catch {
  // Optional native dependency.
}
const needsDriver = { skip: driver ? false : "better-sqlite3 is not installed" };

const NOW = 1_700_000_000_000;

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "jev-recorder-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ON = { JEV_ENABLE_TELEMETRY: "1" };

function recorderIn(t, dir, env = {}) {
  const recorder = createRecorder({
    env: { ...ON, ...env },
    path: join(dir, "telemetry.sqlite3"),
  });
  t.after(() => recorder.close({ timeoutMs: 1000 }));
  return recorder;
}

const sessionRow = (id = "s1") => ({
  id,
  claudeSessionId: `claude-${id}`,
  projectPath: "/work",
  startedAt: NOW,
  endedAt: null,
  routerVersion: "0.3.0",
  claudeVersion: null,
  launchMode: "cli",
  jevProvider: "mock",
});

const actorRow = (id = "a1", sessionId = "s1") => ({
  id,
  sessionId,
  parentActorId: null,
  actorType: "main",
  agentName: null,
  createdAt: NOW,
  lastSeenAt: NOW,
});

const routeRow = (id = "r1", sessionId = "s1", actorId = "a1") => ({
  id,
  sessionId,
  actorId,
  logicalTurnId: "t1",
  timestamp: NOW,
  classification: "main_fresh",
  source: "jev",
  provider: "mock",
  jevDecisionId: "dec-1",
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
  jevInputTokens: null,
  jevOutputTokens: null,
  jevCostUsd: null,
  requestHash: "hash",
  promptPreview: null,
});

const requestRow = (id = "q1", sessionId = "s1", actorId = "a1", routeId = "r1") => ({
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
  latencyMs: 300,
  httpStatus: 200,
  success: 1,
});

test("telemetry is off unless it is switched on", () => {
  const recorder = createRecorder({ env: {}, path: "/nonexistent/telemetry.sqlite3" });
  assert.equal(recorder.enabled, false);
  assert.doesNotThrow(() => recorder.route(routeRow()));
  assert.equal(recorder.stats().enabled, false);
  assert.equal(existsSync("/nonexistent/telemetry.sqlite3"), false);
});

test("the disabled recorder satisfies the whole interface", async () => {
  const recorder = disabledRecorder();
  for (const method of ["session", "actor", "route", "request", "usage", "record"]) {
    assert.equal(typeof recorder[method], "function", `missing ${method}`);
    assert.doesNotThrow(() => recorder[method]({}));
  }
  assert.equal(typeof recorder.newId(), "string");
  await recorder.flush();
  assert.equal(await recorder.prune(), null);
  await recorder.close();
});

test("recorded events reach the database and are readable back", needsDriver, async (t) => {
  const dir = workspace(t);
  const recorder = recorderIn(t, dir);
  recorder.session(sessionRow());
  recorder.actor(actorRow());
  recorder.route(routeRow());
  recorder.request(requestRow());
  recorder.usage({
    requestId: "q1",
    inputTokens: 500,
    outputTokens: 60,
    cacheReadInputTokens: 10,
    cacheCreationInputTokens: 0,
    rawUsageJson: '{"input_tokens":500}',
  });
  await recorder.flush();

  const db = openReader({ path: join(dir, "telemetry.sqlite3") });
  t.after(() => db.close());
  const totals = usageTotals(db, { sessionId: "s1" });
  assert.equal(totals.inputTokens, 500);
  assert.equal(totals.outputTokens, 60);
  assert.equal(totals.requestsMissingUsage, 0);
  assert.equal(totals.complete, true);

  const stats = recorder.stats();
  assert.equal(stats.accepted, 5);
  assert.equal(stats.written, 5);
  assert.equal(stats.droppedQueueFull, 0);
  assert.equal(stats.rejected, 0);
  assert.equal(stats.failed, false);
});

test("a large burst is written in batches without loss", needsDriver, async (t) => {
  const dir = workspace(t);
  const recorder = recorderIn(t, dir);
  recorder.session(sessionRow());
  recorder.actor(actorRow());
  for (let index = 0; index < 300; index += 1) {
    recorder.route(routeRow(`r${index}`));
    recorder.request(requestRow(`q${index}`, "s1", "a1", `r${index}`));
  }
  await recorder.flush();

  const db = openReader({ path: join(dir, "telemetry.sqlite3") });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT COUNT(*) c FROM routes").get().c, 300);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM inference_requests").get().c, 300);
  assert.equal(recorder.stats().droppedQueueFull, 0);
});

test("a saturated queue drops events and counts them instead of growing", async (t) => {
  // A writer that never acknowledges is what a stalled disk looks like from here.
  const recorder = createRecorder({
    env: ON,
    path: ":memory:",
    workerURL: new URL("../../fixtures/telemetry/stalled-worker.mjs", import.meta.url),
  });
  t.after(() => recorder.close({ timeoutMs: 500 }));

  // Far more than the queue plus every batch that can be in flight at once.
  const pushed = MAX_QUEUED_EVENTS + MAX_IN_FLIGHT_BATCHES * MAX_BATCH + 500;
  for (let index = 0; index < pushed; index += 1) {
    recorder.route(routeRow(`r${index}`));
  }
  const stats = recorder.stats();
  assert.equal(stats.queued, MAX_QUEUED_EVENTS, "the queue stops at its bound");
  // Memory held is the queue plus the batches already handed to the writer, and no more.
  const held = MAX_QUEUED_EVENTS + MAX_IN_FLIGHT_BATCHES * MAX_BATCH;
  assert.equal(stats.accepted, held);
  assert.equal(stats.droppedQueueFull, pushed - held, "every dropped event is counted");
  assert.equal(stats.written, 0, "nothing was acknowledged");
  assert.equal(stats.failed, false, "a slow writer is not a fatal condition");
});

test("a rejected row is counted without disabling telemetry", needsDriver, async (t) => {
  const dir = workspace(t);
  const recorder = recorderIn(t, dir);
  // No session or actor row, so the route violates its foreign keys.
  recorder.route(routeRow());
  await recorder.flush();
  const stats = recorder.stats();
  assert.equal(stats.rejected, 1);
  assert.equal(stats.written, 0);
  assert.equal(stats.failed, false, "one bad row is not a fatal condition");

  recorder.session(sessionRow());
  recorder.actor(actorRow());
  recorder.route(routeRow());
  await recorder.flush();
  assert.equal(recorder.stats().written, 3, "recording continues afterwards");
});

test("an unopenable database disables telemetry without throwing", needsDriver, async (t) => {
  const dir = workspace(t);
  const blocked = join(dir, "blocked");
  mkdirSync(blocked);
  writeFileSync(join(blocked, "telemetry.sqlite3"), "this is not a database");
  const recorder = createRecorder({ env: ON, path: join(blocked, "telemetry.sqlite3") });
  t.after(() => recorder.close({ timeoutMs: 1000 }));

  assert.doesNotThrow(() => recorder.session(sessionRow()));
  await recorder.flush({ timeoutMs: 1500 });
  const stats = recorder.stats();
  assert.equal(stats.failed, true);
  assert.equal(stats.enabled, false);
  assert.ok(stats.failureReason, "the reason is available for a diagnostic");
});

test("a read-only directory disables telemetry rather than failing a caller", {
  skip: driver ? process.platform === "win32" && "POSIX modes only" : needsDriver.skip,
}, async (t) => {
  const dir = workspace(t);
  const locked = join(dir, "locked");
  mkdirSync(locked, { mode: 0o500 });
  // Restored before the workspace cleanup runs, which cannot remove an unwritable directory.
  t.after(() => {
    try {
      chmodSync(locked, 0o700);
    } catch {
      // Already gone.
    }
  });
  const recorder = createRecorder({ env: ON, path: join(locked, "sub", "telemetry.sqlite3") });
  t.after(() => recorder.close({ timeoutMs: 1000 }));
  recorder.session(sessionRow());
  await recorder.flush({ timeoutMs: 1500 });
  assert.equal(recorder.stats().failed, true);
});

test("events recorded after a fatal failure are dropped quietly", needsDriver, async (t) => {
  const dir = workspace(t);
  const path = join(dir, "telemetry.sqlite3");
  writeFileSync(path, "corrupt");
  const recorder = createRecorder({ env: ON, path });
  t.after(() => recorder.close({ timeoutMs: 1000 }));
  await recorder.flush({ timeoutMs: 1500 });
  assert.equal(recorder.stats().failed, true);
  for (let index = 0; index < 100; index += 1) recorder.route(routeRow(`r${index}`));
  assert.equal(recorder.stats().queued, 0, "nothing accumulates once telemetry has given up");
});

test("flush is bounded and close is idempotent", needsDriver, async (t) => {
  const dir = workspace(t);
  const recorder = recorderIn(t, dir);
  recorder.session(sessionRow());
  const started = Date.now();
  await recorder.flush({ timeoutMs: 200 });
  assert.ok(Date.now() - started < 2000, "flush respected its bound");
  await recorder.close({ timeoutMs: 500 });
  await recorder.close({ timeoutMs: 500 });
  assert.doesNotThrow(() => recorder.route(routeRow()));
});

test("data written before close survives it", needsDriver, async (t) => {
  const dir = workspace(t);
  const path = join(dir, "telemetry.sqlite3");
  const recorder = createRecorder({ env: ON, path });
  recorder.session(sessionRow());
  recorder.actor(actorRow());
  recorder.route(routeRow());
  await recorder.close({ timeoutMs: 2000 });

  const db = openReader({ path });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT COUNT(*) c FROM routes").get().c, 1);
});

test("retention runs through the worker and preserves active sessions", needsDriver, async (t) => {
  const dir = workspace(t);
  const recorder = recorderIn(t, dir, { JEV_TELEMETRY_RETENTION_DAYS: "1" });
  const twoDaysAgo = NOW - 2 * 24 * 60 * 60 * 1000;
  recorder.session({ ...sessionRow("old"), startedAt: twoDaysAgo, endedAt: twoDaysAgo });
  recorder.actor(actorRow("a-old", "old"));
  recorder.session(sessionRow("live"));
  recorder.actor(actorRow("a-live", "live"));
  await recorder.flush();

  const removed = await recorder.prune({ now: NOW });
  assert.equal(removed.sessions, 1);
  const db = openReader({ path: join(dir, "telemetry.sqlite3") });
  t.after(() => db.close());
  assert.deepEqual(
    db.prepare("SELECT id FROM sessions").all().map(({ id }) => id),
    ["live"],
  );
});

test("openReader misses cleanly when there is no database", () => {
  assert.equal(openReader({ path: join(tmpdir(), `no-such-db-${process.pid}.sqlite3`) }), null);
});

test("a writer that crashes mid-session disables telemetry and drops nothing else", async (t) => {
  const recorder = createRecorder({
    env: ON,
    path: ":memory:",
    workerURL: new URL("../../fixtures/telemetry/crashing-worker.mjs", import.meta.url),
  });
  t.after(() => recorder.close({ timeoutMs: 500 }));

  recorder.session(sessionRow());
  await recorder.flush({ timeoutMs: 1500 });
  const stats = recorder.stats();
  assert.equal(stats.failed, true);
  assert.match(stats.failureReason, /crash/i);
  assert.doesNotThrow(() => recorder.route(routeRow()));
  assert.equal(recorder.stats().queued, 0);
});

test("a database written by a newer router disables telemetry instead of rewriting it", needsDriver, async (t) => {
  const dir = workspace(t);
  const path = join(dir, "telemetry.sqlite3");
  const seeded = new driver(path);
  seeded.pragma("user_version = 9999");
  seeded.close();

  const recorder = createRecorder({ env: ON, path });
  t.after(() => recorder.close({ timeoutMs: 1000 }));
  recorder.session(sessionRow());
  await recorder.flush({ timeoutMs: 1500 });

  const stats = recorder.stats();
  assert.equal(stats.failed, true);
  assert.match(stats.failureReason, /newer than this router understands/);

  // The existing database is left exactly as it was.
  const after = new driver(path);
  t.after(() => after.close());
  assert.equal(after.pragma("user_version", { simple: true }), 9999);
  assert.equal(
    after.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c,
    0,
    "migration failure left the database untouched",
  );
});

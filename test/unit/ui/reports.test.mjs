import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRoutesReport,
  buildStatsReport,
  formatRoutes,
  formatStats,
} from "../../../src/ui/reports.mjs";

const summary = {
  session: { id: "s1", projectPath: "/work/demo", startedAt: 1000, endedAt: 4000 },
  routes: [
    { profile: "haiku-default", model: "haiku", effort: null, source: "jev", routes: 3 },
    { profile: "opus-high", model: "opus", effort: "high", source: "fallback", routes: 1 },
  ],
  requests: [
    { classification: "main_fresh", isContinuation: 0, requests: 1 },
    { classification: "subagent_fresh", isContinuation: 0, requests: 3 },
    { classification: "main_continuation", isContinuation: 1, requests: 7 },
    { classification: "auxiliary", isContinuation: 0, requests: 2 },
  ],
  actors: [{ id: "main", actorType: "main", routes: 1 }],
  usage: {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadInputTokens: 700,
    cacheCreationInputTokens: null,
    requests: 11,
    requestsWithUsage: 10,
    requestsMissingUsage: 1,
    complete: false,
  },
  routing: { jevCalls: 4, jevCostUsd: 0.001, averageLatencyMs: 25, p95LatencyMs: 41, costComplete: false },
  fallbacks: [{ source: "fallback", fallbackReason: "timeout", routes: 1 }],
};

test("stats keep fresh routes separate from continuations and expose partial data", () => {
  const report = buildStatsReport(summary);
  assert.equal(report.routes[0].share, 0.75);
  assert.deepEqual(report.routes[0].sources, { jev: 3 });
  assert.equal(report.actors.continuations, 7);
  assert.equal(report.usage.cacheCreationInputTokens, null);
  assert.equal(report.usage.complete, false);
  assert.equal(report.jev.actualRoutingCostUsd, 0.001);
  assert.equal(report.jev.p95LatencyMs, 41);
  assert.equal(report.fallbacks[0].reason, "timeout");
  const output = formatStats(report);
  assert.match(output, /Routes \(fresh decisions\)/);
  assert.match(output, /continuations\s+7/);
  assert.match(output, /partial\/unknown/);
  assert.match(output, /p95 latency\s+41 ms/);
  assert.match(output, /subscription usage/);
});

test("routes show actor, recommendation outcome, and unavailable confidence honestly", () => {
  const report = buildRoutesReport([
    {
      id: "r1",
      timestamp: 1_700_000_000_000,
      actorType: "subagent",
      actorName: "Explore",
      effectiveProfile: "haiku-default",
      confidence: null,
      source: "fallback",
      requests: 2,
      succeeded: 1,
      failed: 1,
    },
  ], { type: "session", id: "s1" });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.routes[0].confidence, null);
  assert.match(formatRoutes(report), /Explore/);
  assert.match(formatRoutes(report), /fallback \/ 1\/2 ok/);
});

test("an absent auxiliary row is unknown because unattributed traffic is not persisted", () => {
  const withoutAuxiliary = {
    ...summary,
    requests: summary.requests.filter(({ classification }) => classification !== "auxiliary"),
  };
  const report = buildStatsReport(withoutAuxiliary);
  assert.equal(report.actors.auxiliary, null);
  assert.match(formatStats(report), /auxiliary\s+unknown/);
});

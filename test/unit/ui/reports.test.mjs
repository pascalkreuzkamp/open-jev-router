import test from "node:test";
import assert from "node:assert/strict";
import {
  buildActorsReport,
  buildRoutesReport,
  buildStatsReport,
  buildUsageReport,
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

test("stats roll routes up into model and effort distributions and list rewrites", () => {
  const report = buildStatsReport({
    ...summary,
    routes: [
      ...summary.routes,
      { profile: "opus-low", model: "opus", effort: "low", source: "jev", routes: 4 },
    ],
    rewrites: [{ note: "effort xhigh -> high", routes: 2 }],
  });
  assert.deepEqual(report.models.map(({ model, freshRoutes }) => [model, freshRoutes]), [
    ["opus", 5],
    ["haiku", 3],
  ]);
  assert.equal(report.models[0].share, 5 / 8);
  assert.deepEqual(report.efforts.map(({ effort, freshRoutes }) => [effort, freshRoutes]), [
    ["low", 4],
    [null, 3],
    ["high", 1],
  ]);
  assert.deepEqual(report.rewrites, [{ note: "effort xhigh -> high", routes: 2 }]);
  assert.deepEqual(buildStatsReport(summary).rewrites, []);
});

test("usage report keeps unknown token counts null and per-profile rows", () => {
  const scope = { type: "session", id: "s1" };
  const report = buildUsageReport(summary.usage, [
    { profile: "opus-high", model: "opus", effort: "high", requests: 3, requestsMissingUsage: 1, inputTokens: 600, outputTokens: 100, cacheReadInputTokens: 700, cacheCreationInputTokens: null },
    { profile: null, model: null, effort: null, requests: 8, requestsMissingUsage: 0, inputTokens: 400, outputTokens: 100, cacheReadInputTokens: null, cacheCreationInputTokens: null },
  ], scope);
  assert.equal(report.kind, "usage");
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.totals.cacheCreationInputTokens, null);
  assert.equal(report.totals.complete, false);
  assert.equal(report.byProfile[1].profile, null);
  assert.equal(report.byProfile[0].inputTokens + report.byProfile[1].inputTokens, report.totals.inputTokens);
});

test("actor tree reports unrecorded parents, missing parents and cycles honestly", () => {
  const report = buildActorsReport([
    { id: "main", actorType: "main", routes: 2, models: "opus,haiku" },
    { id: "child", actorType: "subagent", agentName: "Explore", parentActorId: "main", routes: 1 },
    { id: "orphan", actorType: "subagent", parentActorId: null },
    { id: "lost", actorType: "subagent", parentActorId: "gone" },
    { id: "c1", actorType: "subagent", parentActorId: "c2" },
    { id: "c2", actorType: "subagent", parentActorId: "c1" },
    { id: "self", actorType: "subagent", parentActorId: "self" },
  ], { type: "session", id: "s1" });
  assert.equal(report.kind, "actors");
  assert.equal(report.actors.length, 7);
  assert.deepEqual(report.actors[0].models, ["opus", "haiku"]);
  assert.deepEqual(report.tree.roots.map(({ id }) => id), ["main"]);
  assert.deepEqual(report.tree.roots[0].children.map(({ id }) => id), ["child"]);
  assert.deepEqual(report.tree.parentNotRecorded.map(({ id }) => id), ["orphan"]);
  const missing = report.tree.parentMissing.map(({ id }) => id);
  assert.ok(missing.includes("lost"));
  assert.ok(missing.includes("self"));
  assert.equal(missing.filter((id) => id === "c1" || id === "c2").length, 1);
  // The tree is finite, so it serializes.
  assert.doesNotThrow(() => JSON.stringify(report));
  const seen = [];
  const walk = (node) => { seen.push(node.id); node.children.forEach(walk); };
  [...report.tree.roots, ...report.tree.parentNotRecorded, ...report.tree.parentMissing].forEach(walk);
  assert.deepEqual(seen.sort(), report.actors.map(({ id }) => id).sort());
});

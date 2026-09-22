import { basename } from "node:path";

export const REPORT_SCHEMA_VERSION = 1;

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const nullableNumber = (value) => (value == null ? null : number(value));
const sum = (rows, field) => rows.reduce((total, item) => total + number(item[field]), 0);
const compact = (value) => {
  const n = number(value);
  if (Math.abs(n) < 1_000) return `${n}`;
  if (Math.abs(n) < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
};
const money = (value) => value == null ? "unknown" : `$${number(value).toFixed(6)}`;
const percent = (part, total) => total ? `${((part / total) * 100).toFixed(1)}%` : "0.0%";
const duration = (milliseconds) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${rest}s` : `${rest}s`;
};
const routeLabel = (row) => `${row.effectiveProfile ?? row.model ?? "unknown"}`;
const actorLabel = (row) => row.actorName ?? row.actorType ?? "unknown";

export function buildStatsReport(summary, { selectionSource = null, now = Date.now() } = {}) {
  const groupedRoutes = new Map();
  for (const row of summary.routes) {
    const key = JSON.stringify([row.profile, row.model, row.tier, row.effort]);
    const group = groupedRoutes.get(key) ?? {
      profile: row.profile,
      model: row.model,
      tier: row.tier,
      effort: row.effort,
      freshRoutes: 0,
      sources: {},
    };
    group.freshRoutes += number(row.routes);
    group.sources[row.source ?? "unknown"] =
      (group.sources[row.source ?? "unknown"] ?? 0) + number(row.routes);
    groupedRoutes.set(key, group);
  }
  const routeGroups = [...groupedRoutes.values()].sort(
    (a, b) => b.freshRoutes - a.freshRoutes || `${a.profile}`.localeCompare(`${b.profile}`),
  );
  const freshRoutes = sum(routeGroups, "freshRoutes");
  const continuations = summary.requests
    .filter(({ isContinuation }) => number(isContinuation) === 1)
    .reduce((total, row) => total + number(row.requests), 0);
  const auxiliaryRows = summary.requests.filter(({ classification }) => classification === "auxiliary");
  // Phase 5 deliberately leaves unattributed auxiliary requests out of relational rows. An
  // absent row is therefore unknown, not proof that no auxiliary request occurred.
  const auxiliary = auxiliaryRows.length ? sum(auxiliaryRows, "requests") : null;
  const session = summary.session ?? null;
  const sessions = summary.sessions ?? (session ? [session] : []);
  const startedAt = sessions.length ? Math.min(...sessions.map(({ startedAt }) => startedAt)) : null;
  const endedAt = sessions.length
    ? Math.max(...sessions.map(({ endedAt }) => endedAt ?? now))
    : null;
  const fallbacks = summary.fallbacks
    .filter(({ source, fallbackReason }) => source === "fallback" || fallbackReason)
    .map((row) => ({
      reason: row.fallbackReason ?? row.source ?? "unknown",
      routes: number(row.routes),
    }));
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: "stats",
    scope: session
      ? { type: "session", id: session.id, projectPath: session.projectPath, selectionSource }
      : { type: "project", path: summary.project.path, sessions: summary.project.sessions },
    period: {
      startedAt,
      endedAt,
      durationMs: startedAt == null || endedAt == null ? null : endedAt - startedAt,
    },
    routes: routeGroups.map((row) => ({
      ...row,
      share: freshRoutes ? row.freshRoutes / freshRoutes : 0,
    })),
    actors: {
      mainFresh: summary.requests
        .filter(({ classification }) => classification === "main_fresh")
        .reduce((total, row) => total + number(row.requests), 0),
      subagentFresh: summary.requests
        .filter(({ classification }) => classification === "subagent_fresh")
        .reduce((total, row) => total + number(row.requests), 0),
      continuations,
      auxiliary,
      records: summary.actors.map((row) => ({ ...row })),
    },
    usage: {
      inputTokens: nullableNumber(summary.usage.inputTokens),
      cacheReadInputTokens: nullableNumber(summary.usage.cacheReadInputTokens),
      cacheCreationInputTokens: nullableNumber(summary.usage.cacheCreationInputTokens),
      outputTokens: nullableNumber(summary.usage.outputTokens),
      requests: number(summary.usage.requests),
      requestsWithUsage: number(summary.usage.requestsWithUsage),
      requestsMissingUsage: number(summary.usage.requestsMissingUsage),
      complete: Boolean(summary.usage.complete),
    },
    jev: {
      decisions: number(summary.routing.jevCalls),
      fallbacks: sum(fallbacks, "routes"),
      totalLatencyMs: summary.routing.averageLatencyMs == null
        ? null
        : number(summary.routing.averageLatencyMs) * number(summary.routing.jevCalls),
      averageLatencyMs: nullableNumber(summary.routing.averageLatencyMs),
      p95LatencyMs: nullableNumber(summary.routing.p95LatencyMs),
      actualRoutingCostUsd: nullableNumber(summary.routing.jevCostUsd),
      costComplete: Boolean(summary.routing.costComplete),
    },
    fallbacks,
  };
}

export function buildRoutesReport(routes, scope) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: "routes",
    scope,
    routes: routes.map((row) => ({
      ...row,
      confidence: nullableNumber(row.confidence),
      jevLatencyMs: nullableNumber(row.jevLatencyMs),
      jevCostUsd: nullableNumber(row.jevCostUsd),
      requests: number(row.requests),
      continuations: number(row.continuations),
      succeeded: number(row.succeeded),
      failed: number(row.failed),
    })),
  };
}

export function formatStats(report) {
  const title = report.scope.type === "session"
    ? `${basename(report.scope.projectPath ?? "unknown")} — session ${report.scope.id}`
    : `${basename(report.scope.path)} — ${report.scope.sessions} sessions`;
  const lines = [
    `${title}${report.period.durationMs == null ? "" : ` — ${duration(report.period.durationMs)}`}`,
    "",
    "Routes (fresh decisions)",
  ];
  if (!report.routes.length) lines.push("  no fresh routes recorded");
  for (const row of report.routes) {
    lines.push(`  ${routeLabel({ effectiveProfile: row.profile, model: row.model }).padEnd(24)} ${`${row.freshRoutes}`.padStart(5)}  ${percent(row.freshRoutes, sum(report.routes, "freshRoutes")).padStart(6)}`);
  }
  lines.push(
    "",
    "Actors / requests",
    `  main fresh             ${report.actors.mainFresh}`,
    `  subagent fresh         ${report.actors.subagentFresh}`,
    `  continuations          ${report.actors.continuations}`,
    `  auxiliary              ${report.actors.auxiliary == null ? "unknown" : report.actors.auxiliary}`,
    "",
    `Claude token usage${report.usage.complete ? "" : " (partial/unknown)"}`,
    `  input                  ${report.usage.inputTokens == null ? "unknown" : compact(report.usage.inputTokens)}`,
    `  cache read             ${report.usage.cacheReadInputTokens == null ? "unknown" : compact(report.usage.cacheReadInputTokens)}`,
    `  cache creation         ${report.usage.cacheCreationInputTokens == null ? "unknown" : compact(report.usage.cacheCreationInputTokens)}`,
    `  output                 ${report.usage.outputTokens == null ? "unknown" : compact(report.usage.outputTokens)}`,
    "",
    "Jev routing",
    `  decisions              ${report.jev.decisions}`,
    `  fallbacks              ${report.jev.fallbacks}`,
    `  average latency        ${report.jev.averageLatencyMs == null ? "unknown" : `${Math.round(report.jev.averageLatencyMs)} ms`}`,
    `  p95 latency            ${report.jev.p95LatencyMs == null ? "unknown" : `${Math.round(report.jev.p95LatencyMs)} ms`}`,
    `  actual provider cost   ${money(report.jev.actualRoutingCostUsd)}${report.jev.costComplete ? "" : " (partial)"}`,
    "",
    "Claude usage is subscription usage; no API-price equivalent is implied.",
  );
  return lines.join("\n");
}

export function formatRoutes(report) {
  const lines = ["TIME      ACTOR                ROUTE                    CONF   SOURCE / OUTCOME"];
  if (!report.routes.length) return `${lines[0]}\n(no fresh routes recorded)`;
  for (const row of report.routes) {
    const time = new Date(row.timestamp).toISOString().slice(11, 19);
    const route = `${row.effectiveProfile ?? row.model ?? "unknown"}`;
    const confidence = row.confidence == null ? "-" : row.confidence.toFixed(2).replace(/^0/, "");
    const outcome = row.requests === 0
      ? "unknown"
      : row.failed > 0
        ? `${row.succeeded}/${row.requests} ok`
        : `${row.requests} ok`;
    lines.push(
      `${time}  ${actorLabel(row).slice(0, 20).padEnd(20)} ${route.slice(0, 24).padEnd(24)} ${confidence.padStart(5)}   ${row.source} / ${outcome}`,
    );
  }
  return lines.join("\n");
}

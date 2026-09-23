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

/** Fresh routes rolled up by one field of the route groups, so every view shares one count. */
function distribution(groups, field) {
  const totals = new Map();
  for (const group of groups) {
    totals.set(group[field] ?? null, (totals.get(group[field] ?? null) ?? 0) + group.freshRoutes);
  }
  const all = sum(groups, "freshRoutes");
  return [...totals]
    .map(([value, freshRoutes]) => ({ [field]: value, freshRoutes, share: all ? freshRoutes / all : 0 }))
    .sort((a, b) => b.freshRoutes - a.freshRoutes || `${a[field]}`.localeCompare(`${b[field]}`));
}

const tokenCounts = (row) => ({
  inputTokens: nullableNumber(row.inputTokens),
  cacheReadInputTokens: nullableNumber(row.cacheReadInputTokens),
  cacheCreationInputTokens: nullableNumber(row.cacheCreationInputTokens),
  outputTokens: nullableNumber(row.outputTokens),
});

function usageSection(usage) {
  return {
    ...tokenCounts(usage),
    requests: number(usage.requests),
    requestsWithUsage: number(usage.requestsWithUsage),
    requestsMissingUsage: number(usage.requestsMissingUsage),
    complete: Boolean(usage.complete),
  };
}

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
    models: distribution(routeGroups, "model"),
    efforts: distribution(routeGroups, "effort"),
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
    usage: usageSection(summary.usage),
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
    rewrites: (summary.rewrites ?? []).map((row) => ({ note: row.note, routes: number(row.routes) })),
  };
}

/** Token totals plus the same totals by route profile; the groups add up to the totals. */
export function buildUsageReport(totals, byProfile, scope) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: "usage",
    scope,
    totals: usageSection(totals),
    byProfile: byProfile.map((row) => ({
      profile: row.profile ?? null,
      model: row.model ?? null,
      effort: row.effort ?? null,
      requests: number(row.requests),
      requestsMissingUsage: number(row.requestsMissingUsage),
      ...tokenCounts(row),
    })),
  };
}

/**
 * Actors arranged as a tree. A parent is only ever the one telemetry recorded: a subagent with
 * no recorded parent is listed as such rather than placed under the main agent, and a parent id
 * that no longer resolves (or a cycle) is reported as missing rather than dropped.
 */
export function buildActorsReport(records, scope) {
  const actors = records.map((row) => ({
    id: row.id,
    actorType: row.actorType ?? null,
    agentName: row.agentName ?? null,
    parentActorId: row.parentActorId ?? null,
    createdAt: nullableNumber(row.createdAt),
    lastSeenAt: nullableNumber(row.lastSeenAt),
    routes: number(row.routes),
    requests: number(row.requests),
    continuations: number(row.continuations),
    models: row.models ? `${row.models}`.split(",").filter(Boolean) : [],
  }));
  const byId = new Map(actors.map((actor) => [actor.id, { ...actor, children: [] }]));
  const roots = [];
  const parentNotRecorded = [];
  const parentMissing = [];
  for (const node of byId.values()) {
    if (node.parentActorId && byId.has(node.parentActorId)) byId.get(node.parentActorId).children.push(node);
    else if (node.parentActorId) parentMissing.push(node);
    else if (node.actorType === "main") roots.push(node);
    else parentNotRecorded.push(node);
  }
  const placed = new Set();
  const visit = (node) => {
    if (placed.has(node.id)) return;
    placed.add(node.id);
    node.children.forEach(visit);
  };
  [...roots, ...parentNotRecorded, ...parentMissing].forEach(visit);
  // Anything still unplaced sits in a parent cycle, which no root reaches. Detach it from its
  // parent to break the cycle and report it as missing its parent.
  for (const node of byId.values()) {
    if (placed.has(node.id)) continue;
    const parent = byId.get(node.parentActorId);
    parent.children = parent.children.filter((child) => child !== node);
    parentMissing.push(node);
    visit(node);
  }
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: "actors",
    scope,
    actors,
    tree: { roots, parentNotRecorded, parentMissing },
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

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { databasePath } from "./config.mjs";

const require = createRequire(import.meta.url);

/**
 * Open the telemetry database for reading.
 *
 * Reads run on the caller's thread: they happen in reporting commands, never on the path that
 * forwards inference. Returns `null` when telemetry is unavailable (no database yet, or the
 * optional native driver is not installed) so a report can say "no data" instead of failing.
 */
export function openReader({ env = process.env, path = null } = {}) {
  const file = path ?? databasePath(env);
  if (file !== ":memory:" && !existsSync(file)) return null;
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch {
    return null;
  }
  try {
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

const rows = (db, sql, params = []) => db.prepare(sql).all(...params);
const row = (db, sql, params = []) => db.prepare(sql).get(...params);

/** `WHERE` fragment plus parameters for the optional session filter every reader accepts. */
function scope({ sessionId = null, projectPath = null } = {}, column = "session_id") {
  if (sessionId) return { where: `WHERE ${column} = ?`, params: [sessionId] };
  if (projectPath) {
    return {
      where: `WHERE ${column} IN (SELECT id FROM sessions WHERE project_path = ?)`,
      params: [projectPath],
    };
  }
  return { where: "", params: [] };
}

export function listSessions(db, { limit = 25, projectPath = null } = {}) {
  return rows(
    db,
    `SELECT s.id, s.claude_session_id AS claudeSessionId, s.project_path AS projectPath,
            s.started_at AS startedAt, s.ended_at AS endedAt, s.router_version AS routerVersion,
            s.claude_version AS claudeVersion, s.launch_mode AS launchMode,
            s.jev_provider AS jevProvider,
            (SELECT COUNT(*) FROM routes r WHERE r.session_id = s.id) AS routes,
            (SELECT COUNT(*) FROM inference_requests q WHERE q.session_id = s.id) AS requests
       FROM sessions s
      ${projectPath ? "WHERE s.project_path = ?" : ""}
      ORDER BY s.started_at DESC
      LIMIT ?`,
    projectPath ? [projectPath, limit] : [limit],
  );
}

export function findSession(db, sessionId) {
  return row(
    db,
    `SELECT id, claude_session_id AS claudeSessionId, project_path AS projectPath,
            started_at AS startedAt, ended_at AS endedAt, router_version AS routerVersion,
            claude_version AS claudeVersion, launch_mode AS launchMode,
            jev_provider AS jevProvider
       FROM sessions
      WHERE id = ? OR claude_session_id = ?
      ORDER BY started_at DESC
      LIMIT 1`,
    [sessionId, sessionId],
  );
}

/**
 * Route counts are *fresh effective decisions*. Continuations never create a route row, so
 * these totals answer "how many times was something chosen", not "how many requests ran".
 */
export function routeDistribution(db, filter = {}) {
  const { where, params } = scope(filter);
  return rows(
    db,
    `SELECT effective_profile AS profile, model, tier, effective_effort AS effort,
            source, COUNT(*) AS routes
       FROM routes ${where}
      GROUP BY effective_profile, model, tier, effective_effort, source
      ORDER BY routes DESC, model ASC`,
    params,
  );
}

/** Requests split by classification, which is where the fresh/continuation ratio comes from. */
export function requestBreakdown(db, filter = {}) {
  const { where, params } = scope(filter);
  return rows(
    db,
    `SELECT classification, is_continuation AS isContinuation, model, effort,
            COUNT(*) AS requests,
            SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS succeeded
       FROM inference_requests ${where}
      GROUP BY classification, is_continuation, model, effort
      ORDER BY requests DESC`,
    params,
  );
}

export function actorBreakdown(db, filter = {}) {
  const { where, params } = scope(filter, "a.session_id");
  return rows(
    db,
    `SELECT a.id, a.actor_type AS actorType, a.agent_name AS agentName,
            a.parent_actor_id AS parentActorId, a.created_at AS createdAt,
            a.last_seen_at AS lastSeenAt,
            (SELECT COUNT(*) FROM routes r WHERE r.actor_id = a.id) AS routes,
            (SELECT COUNT(*) FROM inference_requests q WHERE q.actor_id = a.id) AS requests,
            (SELECT COUNT(*) FROM inference_requests q
              WHERE q.actor_id = a.id AND q.is_continuation = 1) AS continuations,
            (SELECT GROUP_CONCAT(DISTINCT r.model) FROM routes r WHERE r.actor_id = a.id) AS models
       FROM actors a ${where}
      ORDER BY a.created_at ASC`,
    params,
  );
}

/**
 * Claude token totals, with the completeness figures alongside them. `requestsMissingUsage` and
 * `requestsWithUsage` are what let a report distinguish "this session used 0 cache tokens" from
 * "we never saw the numbers" -- the spec's requirement that missing usage stays visible.
 */
export function usageTotals(db, filter = {}) {
  const { where, params } = scope(filter, "q.session_id");
  const totals = row(
    db,
    `SELECT SUM(u.input_tokens) AS inputTokens,
            SUM(u.output_tokens) AS outputTokens,
            SUM(u.cache_read_input_tokens) AS cacheReadInputTokens,
            SUM(u.cache_creation_input_tokens) AS cacheCreationInputTokens,
            COUNT(u.id) AS requestsWithUsage
       FROM usage_events u
       JOIN inference_requests q ON q.id = u.request_id
       ${where}`,
    params,
  );
  const counted = row(
    db,
    `SELECT COUNT(*) AS requests,
            SUM(CASE WHEN u.id IS NULL THEN 1 ELSE 0 END) AS requestsMissingUsage,
            SUM(q.response_bytes) AS responseBytes,
            SUM(q.request_bytes) AS requestBytes
       FROM inference_requests q
       LEFT JOIN usage_events u ON u.request_id = q.id
       ${where}`,
    params,
  );
  return {
    inputTokens: totals.inputTokens ?? null,
    outputTokens: totals.outputTokens ?? null,
    cacheReadInputTokens: totals.cacheReadInputTokens ?? null,
    cacheCreationInputTokens: totals.cacheCreationInputTokens ?? null,
    requests: counted.requests ?? 0,
    requestsWithUsage: totals.requestsWithUsage ?? 0,
    requestsMissingUsage: counted.requestsMissingUsage ?? 0,
    requestBytes: counted.requestBytes ?? null,
    responseBytes: counted.responseBytes ?? null,
    complete: (counted.requests ?? 0) > 0 && (counted.requestsMissingUsage ?? 0) === 0,
  };
}

/** Tokens by route, for "which routes consumed the most". */
export function usageByRoute(db, filter = {}) {
  const { where, params } = scope(filter, "r.session_id");
  return rows(
    db,
    `SELECT r.id AS routeId, r.effective_profile AS profile, r.model, r.effective_effort AS effort,
            COUNT(DISTINCT q.id) AS requests,
            SUM(u.input_tokens) AS inputTokens,
            SUM(u.output_tokens) AS outputTokens,
            SUM(u.cache_read_input_tokens) AS cacheReadInputTokens,
            SUM(u.cache_creation_input_tokens) AS cacheCreationInputTokens
       FROM routes r
       LEFT JOIN inference_requests q ON q.route_id = r.id
       LEFT JOIN usage_events u ON u.request_id = q.id
       ${where}
      GROUP BY r.id
      ORDER BY COALESCE(SUM(u.output_tokens), 0) DESC, r.timestamp ASC`,
    params,
  );
}

/**
 * Routing cost and latency. `jev_cost_usd` is the actual cost of the routing decision when the
 * provider reports it -- never an inference bill. Claude itself is on a subscription here, so
 * no Claude cost is computed or implied (spec §13.5).
 */
export function routingCost(db, filter = {}) {
  const { where, params } = scope(filter);
  const result = row(
    db,
    `SELECT COUNT(*) AS routes,
            SUM(CASE WHEN jev_decision_id IS NOT NULL THEN 1 ELSE 0 END) AS jevCalls,
            SUM(jev_cost_usd) AS jevCostUsd,
            SUM(jev_input_tokens) AS jevInputTokens,
            SUM(jev_output_tokens) AS jevOutputTokens,
            AVG(jev_latency_ms) AS averageLatencyMs,
            MIN(jev_latency_ms) AS minLatencyMs,
            MAX(jev_latency_ms) AS maxLatencyMs,
            SUM(CASE WHEN jev_cost_usd IS NULL AND jev_decision_id IS NOT NULL THEN 1 ELSE 0 END)
              AS callsWithoutCost
       FROM routes ${where}`,
    params,
  );
  const latencies = rows(
    db,
    `SELECT jev_latency_ms AS latencyMs
       FROM routes ${where ? `${where} AND` : "WHERE"} jev_latency_ms IS NOT NULL
      ORDER BY jev_latency_ms ASC`,
    params,
  ).map(({ latencyMs }) => latencyMs);
  const p95Index = latencies.length ? Math.ceil(latencies.length * 0.95) - 1 : -1;
  return {
    ...result,
    p95LatencyMs: p95Index >= 0 ? latencies[p95Index] : null,
    costComplete: (result.callsWithoutCost ?? 0) === 0,
  };
}

export function fallbackCounts(db, filter = {}) {
  const { where, params } = scope(filter);
  return rows(
    db,
    `SELECT source, fallback_reason AS fallbackReason, COUNT(*) AS routes
       FROM routes ${where}
      GROUP BY source, fallback_reason
      ORDER BY routes DESC`,
    params,
  );
}

/** Chronological fresh decisions with actor identity and observed upstream outcome. */
export function routeHistory(db, filter = {}) {
  const { where, params } = scope(filter, "r.session_id");
  return rows(
    db,
    `SELECT r.id, r.session_id AS sessionId, r.timestamp, r.classification,
            r.source, r.provider, r.jev_decision_id AS jevDecisionId,
            r.recommended_profile AS recommendedProfile,
            r.effective_profile AS effectiveProfile, r.model, r.tier,
            r.requested_effort AS requestedEffort, r.effective_effort AS effectiveEffort,
            r.confidence, r.fallback_reason AS fallbackReason,
            r.normalization_json AS normalizationJson,
            r.jev_latency_ms AS jevLatencyMs, r.jev_cost_usd AS jevCostUsd,
            a.id AS actorId, a.actor_type AS actorType, a.agent_name AS actorName,
            a.parent_actor_id AS parentActorId,
            COUNT(q.id) AS requests,
            SUM(CASE WHEN q.is_continuation = 1 THEN 1 ELSE 0 END) AS continuations,
            SUM(CASE WHEN q.success = 1 THEN 1 ELSE 0 END) AS succeeded,
            SUM(CASE WHEN q.success = 0 THEN 1 ELSE 0 END) AS failed,
            MAX(q.http_status) AS lastHttpStatus
       FROM routes r
       JOIN actors a ON a.id = r.actor_id
       LEFT JOIN inference_requests q ON q.route_id = r.id
       ${where}
      GROUP BY r.id
      ORDER BY r.timestamp ASC, r.id ASC`,
    params,
  ).map(({ normalizationJson, ...entry }) => ({
    ...entry,
    normalizationNotes: parseJsonArray(normalizationJson),
  }));
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Everything a session report needs, in one call. */
export function sessionSummary(db, sessionId) {
  const session = findSession(db, sessionId);
  if (!session) return null;
  const filter = { sessionId: session.id };
  return {
    session,
    routes: routeDistribution(db, filter),
    requests: requestBreakdown(db, filter),
    actors: actorBreakdown(db, filter),
    usage: usageTotals(db, filter),
    usageByRoute: usageByRoute(db, filter),
    routing: routingCost(db, filter),
    fallbacks: fallbackCounts(db, filter),
  };
}

/** Aggregate all sessions whose recorded project path exactly matches `projectPath`. */
export function projectSummary(db, projectPath) {
  const sessions = listSessions(db, { projectPath, limit: 100_000 });
  if (!sessions.length) return null;
  const filter = { projectPath };
  return {
    project: { path: projectPath, sessions: sessions.length },
    sessions,
    routes: routeDistribution(db, filter),
    requests: requestBreakdown(db, filter),
    actors: actorBreakdown(db, filter),
    usage: usageTotals(db, filter),
    usageByRoute: usageByRoute(db, filter),
    routing: routingCost(db, filter),
    fallbacks: fallbackCounts(db, filter),
  };
}

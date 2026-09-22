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
function scope(sessionId, column = "session_id") {
  return sessionId
    ? { where: `WHERE ${column} = ?`, params: [sessionId] }
    : { where: "", params: [] };
}

export function listSessions(db, { limit = 25 } = {}) {
  return rows(
    db,
    `SELECT s.id, s.claude_session_id AS claudeSessionId, s.project_path AS projectPath,
            s.started_at AS startedAt, s.ended_at AS endedAt, s.router_version AS routerVersion,
            s.claude_version AS claudeVersion, s.launch_mode AS launchMode,
            s.jev_provider AS jevProvider,
            (SELECT COUNT(*) FROM routes r WHERE r.session_id = s.id) AS routes,
            (SELECT COUNT(*) FROM inference_requests q WHERE q.session_id = s.id) AS requests
       FROM sessions s
      ORDER BY s.started_at DESC
      LIMIT ?`,
    [limit],
  );
}

/**
 * Route counts are *fresh effective decisions*. Continuations never create a route row, so
 * these totals answer "how many times was something chosen", not "how many requests ran".
 */
export function routeDistribution(db, { sessionId = null } = {}) {
  const { where, params } = scope(sessionId);
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
export function requestBreakdown(db, { sessionId = null } = {}) {
  const { where, params } = scope(sessionId);
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

export function actorBreakdown(db, { sessionId = null } = {}) {
  const { where, params } = scope(sessionId, "a.session_id");
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
export function usageTotals(db, { sessionId = null } = {}) {
  const { where, params } = scope(sessionId, "q.session_id");
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
export function usageByRoute(db, { sessionId = null } = {}) {
  const { where, params } = scope(sessionId, "r.session_id");
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
export function routingCost(db, { sessionId = null } = {}) {
  const { where, params } = scope(sessionId);
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
  return { ...result, costComplete: (result.callsWithoutCost ?? 0) === 0 };
}

export function fallbackCounts(db, { sessionId = null } = {}) {
  const { where, params } = scope(sessionId);
  return rows(
    db,
    `SELECT source, fallback_reason AS fallbackReason, COUNT(*) AS routes
       FROM routes ${where}
      GROUP BY source, fallback_reason
      ORDER BY routes DESC`,
    params,
  );
}

/** Everything a session report needs, in one call. */
export function sessionSummary(db, sessionId) {
  const session = row(
    db,
    `SELECT id, claude_session_id AS claudeSessionId, project_path AS projectPath,
            started_at AS startedAt, ended_at AS endedAt, router_version AS routerVersion,
            claude_version AS claudeVersion, launch_mode AS launchMode,
            jev_provider AS jevProvider
       FROM sessions WHERE id = ?`,
    [sessionId],
  );
  if (!session) return null;
  return {
    session,
    routes: routeDistribution(db, { sessionId }),
    requests: requestBreakdown(db, { sessionId }),
    actors: actorBreakdown(db, { sessionId }),
    usage: usageTotals(db, { sessionId }),
    usageByRoute: usageByRoute(db, { sessionId }),
    routing: routingCost(db, { sessionId }),
    fallbacks: fallbackCounts(db, { sessionId }),
  };
}

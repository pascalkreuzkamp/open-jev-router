import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DIR_MODE, FILE_MODE, SIDECARS } from "./config.mjs";
import { migrate } from "./schema.mjs";

const isWindows = process.platform === "win32";

/** Owner-only permissions. Windows has no mode bits; its ACL default is left to the OS. */
function restrict(path) {
  if (isWindows) return;
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    // A sidecar that does not exist yet, or a filesystem without mode bits, is not an error.
  }
}

export function restrictDatabaseFiles(path) {
  restrict(path);
  for (const suffix of SIDECARS) restrict(`${path}${suffix}`);
}

/**
 * Open (creating if needed) the telemetry database and bring its schema up to date.
 *
 * Throws on any failure. The caller treats that as "telemetry unavailable" and continues:
 * inference must never depend on this succeeding.
 */
export function openDatabase(path, { driver } = {}) {
  const Database = driver;
  if (!Database) throw new Error("no SQLite driver supplied");

  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
    if (!isWindows) {
      try {
        chmodSync(dirname(path), DIR_MODE);
      } catch {
        // An existing directory owned by the user but with a different mode is still usable.
      }
    }
  }

  const db = new Database(path);
  let journalMode = null;
  try {
    journalMode = db.pragma("journal_mode = WAL", { simple: true });
  } catch {
    // WAL is unavailable on some network filesystems; the default journal still works.
  }
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 2000");

  let migration;
  try {
    migration = migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  if (path !== ":memory:") restrictDatabaseFiles(path);
  return { db, journalMode, migration };
}

const INSERTS = {
  session: `INSERT INTO sessions
      (id, claude_session_id, project_path, started_at, ended_at, router_version, claude_version, launch_mode, jev_provider)
    VALUES
      (@id, @claudeSessionId, @projectPath, @startedAt, @endedAt, @routerVersion, @claudeVersion, @launchMode, @jevProvider)
    ON CONFLICT(id) DO UPDATE SET
      ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
      claude_session_id = COALESCE(excluded.claude_session_id, sessions.claude_session_id),
      project_path = COALESCE(excluded.project_path, sessions.project_path),
      claude_version = COALESCE(excluded.claude_version, sessions.claude_version),
      jev_provider = COALESCE(excluded.jev_provider, sessions.jev_provider)`,

  actor: `INSERT INTO actors
      (id, session_id, parent_actor_id, actor_type, agent_name, created_at, last_seen_at)
    VALUES
      (@id, @sessionId, @parentActorId, @actorType, @agentName, @createdAt, @lastSeenAt)
    ON CONFLICT(id) DO UPDATE SET
      last_seen_at = MAX(excluded.last_seen_at, actors.last_seen_at),
      parent_actor_id = COALESCE(actors.parent_actor_id, excluded.parent_actor_id),
      agent_name = COALESCE(actors.agent_name, excluded.agent_name)`,

  route: `INSERT OR IGNORE INTO routes
      (id, session_id, actor_id, logical_turn_id, timestamp, classification, source, provider,
       jev_decision_id, recommended_profile, effective_profile, model, tier, requested_effort,
       effective_effort, confidence, fallback_reason, normalization_json, jev_latency_ms,
       jev_input_tokens, jev_output_tokens, jev_cost_usd, request_hash, prompt_preview)
    VALUES
      (@id, @sessionId, @actorId, @logicalTurnId, @timestamp, @classification, @source, @provider,
       @jevDecisionId, @recommendedProfile, @effectiveProfile, @model, @tier, @requestedEffort,
       @effectiveEffort, @confidence, @fallbackReason, @normalizationJson, @jevLatencyMs,
       @jevInputTokens, @jevOutputTokens, @jevCostUsd, @requestHash, @promptPreview)`,

  request: `INSERT INTO inference_requests
      (id, session_id, actor_id, route_id, timestamp, classification, is_continuation, model,
       effort, request_bytes, response_bytes, latency_ms, http_status, success)
    VALUES
      (@id, @sessionId, @actorId, @routeId, @timestamp, @classification, @isContinuation, @model,
       @effort, @requestBytes, @responseBytes, @latencyMs, @httpStatus, @success)
    ON CONFLICT(id) DO UPDATE SET
      response_bytes = COALESCE(excluded.response_bytes, inference_requests.response_bytes),
      latency_ms = COALESCE(excluded.latency_ms, inference_requests.latency_ms),
      http_status = COALESCE(excluded.http_status, inference_requests.http_status),
      success = COALESCE(excluded.success, inference_requests.success)`,

  // One row per request. A later report for the same request replaces the earlier one, because
  // a stream's final usage supersedes the partial figures seen at message_start.
  usage: `INSERT INTO usage_events
      (request_id, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, raw_usage_json)
    VALUES
      (@requestId, @inputTokens, @outputTokens, @cacheReadInputTokens, @cacheCreationInputTokens, @rawUsageJson)
    ON CONFLICT(request_id) DO UPDATE SET
      input_tokens = COALESCE(excluded.input_tokens, usage_events.input_tokens),
      output_tokens = COALESCE(excluded.output_tokens, usage_events.output_tokens),
      cache_read_input_tokens = COALESCE(excluded.cache_read_input_tokens, usage_events.cache_read_input_tokens),
      cache_creation_input_tokens = COALESCE(excluded.cache_creation_input_tokens, usage_events.cache_creation_input_tokens),
      raw_usage_json = COALESCE(excluded.raw_usage_json, usage_events.raw_usage_json)`,
};

// Parents before children: a batch is applied in one transaction, so a route and the request
// that references it can arrive together.
const ORDER = ["session", "actor", "route", "request", "usage"];

export function createWriter(db) {
  const statements = Object.fromEntries(
    Object.entries(INSERTS).map(([kind, sql]) => [kind, db.prepare(sql)]),
  );

  const applyBatch = db.transaction((events) => {
    let written = 0;
    const rejected = [];
    for (const kind of ORDER) {
      for (const event of events) {
        if (event.kind !== kind) continue;
        try {
          statements[kind].run(event.row);
          written += 1;
        } catch (err) {
          // A constraint violation (usually a missing parent row, because telemetry was
          // enabled mid-session) drops that row only. SQLite does not roll the transaction
          // back for one, so the rest of the batch still lands.
          rejected.push({ kind, message: err.message });
        }
      }
    }
    return { written, rejected };
  });

  return { applyBatch, statements };
}

/**
 * Delete everything belonging to sessions that ended before `cutoff`. A session with no
 * `ended_at` is still active and is always preserved, whatever its start time.
 */
export function pruneRetention(db, cutoff) {
  const prune = db.transaction(() => {
    const expired = db
      .prepare("SELECT id FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?")
      .all(cutoff)
      .map(({ id }) => id);
    if (!expired.length) return { sessions: 0, routes: 0, requests: 0, usage: 0, actors: 0 };

    const list = `(${expired.map(() => "?").join(",")})`;
    const usage = db
      .prepare(
        `DELETE FROM usage_events WHERE request_id IN
           (SELECT id FROM inference_requests WHERE session_id IN ${list})`,
      )
      .run(...expired).changes;
    const requests = db
      .prepare(`DELETE FROM inference_requests WHERE session_id IN ${list}`)
      .run(...expired).changes;
    const routes = db.prepare(`DELETE FROM routes WHERE session_id IN ${list}`).run(...expired)
      .changes;
    const actors = db.prepare(`DELETE FROM actors WHERE session_id IN ${list}`).run(...expired)
      .changes;
    const sessions = db.prepare(`DELETE FROM sessions WHERE id IN ${list}`).run(...expired).changes;
    return { sessions, routes, requests, usage, actors };
  });
  return prune();
}

/**
 * Schema migrations keyed by `PRAGMA user_version`. Each entry moves the database from
 * `version - 1` to `version` and must be additive: a normal upgrade never asks a user to
 * delete telemetry (spec §23.3), so nothing here drops or rewrites an existing table.
 *
 * To change the schema, append a new entry. Never edit a released one.
 */
export const MIGRATIONS = [
  {
    version: 1,
    description: "initial sessions/actors/routes/inference_requests/usage_events schema",
    sql: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        claude_session_id TEXT,
        project_path TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        router_version TEXT NOT NULL,
        claude_version TEXT,
        launch_mode TEXT,
        jev_provider TEXT
      );

      CREATE TABLE actors (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_actor_id TEXT,
        actor_type TEXT NOT NULL,
        agent_name TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );

      CREATE TABLE routes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        logical_turn_id TEXT NOT NULL,

        timestamp INTEGER NOT NULL,
        classification TEXT NOT NULL,

        source TEXT NOT NULL,
        provider TEXT,
        jev_decision_id TEXT,

        recommended_profile TEXT,
        effective_profile TEXT NOT NULL,

        model TEXT NOT NULL,
        tier TEXT,
        requested_effort TEXT,
        effective_effort TEXT,

        confidence REAL,
        fallback_reason TEXT,
        normalization_json TEXT,

        jev_latency_ms INTEGER,
        jev_input_tokens INTEGER,
        jev_output_tokens INTEGER,
        jev_cost_usd REAL,

        request_hash TEXT,
        prompt_preview TEXT,

        FOREIGN KEY(session_id) REFERENCES sessions(id),
        FOREIGN KEY(actor_id) REFERENCES actors(id)
      );

      CREATE TABLE inference_requests (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        route_id TEXT,

        timestamp INTEGER NOT NULL,
        classification TEXT NOT NULL,
        is_continuation INTEGER NOT NULL,

        model TEXT,
        effort TEXT,

        request_bytes INTEGER,
        response_bytes INTEGER,
        latency_ms INTEGER,

        http_status INTEGER,
        success INTEGER,

        FOREIGN KEY(session_id) REFERENCES sessions(id),
        FOREIGN KEY(actor_id) REFERENCES actors(id),
        FOREIGN KEY(route_id) REFERENCES routes(id)
      );

      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,

        input_tokens INTEGER,
        output_tokens INTEGER,

        cache_read_input_tokens INTEGER,
        cache_creation_input_tokens INTEGER,

        raw_usage_json TEXT,

        FOREIGN KEY(request_id) REFERENCES inference_requests(id)
      );

      -- One usage row per request: a stream reports usage more than once (message_start and
      -- message_delta), and a retry re-delivers the same event. Both must collapse.
      CREATE UNIQUE INDEX usage_events_request ON usage_events(request_id);

      CREATE INDEX actors_session ON actors(session_id);
      CREATE INDEX routes_session ON routes(session_id, timestamp);
      CREATE INDEX routes_actor ON routes(actor_id, timestamp);
      CREATE INDEX routes_turn ON routes(session_id, actor_id, logical_turn_id);
      CREATE INDEX inference_requests_session ON inference_requests(session_id, timestamp);
      CREATE INDEX inference_requests_actor ON inference_requests(actor_id, timestamp);
      CREATE INDEX inference_requests_route ON inference_requests(route_id);
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * Bring a database up to `SCHEMA_VERSION`. Each migration runs in its own transaction, so a
 * failure leaves the database at the last version that fully applied rather than half-migrated.
 * A database newer than this build is left untouched: a downgrade must not rewrite a schema
 * it does not understand.
 */
export function migrate(db) {
  const from = db.pragma("user_version", { simple: true });
  if (from > SCHEMA_VERSION) {
    throw new Error(
      `telemetry database schema version ${from} is newer than this router understands (${SCHEMA_VERSION})`,
    );
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
  return { from, to: db.pragma("user_version", { simple: true }) };
}

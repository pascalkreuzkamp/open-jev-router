import { resolve } from "node:path";
import { findSession, listSessions } from "../telemetry/read.mjs";

const callerSessionId = (env) =>
  env.JEV_SESSION_ID ?? env.CLAUDE_SESSION_ID ?? env.JEV_CODEX_STATUS_ID ?? null;

/** Resolve `current` without silently attaching a report to the wrong live process. */
export function resolveSession(
  db,
  { requested = "current", projectPath = process.cwd(), env = process.env } = {},
) {
  if (requested && requested !== "current") {
    const session = findSession(db, requested);
    return session
      ? { session, source: "explicit" }
      : { error: "not_found", requested, candidates: [] };
  }

  const caller = callerSessionId(env);
  if (caller) {
    const session = findSession(db, caller);
    if (session) return { session, source: "caller" };
  }

  const project = resolve(projectPath);
  const sessions = listSessions(db, { projectPath: project, limit: 100_000 });
  const active = sessions.filter(({ endedAt }) => endedAt == null);
  if (active.length > 1) {
    return { error: "ambiguous", projectPath: project, candidates: active };
  }
  if (active.length === 1) return { session: active[0], source: "sole_active" };
  if (sessions.length) return { session: sessions[0], source: "most_recent" };
  return { error: "no_sessions", projectPath: project, candidates: [] };
}

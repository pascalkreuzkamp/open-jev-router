import test from "node:test";
import assert from "node:assert/strict";
import { resolveSession } from "../../../src/ui/session.mjs";

const sessions = [];
const db = {
  prepare(sql) {
    return {
      get(...params) {
        if (!sql.includes("FROM sessions")) return undefined;
        return sessions
          .filter(({ id, claudeSessionId }) => id === params[0] || claudeSessionId === params[1])
          .sort((a, b) => b.startedAt - a.startedAt)[0];
      },
      all(...params) {
        if (!sql.includes("FROM sessions")) return [];
        const projectPath = params.length === 2 ? params[0] : null;
        return sessions
          .filter((session) => !projectPath || session.projectPath === projectPath)
          .sort((a, b) => b.startedAt - a.startedAt);
      },
    };
  },
};

test.beforeEach(() => sessions.splice(0));

test("explicit session identity wins", () => {
  sessions.push({ id: "stored", claudeSessionId: "claude", projectPath: "/p", startedAt: 1 });
  const result = resolveSession(db, { requested: "claude", projectPath: "/else", env: {} });
  assert.equal(result.session.id, "stored");
  assert.equal(result.source, "explicit");
});
test("an available caller identity wins current resolution", () => {
  sessions.push({ id: "caller", projectPath: "/p", startedAt: 1 });
  const result = resolveSession(db, {
    projectPath: "/else",
    env: { JEV_SESSION_ID: "caller" },
  });
  assert.equal(result.session.id, "caller");
  assert.equal(result.source, "caller");
});

test("one active project session wins, otherwise the most recent ended session wins", () => {
  sessions.push(
    { id: "old", projectPath: "/p", startedAt: 1, endedAt: 2 },
    { id: "active", projectPath: "/p", startedAt: 3, endedAt: null },
  );
  assert.equal(resolveSession(db, { projectPath: "/p", env: {} }).session.id, "active");
  sessions[1].endedAt = 4;
  const ended = resolveSession(db, { projectPath: "/p", env: {} });
  assert.equal(ended.session.id, "active");
  assert.equal(ended.source, "most_recent");
});

test("multiple active project sessions are reported as ambiguous", () => {
  sessions.push(
    { id: "one", projectPath: "/p", startedAt: 1, endedAt: null },
    { id: "two", projectPath: "/p", startedAt: 2, endedAt: null },
  );
  const result = resolveSession(db, { projectPath: "/p", env: {} });
  assert.equal(result.error, "ambiguous");
  assert.deepEqual(result.candidates.map(({ id }) => id), ["two", "one"]);
});

test("missing explicit and current sessions remain explicit errors", () => {
  assert.equal(resolveSession(db, { requested: "missing", env: {} }).error, "not_found");
  assert.equal(resolveSession(db, { projectPath: "/none", env: {} }).error, "no_sessions");
});

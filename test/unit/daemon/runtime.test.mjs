import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNTIME_SCHEMA_VERSION,
  acquireStartLock,
  configuredPort,
  lastPortPath,
  readLastPort,
  readRuntime,
  removeRuntime,
  runtimePath,
  startLockPath,
  validPort,
  writeLastPort,
  writeRuntime,
} from "../../../src/daemon/runtime.mjs";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "jev-daemon-runtime-"));
  return { root, env: { JEV_DATA_DIR: root } };
}

function runtime(overrides = {}) {
  return {
    schema_version: RUNTIME_SCHEMA_VERSION,
    pid: process.pid,
    host: "127.0.0.1",
    port: 43127,
    started_at: new Date().toISOString(),
    router_version: "0.3.0",
    instance_id: "instance-a",
    ...overrides,
  };
}

test("runtime state is atomically written with private directory and file modes", () => {
  const space = workspace();
  const expected = runtime();
  writeRuntime(expected, space.env);

  assert.deepEqual(readRuntime(space.env), expected);
  if (process.platform !== "win32") {
    assert.equal(statSync(space.root).mode & 0o777, 0o700);
    assert.equal(statSync(runtimePath(space.env)).mode & 0o777, 0o600);
  }
});

test("invalid or corrupt runtime state is never trusted", () => {
  const space = workspace();
  writeFileSync(runtimePath(space.env), "not json");
  assert.equal(readRuntime(space.env), null);
  writeFileSync(runtimePath(space.env), JSON.stringify(runtime({ host: "0.0.0.0" })));
  assert.equal(readRuntime(space.env), null);
  writeFileSync(runtimePath(space.env), JSON.stringify(runtime({ instance_id: "" })));
  assert.equal(readRuntime(space.env), null);
});

test("runtime removal is conditional on the owning instance identifier", () => {
  const space = workspace();
  writeRuntime(runtime(), space.env);

  assert.equal(removeRuntime("some-other-instance", space.env), false);
  assert.ok(readRuntime(space.env));
  assert.equal(removeRuntime("instance-a", space.env), true);
  assert.equal(readRuntime(space.env), null);
});

test("only valid nonzero explicit ports are accepted", () => {
  assert.equal(validPort("43127"), 43127);
  assert.equal(validPort("0"), null);
  assert.equal(validPort("0", { allowZero: true }), 0);
  assert.equal(validPort("65536"), null);
  assert.equal(validPort("1.5"), null);
  assert.equal(configuredPort({}), null);
  assert.throws(() => configuredPort({ JEV_PROXY_PORT: "nope" }), /whole number/);
});

test("the last successful dynamic port is persisted privately across clean stops", () => {
  const space = workspace();
  writeLastPort(43127, space.env);

  assert.equal(readLastPort(space.env), 43127);
  if (process.platform !== "win32") {
    assert.equal(statSync(lastPortPath(space.env)).mode & 0o777, 0o600);
  }
  assert.throws(() => writeLastPort(0, space.env), /invalid daemon port/);
});

test("exclusive start locks serialize callers and can only be released by their owner", () => {
  const space = workspace();
  const first = acquireStartLock(space.env);
  assert.ok(first);
  assert.equal(acquireStartLock(space.env), null);
  if (process.platform !== "win32") {
    assert.equal(statSync(startLockPath(space.env)).mode & 0o777, 0o600);
  }

  first.release();
  const second = acquireStartLock(space.env);
  assert.ok(second);
  second.release();
});

test("malformed and dead-owner locks recover without deleting a new owner's lock", () => {
  const space = workspace();
  writeFileSync(startLockPath(space.env), "broken", { mode: 0o600 });
  const malformed = acquireStartLock(space.env);
  assert.ok(malformed);
  malformed.release();

  writeFileSync(
    startLockPath(space.env),
    JSON.stringify({ pid: 2_147_483_647, token: "dead", created_at: Date.now() }),
    { mode: 0o600 },
  );
  const recovered = acquireStartLock(space.env);
  assert.ok(recovered);
  const current = JSON.parse(readFileSync(startLockPath(space.env), "utf8"));
  assert.notEqual(current.token, "dead");
  recovered.release();
});

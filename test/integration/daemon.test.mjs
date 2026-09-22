import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "../../src/proxy.mjs";
import { processAlive, readRuntime, removeRuntime, writeRuntime } from "../../src/daemon/runtime.mjs";

const CLI = fileURLToPath(new URL("../../bin/jev.mjs", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "jev-daemon-integration-"));
  return {
    root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      USERPROFILE: root,
      TMPDIR: root,
      JEV_DATA_DIR: join(root, "data"),
      JEV_ENABLE_TELEMETRY: "0",
      NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE ?? "",
    },
  };
}

function runCLI(space, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: space.root,
      env: { ...space.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function start(space, env = {}) {
  const result = await runCLI(space, ["daemon", "start", "--json"], env);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function stop(space) {
  return runCLI(space, ["daemon", "stop", "--json"]);
}

test("daemon start, reuse, status, graceful stop, and stable-port restart", async (t) => {
  const space = workspace();
  t.after(async () => { await stop(space); });

  const first = await start(space);
  assert.equal(first.state, "running");
  assert.equal(first.alreadyRunning, false);
  assert.equal(first.runtime.host, "127.0.0.1");
  assert.ok(processAlive(first.runtime.pid));

  const duplicate = await start(space);
  assert.equal(duplicate.alreadyRunning, true);
  assert.equal(duplicate.runtime.instance_id, first.runtime.instance_id);

  const status = await runCLI(space, ["daemon", "status", "--json"]);
  assert.equal(status.code, 0, status.stderr);
  const report = JSON.parse(status.stdout);
  assert.equal(report.health.status, "ok");
  assert.equal(report.health.instance_id, first.runtime.instance_id);
  assert.equal(report.health.provider_key_available, false);
  assert.equal(JSON.stringify(report).includes("API_KEY"), false);

  const stopped = await stop(space);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(readRuntime(space.env), null);

  const restarted = await start(space);
  assert.equal(restarted.runtime.port, first.runtime.port, "the last available port is reused");
  assert.notEqual(restarted.runtime.instance_id, first.runtime.instance_id);
});

test("simultaneous starts converge on one owning instance", async (t) => {
  const space = workspace();
  t.after(async () => { await stop(space); });

  const [a, b] = await Promise.all([start(space), start(space)]);

  assert.equal(a.runtime.instance_id, b.runtime.instance_id);
  assert.equal(a.runtime.pid, b.runtime.pid);
  assert.equal([a.alreadyRunning, b.alreadyRunning].filter(Boolean).length, 1);
});

test("an occupied explicit port fails visibly and is never silently changed", async (t) => {
  const space = workspace();
  const occupied = http.createServer((_req, res) => res.end("not jev"));
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => occupied.close());

  const result = await runCLI(space, ["daemon", "start", "--json"], {
    JEV_PROXY_PORT: String(occupied.address().port),
  });

  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).code, "start_failed");
  assert.equal(readRuntime(space.env), null);
});

test("an invalid explicit port returns an operational diagnostic without a stack trace", async () => {
  const space = workspace();
  const result = await runCLI(space, ["daemon", "start", "--json"], {
    JEV_PROXY_PORT: "not-a-port",
  });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    code: "invalid_port",
    message: "JEV_PROXY_PORT must be a whole number from 1 to 65535",
  });
});

test("an occupied remembered port falls back to a new loopback port", async (t) => {
  const space = workspace();
  t.after(async () => { await stop(space); });
  const first = await start(space);
  await stop(space);
  const occupied = http.createServer((_req, res) => res.end("occupied"));
  await new Promise((resolve) => occupied.listen(first.runtime.port, "127.0.0.1", resolve));
  t.after(() => occupied.close());

  const restarted = await start(space);

  assert.notEqual(restarted.runtime.port, first.runtime.port);
  assert.equal(restarted.runtime.host, "127.0.0.1");
});

test("stale PID reuse never authorizes stopping an unrelated process", async () => {
  const space = workspace();
  writeRuntime({
    schema_version: 1,
    pid: process.pid,
    host: "127.0.0.1",
    port: 9,
    started_at: new Date().toISOString(),
    router_version: "old",
    instance_id: "stale-reused-pid",
  }, space.env);

  const result = await stop(space);

  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).code, "stale_runtime");
  assert.ok(processAlive(process.pid), "the unrelated live PID was not signalled");
  assert.ok(readRuntime(space.env), "diagnostic state is retained for explicit recovery");
});

test("a crashed daemon leaves recoverable state and restarts on its previous port", async (t) => {
  const space = workspace();
  t.after(async () => { await stop(space); });
  const first = await start(space);

  process.kill(first.runtime.pid, "SIGKILL");
  for (let tries = 0; tries < 100 && processAlive(first.runtime.pid); tries++) await delay(20);
  const restarted = await start(space);

  assert.equal(restarted.runtime.port, first.runtime.port);
  assert.notEqual(restarted.runtime.pid, first.runtime.pid);
  assert.notEqual(restarted.runtime.instance_id, first.runtime.instance_id);
});

test("runtime and start coordination files remain private", async (t) => {
  const space = workspace();
  t.after(async () => { await stop(space); });
  await start(space);

  if (process.platform !== "win32") {
    assert.equal(statSync(space.env.JEV_DATA_DIR).mode & 0o777, 0o700);
    assert.equal(statSync(join(space.env.JEV_DATA_DIR, "runtime.json")).mode & 0o777, 0o600);
  }
});

test("proxy startup rejects every non-loopback bind address", async () => {
  await assert.rejects(startProxy({ host: "0.0.0.0" }), /must be loopback/);
});

function request({ session, prompt, token }) {
  return {
    model: "jev-router",
    tools: [{ name: "Bash" }],
    ...(session
      ? { metadata: { user_id: JSON.stringify({
          session_id: session,
          actor_id: "main",
          actor_type: "main",
          logical_turn_id: `turn-${session}`,
        }) } }
      : {}),
    messages: [{ role: "user", content: prompt }],
    token,
  };
}

test("shared engine isolates sessions and forwarded authorization while unknown clients fail open", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!req.url.startsWith("/v1/messages")) {
        res.setHeader("content-type", "application/json");
        return res.end('{"data":[]}');
      }
      seen.push({ authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg","type":"message","model":"test"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const decisions = [];
  const proxy = await startProxy({
    shared: true,
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ prompt }) => {
      decisions.push(prompt);
      return {
        choice: prompt === "project a" ? "haiku-default" : "opus-high",
        confidence: 0.95,
        provider: "mock",
        ms: 1,
      };
    },
    health: {
      provider: "mock",
      provider_key_available: true,
      telemetry: false,
      api_key: "must-never-appear",
    },
    instanceId: "shared-test",
    onShutdown: () => {},
  });
  t.after(() => proxy.close());
  const send = (body, authorization) => fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(body),
  });

  const health = await fetch(`http://127.0.0.1:${proxy.port}/health`).then((response) => response.json());
  assert.equal(health.status, "ok");
  assert.equal(health.instance_id, "shared-test");
  assert.deepEqual(health.traffic, { messages: 0, routed: 0, last_message_at: null });
  assert.equal(health.api_key, undefined, "health exposes only its fixed sanitized schema");
  assert.equal(JSON.stringify(health).includes("must-never-appear"), false);

  await send(request({ session: "project-a", prompt: "project a" }), "Bearer account-a");
  await send(request({ session: "project-b", prompt: "project b" }), "Bearer account-b");
  await send(request({ prompt: "unknown client" }), "Bearer unknown");

  const after = await fetch(`http://127.0.0.1:${proxy.port}/health`).then((response) => response.json());
  assert.equal(after.traffic.messages, 3);
  assert.equal(after.traffic.routed, 2);
  assert.ok(Number.isFinite(Date.parse(after.traffic.last_message_at)));

  assert.deepEqual(decisions, ["project a", "project b"]);
  assert.deepEqual(seen.map((entry) => entry.authorization), [
    "Bearer account-a",
    "Bearer account-b",
    "Bearer unknown",
  ]);
  assert.deepEqual(seen.map((entry) => entry.body.model), [
    "claude-haiku-4-5-20251001",
    "claude-opus-5-5",
    "claude-opus-5-5",
  ]);

  const denied = await fetch(`http://127.0.0.1:${proxy.port}/shutdown`, {
    method: "POST",
    headers: { "x-jev-instance-id": "wrong-instance" },
  });
  assert.equal(denied.status, 403);
});

test("graceful close drains an in-flight response before returning", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let received;
  const arrived = new Promise((resolve) => (received = resolve));
  const upstream = http.createServer(async (req, res) => {
    req.resume();
    req.on("end", async () => {
      received();
      await gate;
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  let telemetryClosed = false;
  const proxy = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    telemetry: {
      enabled: false,
      close: async () => { telemetryClosed = true; },
    },
  });

  const response = fetch(`http://127.0.0.1:${proxy.port}/passthrough`, { method: "POST", body: "x" });
  await arrived;
  const closing = proxy.close({ timeoutMs: 1000 });
  await delay(50);
  release();

  assert.equal(await (await response).text(), '{"ok":true}');
  await closing;
  assert.equal(telemetryClosed, true, "telemetry is flushed after in-flight requests drain");
});

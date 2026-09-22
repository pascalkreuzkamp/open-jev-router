import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  acquireStartLock,
  configuredPort,
  processAlive,
  readLastPort,
  readRuntime,
  removeRuntime,
} from "./runtime.mjs";

const WORKER = fileURLToPath(new URL("../../bin/jev-daemon.mjs", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function endpoint(runtime, path) {
  const host = runtime.host === "::1" ? "[::1]" : runtime.host;
  return `http://${host}:${runtime.port}${path}`;
}

export async function probeRuntime(runtime, { timeoutMs = 500 } = {}) {
  if (!runtime) return { ok: false, reason: "missing_runtime" };
  try {
    const response = await fetch(endpoint(runtime, "/health"), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { ok: false, reason: `health_http_${response.status}` };
    const health = await response.json();
    if (
      health.status !== "ok" ||
      health.instance_id !== runtime.instance_id ||
      health.pid !== runtime.pid ||
      health.router_version !== runtime.router_version
    ) {
      return { ok: false, reason: "identity_mismatch", health };
    }
    return { ok: true, health };
  } catch (error) {
    return { ok: false, reason: error?.name === "TimeoutError" ? "health_timeout" : "health_failed" };
  }
}

export async function daemonStatus({ env = process.env, probe = probeRuntime } = {}) {
  const runtime = readRuntime(env);
  if (!runtime) return { state: "stopped", runtime: null, health: null };
  const checked = await probe(runtime);
  if (checked.ok) return { state: "running", runtime, health: checked.health };
  return {
    state: "stale",
    runtime,
    health: checked.health ?? null,
    reason: checked.reason,
    pidAlive: processAlive(runtime.pid),
  };
}

export async function startDaemon({
  env = process.env,
  timeoutMs = 8000,
  probe = probeRuntime,
  spawnProcess = spawn,
} = {}) {
  let explicitPort;
  try {
    explicitPort = configuredPort(env);
  } catch (error) {
    return { ok: false, code: "invalid_port", message: error.message };
  }
  const deadline = Date.now() + timeoutMs;
  let lock = null;
  while (!lock && Date.now() < deadline) {
    lock = acquireStartLock(env);
    if (!lock) await delay(50);
  }
  if (!lock) return { ok: false, code: "start_locked", message: "another daemon start is still in progress" };

  try {
    const previous = readRuntime(env);
    if (previous) {
      const checked = await probe(previous);
      if (checked.ok) {
        return { ok: true, alreadyRunning: true, runtime: previous, health: checked.health };
      }
      // A stale PID, including a reused PID, never authorizes a signal. Removing only the
      // instance-matched metadata is safe; the new daemon will allocate elsewhere if needed.
      removeRuntime(previous.instance_id, env);
    }

    const requestedPort = explicitPort ?? previous?.port ?? readLastPort(env) ?? 0;
    const child = spawnProcess(process.execPath, [WORKER], {
      detached: true,
      stdio: "ignore",
      env: {
        ...env,
        JEV_DAEMON_PORT: String(requestedPort),
        JEV_DAEMON_EXPLICIT_PORT: explicitPort == null ? "0" : "1",
      },
    });
    let spawnError = null;
    child.once?.("error", (error) => {
      spawnError = error;
    });
    child.unref?.();

    while (Date.now() < deadline) {
      if (spawnError) {
        return { ok: false, code: "start_failed", message: `the daemon process could not start: ${spawnError.message}` };
      }
      const runtime = readRuntime(env);
      if (runtime && runtime.pid === child.pid) {
        const checked = await probe(runtime);
        if (checked.ok) return { ok: true, alreadyRunning: false, runtime, health: checked.health };
      }
      if (child.exitCode != null) {
        return {
          ok: false,
          code: "start_failed",
          message: explicitPort == null
            ? "the daemon exited before becoming healthy"
            : `the daemon could not bind explicit port ${explicitPort}`,
        };
      }
      await delay(50);
    }
    if (child.pid && processAlive(child.pid)) child.kill("SIGTERM");
    return { ok: false, code: "start_timeout", message: "the daemon did not become healthy in time" };
  } finally {
    lock.release();
  }
}

export async function stopDaemon({ env = process.env, timeoutMs = 5000, probe = probeRuntime } = {}) {
  const runtime = readRuntime(env);
  if (!runtime) return { ok: true, alreadyStopped: true };
  const checked = await probe(runtime);
  if (!checked.ok) {
    return {
      ok: false,
      code: "stale_runtime",
      message: "runtime state does not identify a healthy Jev daemon; no process was signalled",
      reason: checked.reason,
    };
  }
  try {
    const response = await fetch(endpoint(runtime, "/shutdown"), {
      method: "POST",
      signal: AbortSignal.timeout(1000),
      headers: { "x-jev-instance-id": runtime.instance_id },
    });
    if (response.status !== 202) {
      return { ok: false, code: "stop_refused", message: `daemon refused shutdown (${response.status})` };
    }
  } catch {
    return { ok: false, code: "stop_failed", message: "daemon shutdown request failed; no process was signalled" };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = readRuntime(env);
    if (!current || current.instance_id !== runtime.instance_id) {
      return { ok: true, alreadyStopped: false, runtime };
    }
    await delay(50);
  }
  return { ok: false, code: "stop_timeout", message: "daemon did not stop within the drain timeout" };
}

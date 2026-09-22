import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dataDir, DIR_MODE, FILE_MODE } from "../telemetry/config.mjs";

export const RUNTIME_SCHEMA_VERSION = 1;
export const RUNTIME_FILENAME = "runtime.json";
export const START_LOCK_FILENAME = "daemon-start.lock";
export const LAST_PORT_FILENAME = "daemon-port.json";
export const START_LOCK_STALE_MS = 30_000;

export const runtimePath = (env = process.env) => join(dataDir(env), RUNTIME_FILENAME);
export const startLockPath = (env = process.env) => join(dataDir(env), START_LOCK_FILENAME);
export const lastPortPath = (env = process.env) => join(dataDir(env), LAST_PORT_FILENAME);

export function ensureRuntimeDir(env = process.env) {
  const dir = dataDir(env);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
  return dir;
}

export function validPort(value, { allowZero = false } = {}) {
  const port = Number(value);
  return Number.isInteger(port) && port >= (allowZero ? 0 : 1) && port <= 65_535 ? port : null;
}

export function configuredPort(env = process.env) {
  if (env.JEV_PROXY_PORT == null || env.JEV_PROXY_PORT === "") return null;
  const port = validPort(env.JEV_PROXY_PORT);
  if (port == null) throw new Error("JEV_PROXY_PORT must be a whole number from 1 to 65535");
  return port;
}

export function validateRuntime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.schema_version !== RUNTIME_SCHEMA_VERSION) return null;
  if (!Number.isInteger(value.pid) || value.pid <= 0) return null;
  if (validPort(value.port) == null) return null;
  if (value.host !== "127.0.0.1" && value.host !== "::1") return null;
  if (typeof value.started_at !== "string" || !Number.isFinite(Date.parse(value.started_at))) return null;
  if (typeof value.router_version !== "string" || !value.router_version) return null;
  if (typeof value.instance_id !== "string" || !value.instance_id) return null;
  return { ...value };
}

export function readRuntime(env = process.env) {
  try {
    const file = runtimePath(env);
    const stat = statSync(file);
    if (process.getuid && stat.uid !== process.getuid()) return null;
    return validateRuntime(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function writeRuntime(runtime, env = process.env) {
  const value = validateRuntime(runtime);
  if (!value) throw new Error("refusing to write invalid daemon runtime state");
  const dir = ensureRuntimeDir(env);
  const target = runtimePath(env);
  const temporary = join(dir, `.${RUNTIME_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE, flag: "wx" });
    chmodSync(temporary, FILE_MODE);
    renameSync(temporary, target);
    chmodSync(target, FILE_MODE);
  } catch (error) {
    tryUnlink(temporary);
    throw error;
  }
  return target;
}

export function readLastPort(env = process.env) {
  try {
    const value = JSON.parse(readFileSync(lastPortPath(env), "utf8"));
    return value?.schema_version === 1 ? validPort(value.port) : null;
  } catch {
    return null;
  }
}

export function writeLastPort(port, env = process.env) {
  const valid = validPort(port);
  if (valid == null) throw new Error("refusing to persist an invalid daemon port");
  const dir = ensureRuntimeDir(env);
  const target = lastPortPath(env);
  const temporary = join(dir, `.${LAST_PORT_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify({ schema_version: 1, port: valid })}\n`, {
      mode: FILE_MODE,
      flag: "wx",
    });
    chmodSync(temporary, FILE_MODE);
    renameSync(temporary, target);
    chmodSync(target, FILE_MODE);
  } catch (error) {
    tryUnlink(temporary);
    throw error;
  }
  return target;
}

export function removeRuntime(instanceId, env = process.env) {
  const current = readRuntime(env);
  if (!current || current.instance_id !== instanceId) return false;
  tryUnlink(runtimePath(env));
  return true;
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function acquireStartLock(env = process.env, now = Date.now()) {
  ensureRuntimeDir(env);
  const file = startLockPath(env);
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let descriptor;
    try {
      descriptor = openSync(file, "wx", FILE_MODE);
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token, created_at: now })}\n`);
      closeSync(descriptor);
      descriptor = null;
      chmodSync(file, FILE_MODE);
      return {
        token,
        release: () => releaseStartLock(token, env),
      };
    } catch (error) {
      if (descriptor != null) closeSync(descriptor);
      if (error?.code !== "EEXIST" || attempt > 0) return null;
      if (!startLockIsStale(env, now)) return null;
      tryUnlink(file);
    }
  }
  return null;
}

function startLockIsStale(env, now) {
  try {
    const lock = JSON.parse(readFileSync(startLockPath(env), "utf8"));
    return !processAlive(lock.pid) || !Number.isFinite(lock.created_at) ||
      now - lock.created_at > START_LOCK_STALE_MS;
  } catch {
    return true;
  }
}

function releaseStartLock(token, env) {
  try {
    const lock = JSON.parse(readFileSync(startLockPath(env), "utf8"));
    if (lock.token === token && lock.pid === process.pid) tryUnlink(startLockPath(env));
  } catch {
    // A crashed or replaced lock is not ours to remove.
  }
}

export function tryUnlink(file) {
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

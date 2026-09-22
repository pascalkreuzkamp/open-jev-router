import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { debug } from "../log.mjs";
import { databasePath, retentionCutoff, telemetryEnabled } from "./config.mjs";

const WORKER_URL = new URL("./worker.mjs", import.meta.url);

/** Bounded so a stalled writer costs memory that stays flat rather than growing with traffic. */
export const MAX_QUEUED_EVENTS = 2000;
export const MAX_BATCH = 128;
/**
 * Batches posted but not yet acknowledged. Without this the queue bound would be meaningless:
 * a stalled writer would simply accumulate in-flight batches instead of queued events.
 */
export const MAX_IN_FLIGHT_BATCHES = 4;
export const FLUSH_INTERVAL_MS = 250;
export const SHUTDOWN_WAIT_MS = 2000;

const nullRecorder = {
  enabled: false,
  newId: () => randomUUID(),
  record() {},
  session() {},
  actor() {},
  route() {},
  request() {},
  usage() {},
  stats: () => ({
    enabled: false,
    queued: 0,
    accepted: 0,
    written: 0,
    droppedQueueFull: 0,
    rejected: 0,
    failed: false,
  }),
  async flush() {},
  async prune() {
    return null;
  },
  async close() {},
};

/** A recorder that accepts everything and stores nothing, used when telemetry is off. */
export const disabledRecorder = () => nullRecorder;

/**
 * Buffered, worker-backed telemetry recorder.
 *
 * Every entry point is synchronous and non-throwing: recording is a side effect of routing,
 * never a step it depends on. Events queue in memory, are written in batched transactions by
 * `worker.mjs`, and are counted when they cannot be (queue full, worker dead, write rejected)
 * so the numbers a report shows can be qualified rather than quietly wrong.
 */
export function createRecorder({
  env = process.env,
  path = null,
  workerURL = WORKER_URL,
  autoStart = true,
} = {}) {
  if (!telemetryEnabled(env)) return nullRecorder;

  const file = path ?? databasePath(env);
  const queue = [];
  const pending = new Map();
  // The same outstanding messages keyed by id, as promises, so a waiter can await one.
  const outstanding = new Map();
  const counters = { accepted: 0, written: 0, droppedQueueFull: 0, rejected: 0 };
  let worker = null;
  let fatal = null;
  let timer = null;
  let ready = null;

  function start() {
    if (worker || fatal) return;
    try {
      worker = new Worker(workerURL, { workerData: { path: file } });
    } catch (err) {
      stop(`worker could not start: ${err.message}`);
      return;
    }
    worker.unref();
    ready = new Promise((resolve) => {
      const settle = (value) => resolve(value);
      worker.once("message", (message) => {
        if (message.type === "ready") return settle(message);
        if (message.type === "fatal") {
          stop(`${message.stage}: ${message.message}`);
          return settle(null);
        }
        settle(null);
      });
      worker.once("error", () => settle(null));
    });
    worker.on("message", (message) => {
      if (message.type === "fatal") return stop(`${message.stage}: ${message.message}`);
      if (message.type !== "ack") return;
      counters.written += message.written ?? 0;
      counters.rejected += message.rejected?.length ?? 0;
      for (const { kind, message: reason } of message.rejected ?? []) {
        debug(`telemetry rejected a ${kind} row: ${reason}`);
      }
      const settle = pending.get(message.id);
      if (settle) {
        pending.delete(message.id);
        settle(message);
      }
    });
    worker.on("error", (err) => stop(`worker error: ${err.message}`));
    worker.on("exit", () => {
      worker = null;
      for (const settle of pending.values()) settle(null);
      pending.clear();
    });
  }

  function stop(reason) {
    if (!fatal) {
      fatal = reason;
      // The one message a user can act on: telemetry is off for this run, and why.
      debug(`telemetry disabled for this session (${reason})`);
    }
    counters.droppedQueueFull += queue.length;
    queue.length = 0;
    if (timer) clearTimeout(timer);
    timer = null;
    const dying = worker;
    worker = null;
    dying?.terminate().catch(() => {});
    for (const settle of pending.values()) settle(null);
    pending.clear();
    outstanding.clear();
  }

  function scheduleFlush() {
    if (timer || fatal) return;
    timer = setTimeout(() => {
      timer = null;
      send();
    }, FLUSH_INTERVAL_MS);
    timer.unref?.();
  }

  function send() {
    if (fatal || !queue.length) return null;
    // Wait for the writer to catch up rather than handing it more work it cannot take.
    if (pending.size >= MAX_IN_FLIGHT_BATCHES) return null;
    start();
    if (!worker) return null;
    const batch = queue.splice(0, MAX_BATCH);
    const id = randomUUID();
    const settled = track(id);
    try {
      worker.postMessage({ type: "events", id, batch });
    } catch (err) {
      pending.delete(id);
      counters.droppedQueueFull += batch.length;
      stop(`could not post to worker: ${err.message}`);
      return null;
    }
    return settled;
  }

  /** Register an outstanding worker message and return the promise that its ack settles. */
  function track(id) {
    const settled = new Promise((resolve) => pending.set(id, resolve));
    outstanding.set(id, settled);
    settled.then(() => outstanding.delete(id));
    return settled;
  }

  /** The batch that has been waiting longest, used to make progress when the writer is behind. */
  function oldestPending() {
    for (const id of pending.keys()) return outstanding.get(id) ?? null;
    return null;
  }

  function record(kind, row) {
    if (fatal) return;
    if (queue.length >= MAX_QUEUED_EVENTS) {
      counters.droppedQueueFull += 1;
      return;
    }
    queue.push({ kind, row });
    counters.accepted += 1;
    if (autoStart) start();
    if (queue.length >= MAX_BATCH) send();
    else scheduleFlush();
  }

  const recorder = {
    enabled: true,
    databasePath: file,
    newId: () => randomUUID(),
    record,
    session: (row) => record("session", row),
    actor: (row) => record("actor", row),
    route: (row) => record("route", row),
    request: (row) => record("request", row),
    usage: (row) => record("usage", row),

    stats: () => ({
      enabled: !fatal,
      queued: queue.length,
      accepted: counters.accepted,
      written: counters.written,
      droppedQueueFull: counters.droppedQueueFull,
      rejected: counters.rejected,
      failed: Boolean(fatal),
      failureReason: fatal,
    }),

    /** Wait for the queue to drain, bounded: a stuck writer must not hold up an exit. */
    async flush({ timeoutMs = SHUTDOWN_WAIT_MS } = {}) {
      if (fatal) return;
      start();
      await Promise.race([ready, delay(timeoutMs)]);
      const deadline = Date.now() + timeoutMs;
      while ((queue.length || pending.size) && !fatal && Date.now() < deadline) {
        const sent = send() ?? oldestPending();
        if (!sent) break;
        await Promise.race([sent, delay(Math.max(0, deadline - Date.now()))]);
      }
      const last = send();
      if (last) await Promise.race([last, delay(Math.max(0, deadline - Date.now()))]);
    },

    async prune({ now = Date.now(), timeoutMs = SHUTDOWN_WAIT_MS } = {}) {
      if (fatal) return null;
      start();
      if (!worker) return null;
      await Promise.race([ready, delay(timeoutMs)]);
      if (!worker || fatal) return null;
      const id = randomUUID();
      const settled = track(id);
      worker.postMessage({ type: "prune", id, cutoff: retentionCutoff(env, now) });
      const result = await Promise.race([settled, delay(timeoutMs)]);
      return result?.removed ?? null;
    },

    async close({ timeoutMs = SHUTDOWN_WAIT_MS } = {}) {
      if (timer) clearTimeout(timer);
      timer = null;
      if (fatal || !worker) return;
      await recorder.flush({ timeoutMs });
      if (!worker) return;
      const id = randomUUID();
      const settled = track(id);
      try {
        worker.postMessage({ type: "close", id });
        await Promise.race([settled, delay(timeoutMs)]);
      } catch {
        // Already gone; terminate below covers it.
      }
      await worker?.terminate().catch(() => {});
      worker = null;
    },
  };

  if (autoStart) start();
  return recorder;
}

const delay = (ms) =>
  new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    handle.unref?.();
  });

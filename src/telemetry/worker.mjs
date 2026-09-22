/**
 * Telemetry writer worker. Every SQLite call in the router happens here, off the thread that
 * forwards inference, so a slow disk or a locked database cannot stall a response.
 *
 * The worker only ever replies; it never throws into the parent. A failure it cannot recover
 * from is reported as a `fatal` message, after which the parent stops sending events.
 */
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { createWriter, openDatabase, pruneRetention } from "./store.mjs";

const require = createRequire(import.meta.url);

let db = null;
let writer = null;

function fail(stage, err) {
  parentPort.postMessage({ type: "fatal", stage, message: err?.message ?? String(err) });
}

try {
  const driver = require("better-sqlite3");
  const opened = openDatabase(workerData.path, { driver });
  db = opened.db;
  writer = createWriter(db);
  parentPort.postMessage({
    type: "ready",
    journalMode: opened.journalMode,
    migration: opened.migration,
  });
} catch (err) {
  fail("open", err);
}

parentPort.on("message", (message) => {
  if (!db) return;
  try {
    if (message.type === "events") {
      const result = writer.applyBatch(message.batch);
      parentPort.postMessage({ type: "ack", id: message.id, ...result });
      return;
    }
    if (message.type === "prune") {
      const removed = pruneRetention(db, message.cutoff);
      parentPort.postMessage({ type: "ack", id: message.id, removed });
      return;
    }
    if (message.type === "close") {
      db.close();
      db = null;
      parentPort.postMessage({ type: "ack", id: message.id, closed: true });
      parentPort.close();
    }
  } catch (err) {
    // A write failure (disk full, locked database) loses that batch and nothing else. The
    // parent counts it as dropped and keeps forwarding inference.
    parentPort.postMessage({
      type: "ack",
      id: message.id,
      written: 0,
      rejected: [{ kind: message.type, message: err?.message ?? String(err) }],
      failed: true,
    });
  }
});

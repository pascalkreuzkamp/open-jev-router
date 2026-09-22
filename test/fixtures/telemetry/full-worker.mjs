/**
 * Behaves like SQLite after a disk-full write: the worker stays alive, but every event in the
 * batch is rejected. This makes the failure deterministic without filling the host filesystem.
 */
import { parentPort } from "node:worker_threads";

parentPort.postMessage({ type: "ready", journalMode: "wal", migration: { from: 0, to: 1 } });
parentPort.on("message", (message) => {
  if (message.type === "events") {
    parentPort.postMessage({
      type: "ack",
      id: message.id,
      written: 0,
      rejected: message.batch.map(({ kind }) => ({ kind, message: "database or disk is full" })),
      failed: true,
    });
    return;
  }
  if (message.type === "close") {
    parentPort.postMessage({ type: "ack", id: message.id, closed: true });
    parentPort.close();
  }
});

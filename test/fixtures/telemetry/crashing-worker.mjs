/**
 * A telemetry writer that reports itself ready and then dies on the first batch.
 * Used to prove that a writer crashing mid-session disables telemetry without disturbing
 * anything the router is doing.
 */
import { parentPort } from "node:worker_threads";

parentPort.postMessage({ type: "ready", journalMode: "memory", migration: { from: 0, to: 1 } });
parentPort.on("message", () => {
  throw new Error("writer crashed");
});

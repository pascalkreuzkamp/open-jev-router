/**
 * A telemetry writer that reports itself ready and then never acknowledges anything.
 * Used to observe the recorder's queue bound: with no acknowledgements, events accumulate
 * until the bound stops them, which is the condition a real stalled disk produces.
 */
import { parentPort } from "node:worker_threads";

parentPort.postMessage({ type: "ready", journalMode: "memory", migration: { from: 0, to: 1 } });
parentPort.on("message", () => {});

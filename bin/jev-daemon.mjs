#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { startProxy } from "../src/proxy.mjs";
import { loadCredentialFiles } from "../src/credentials.mjs";
import { hasAnyProviderKey, selectProvider } from "../src/providers/select.mjs";
import { ROUTER_VERSION } from "../src/version.mjs";
import {
  RUNTIME_SCHEMA_VERSION,
  removeRuntime,
  validPort,
  writeLastPort,
  writeRuntime,
} from "../src/daemon/runtime.mjs";

loadCredentialFiles();

const env = process.env;
const requestedPort = validPort(env.JEV_DAEMON_PORT, { allowZero: true });
if (requestedPort == null) throw new Error("invalid daemon port");
const explicitPort = env.JEV_DAEMON_EXPLICIT_PORT === "1";
const instanceId = randomUUID();
const selected = selectProvider(env);
let proxy = null;
let stopping = null;

async function shutdown(exitCode = 0) {
  if (stopping) return stopping;
  stopping = (async () => {
    await proxy?.close({ timeoutMs: 2500 }).catch(() => {});
    removeRuntime(instanceId, env);
    process.exitCode = exitCode;
  })();
  return stopping;
}

const options = {
  shared: true,
  host: "127.0.0.1",
  launchMode: "daemon",
  projectPath: null,
  instanceId,
  health: () => ({
    provider: selected.status === "ok" ? selected.provider.name : selected.name ?? "unavailable",
    provider_key_available: hasAnyProviderKey(env),
    telemetry: Boolean(proxy?.telemetry?.enabled),
    traffic: proxy?.traffic
      ? {
          messages: proxy.traffic.messages,
          routed: proxy.traffic.routed,
          last_message_at: proxy.traffic.lastMessageAt,
        }
      : null,
  }),
  onShutdown: () => shutdown(),
};

try {
  proxy = await startProxy({ ...options, port: requestedPort });
} catch (error) {
  if (error?.code !== "EADDRINUSE" || explicitPort || requestedPort === 0) throw error;
  proxy = await startProxy({ ...options, port: 0 });
}

writeLastPort(proxy.port, env);
writeRuntime({
  schema_version: RUNTIME_SCHEMA_VERSION,
  pid: process.pid,
  host: proxy.host,
  port: proxy.port,
  started_at: new Date().toISOString(),
  router_version: ROUTER_VERSION,
  instance_id: instanceId,
}, env);

if (proxy.telemetry?.enabled) proxy.telemetry.prune().catch(() => {});

process.once("SIGTERM", () => shutdown());
process.once("SIGINT", () => shutdown());

process.on("uncaughtException", async () => {
  await shutdown(1);
  process.exit(1);
});
process.on("unhandledRejection", async () => {
  await shutdown(1);
  process.exit(1);
});

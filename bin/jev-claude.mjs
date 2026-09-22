#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "../src/proxy.mjs";
import { proxyEnv, resolveExecutable, spawnArgs } from "../src/launch.mjs";
import { readSavedModel, restoreSavedModel } from "../src/settings.mjs";
import { LOG_FILE } from "../src/log.mjs";
import { boolEnv } from "../src/env.mjs";
import { selectProvider, hasAnyProviderKey, unavailableMessage } from "../src/providers/select.mjs";
import { loadCredentialFiles } from "../src/credentials.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

/**
 * Claude Code saves a picker row chosen with Enter as the default for new sessions, so the
 * value from before this session is captured now and put back on the way out.
 */
const savedModelBefore = readSavedModel();

/**
 * Claude Code's UI shows the model it asked for, never the one the proxy routed to, so a
 * status line is the only way to surface the decision. `--settings` merges rather than
 * replaces, but a status line the user configured themselves still takes priority: theirs
 * is a deliberate choice and silently overwriting it would be worse than showing nothing.
 */
function statusLineArgs() {
  if (process.env.JEV_NO_STATUSLINE) return [];
  for (const dir of [join(process.cwd(), ".claude"), join(homedir(), ".claude")]) {
    try {
      if (JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).statusLine) return [];
    } catch {
      // No settings file, or unreadable; nothing to preserve.
    }
  }
  // Passed as a file rather than inline JSON: on Windows the args go through a shell, and a
  // JSON string containing its own quotes does not survive that.
  const command = `"${process.execPath}" "${join(HERE, "jev-statusline.mjs")}"`;
  const file = join(tmpdir(), "jev-claude", "settings.json");
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ statusLine: { type: "command", command } }));
  } catch {
    return [];
  }
  return ["--settings", file];
}

// Existing environment variables win, followed by project-local, shared user-level, then
// the legacy Claude-specific file.
loadCredentialFiles();

const args = process.argv.slice(2);
args.push("--add-dir", ROOT);
const env = { ...process.env };

const claude = resolveExecutable("claude");
if (!claude) {
  process.stderr.write(
    "[jev] Claude Code is not installed, or `claude` is not on your PATH.\n" +
      "[jev] jev-claude runs the real Claude Code CLI; install it first:\n" +
      "[jev]   https://code.claude.com/docs/en/setup\n",
  );
  process.exit(1);
}

// Set when routing is active, so the child's exit can flush telemetry before leaving.
let shutdownProxy = null;

if (hasAnyProviderKey()) {
  const { port, close, telemetry } = await startProxy();
  shutdownProxy = close;
  Object.assign(env, proxyEnv(`http://127.0.0.1:${port}`));
  process.on("exit", () => {
    // A synchronous safety net for an abrupt exit. The normal path awaits `close()` below,
    // which also flushes telemetry; this only guarantees the saved model is restored.
    restoreSavedModel(savedModelBefore);
  });

  if (telemetry?.enabled) {
    // Retention runs once per launch, in the background. It is bounded and never blocks the
    // session; a failure leaves existing data untouched.
    telemetry.prune().catch(() => {});
  }
  args.push(...statusLineArgs());

  const selected = selectProvider();
  if (selected.status === "ok") {
    process.stderr.write(
      `[jev] routing via ${selected.provider.name}; fresh task text is sent for routing, ` +
        `not full tool output or repository contents\n`,
    );
    // Bounded and free: confirms the provider is reachable without spending on a decision,
    // and must never delay or block Claude Code from starting.
    selected.provider.healthCheck().then(
      (health) => {
        if (!health.ok) process.stderr.write(`[jev] ${selected.provider.name} health check failed: ${health.message}\n`);
      },
      () => {},
    );
  } else {
    process.stderr.write(
      `[jev] routing is unavailable (${unavailableMessage(selected)}); Claude Code will run unrouted\n`,
    );
  }

  if (boolEnv("JEV_DEBUG") && process.stdout.isTTY) {
    process.stderr.write(`[jev] routing decisions -> ${LOG_FILE}\n`);
  }
} else {
  process.stderr.write(
    `[jev] no provider key found - starting Claude Code without routing\n` +
      `[jev] set OPENROUTER_API_KEY, JEV_API_KEY, or TYPESAFE_API_KEY in ${join(homedir(), ".jev-claude.env")} to enable routing\n`,
  );
}

// On Windows a `.cmd` shim still needs a shell; a real executable does not.
const child = spawn(claude.file, spawnArgs(claude, args), {
  stdio: "inherit",
  shell: claude.shell,
  env,
});

child.on("error", (err) => {
  process.stderr.write(`[jev] could not start Claude Code: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", async (code, signal) => {
  // Bounded: a stuck telemetry writer delays the exit by at most its own timeout.
  await shutdownProxy?.().catch(() => {});
  process.exit(signal ? 1 : (code ?? 0));
});

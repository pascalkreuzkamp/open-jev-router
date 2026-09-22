#!/usr/bin/env node
// Opens VS Code with the Claude Code extension pointed at the Jev daemon. Starts or reuses the
// daemon, then spawns `code` with ANTHROPIC_BASE_URL in its environment. Settings, credentials
// and the extension itself are left untouched.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { startDaemon as startSharedDaemon } from "../src/daemon/control.mjs";
import { loadCredentialFiles } from "../src/credentials.mjs";
import { proxyEnv, spawnArgs } from "../src/launch.mjs";
import { resolveCode } from "../src/vscode/discover.mjs";
import { daemonBaseURL } from "../src/vscode/doctor.mjs";

/**
 * @returns {Promise<number>} the exit code. `code` returns as soon as it has handed off to a
 *   window, so this is the CLI's exit code, not the editor's lifetime.
 */
export async function launch(
  args,
  { env = process.env, platform = process.platform, startDaemon = startSharedDaemon, spawnProcess = spawn, write = (s) => process.stderr.write(s) } = {},
) {
  const code = resolveCode({ env, platform });
  if (!code) {
    write(
      "[jev] VS Code's `code` command is not on your PATH.\n" +
        "[jev] In VS Code run \"Shell Command: Install 'code' command in PATH\", or set JEV_VSCODE_BIN.\n",
    );
    return 1;
  }
  const daemon = await startDaemon({ env });
  if (!daemon.ok) {
    write(`[jev] the router daemon could not start (${daemon.code}): ${daemon.message}\n`);
    write("[jev] VS Code was not opened. Fallback: run `jev-claude` in a terminal.\n");
    return 1;
  }
  const baseURL = daemonBaseURL(daemon.runtime);
  write(`[jev] daemon ${daemon.alreadyRunning ? "reused" : "started"} at ${baseURL}\n`);
  write(
    "[jev] if a VS Code window was already open, it keeps its old environment: close all windows\n" +
      "[jev] first, or use `jev vscode doctor` to set the extension's environment variables instead.\n",
  );
  // The editor's own model default is left alone; the "Jev Router" row is offered in the
  // picker, and the doctor's traffic check is how a user confirms requests arrive.
  const childEnv = { ...env, ...proxyEnv(baseURL, { env, defaultToRouter: false }) };
  return new Promise((resolve) => {
    const child = spawnProcess(code.file, spawnArgs(code, args), { stdio: "inherit", shell: code.shell, env: childEnv });
    child.on("error", (error) => {
      write(`[jev] could not start VS Code: ${error.message}\n`);
      resolve(1);
    });
    child.on("exit", (exitCode, signal) => resolve(signal ? 1 : (exitCode ?? 0)));
  });
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  loadCredentialFiles();
  process.exitCode = await launch(process.argv.slice(2));
}

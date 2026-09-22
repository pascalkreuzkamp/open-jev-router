// Discovers the installed VS Code and Claude Code extension versions through the `code` CLI.
// Anything that cannot be discovered is reported as unknown, never as success.
import { execFile } from "node:child_process";
import { resolveExecutable, spawnArgs } from "../launch.mjs";

export const EXTENSION_ID = "anthropic.claude-code";

/** The `code` executable; `JEV_VSCODE_BIN` names another one (Insiders, a fork, a full path). */
export function resolveCode({ env = process.env, platform = process.platform } = {}) {
  const name = env.JEV_VSCODE_BIN || "code";
  if (/[\\/]/.test(name)) return { file: name, shell: platform === "win32" && /\.(cmd|bat)$/i.test(name) };
  return resolveExecutable(name, { env, platform });
}

const run = (resolved, args, { timeoutMs, exec }) =>
  new Promise((resolve) => {
    exec(
      resolved.file,
      spawnArgs(resolved, args),
      { timeout: timeoutMs, shell: resolved.shell, windowsHide: true },
      (error, stdout) => resolve(error ? null : String(stdout)),
    );
  });

/** `code --version` prints version, commit, and architecture on separate lines. */
export function parseCodeVersion(stdout) {
  const [version, commit, arch] = String(stdout ?? "").trim().split(/\r?\n/);
  return /^\d+\.\d+\.\d+/.test(version ?? "") ? { version, commit: commit ?? null, arch: arch ?? null } : null;
}

/** `code --list-extensions --show-versions` prints one `publisher.name@version` per line. */
export function parseExtensionVersion(stdout, id = EXTENSION_ID) {
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const [name, version] = line.trim().split("@");
    if (name?.toLowerCase() === id) return version || null;
  }
  return undefined;
}

/**
 * @returns {{ code: null | { file: string }, vscode: object | null, extension: string | null | undefined }}
 *   `extension` is a version string, `undefined` when the list was read and it is absent,
 *   and `null` when the list could not be read.
 */
export async function discover({ env = process.env, platform = process.platform, exec = execFile, timeoutMs = 5000 } = {}) {
  const code = resolveCode({ env, platform });
  if (!code) return { code: null, vscode: null, extension: null };
  const [versionOut, extensionsOut] = await Promise.all([
    run(code, ["--version"], { timeoutMs, exec }),
    run(code, ["--list-extensions", "--show-versions"], { timeoutMs, exec }),
  ]);
  return {
    code: { file: code.file },
    vscode: parseCodeVersion(versionOut),
    extension: extensionsOut == null ? null : parseExtensionVersion(extensionsOut),
  };
}

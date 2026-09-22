import { appendFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { boolEnv } from "./env.mjs";

export const LOG_FILE = join(homedir(), ".jev-claude.log");
const FILE_MODE = 0o600;

export function log(line, file = LOG_FILE) {
  const text = `[jev] ${line}\n`;
  // Claude Code owns the terminal in interactive mode and redraws over anything we print, so
  // writing to stderr there corrupts its UI. Log to a file instead and leave stderr alone.
  // In print mode (`-p`) there is no TUI to damage, so stderr stays convenient for piping.
  if (!process.stdout.isTTY) return void process.stderr.write(text);
  try {
    appendFileSync(file, `${new Date().toISOString()} ${text}`, { mode: FILE_MODE });
    // `mode` only applies on creation; tighten a file left world-readable by an earlier version.
    chmodSync(file, FILE_MODE);
  } catch {
    // A broken log file must never take down the session.
  }
}

export const debug = (line) => boolEnv("JEV_DEBUG") && log(line);

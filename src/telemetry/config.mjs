import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { boolEnv } from "../env.mjs";

export const DB_FILENAME = "telemetry.sqlite3";
export const DEFAULT_RETENTION_DAYS = 90;
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** SQLite's sidecar files. They inherit the database's secrets and so its permissions. */
export const SIDECARS = ["-wal", "-shm"];

export function dataDir(env = process.env) {
  const configured = env.JEV_DATA_DIR;
  if (!configured) return join(homedir(), ".jev-router");
  const expanded = configured.startsWith("~")
    ? join(homedir(), configured.slice(1).replace(/^[/\\]/, ""))
    : configured;
  return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
}

export const databasePath = (env = process.env) => join(dataDir(env), DB_FILENAME);

export const telemetryEnabled = (env = process.env) => boolEnv("JEV_ENABLE_TELEMETRY", env);

/**
 * Retention is a positive whole number of days. A malformed value falls back to the default
 * rather than disabling retention, because "keep everything forever" is not a safe reading of
 * a typo in a privacy control.
 */
export function retentionDays(env = process.env) {
  const raw = Number(env.JEV_TELEMETRY_RETENTION_DAYS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(raw);
}

export const retentionCutoff = (env = process.env, now = Date.now()) =>
  now - retentionDays(env) * 24 * 60 * 60 * 1000;

/** Prompt text is stored only when explicitly enabled; see the privacy controls in README. */
export const storePrompts = (env = process.env) => boolEnv("JEV_STORE_PROMPTS", env);
export const storePromptPreview = (env = process.env) => boolEnv("JEV_STORE_PROMPT_PREVIEW", env);

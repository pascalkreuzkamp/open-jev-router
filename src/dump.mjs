import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { boolEnv } from "./env.mjs";
import { omitContent, redact } from "./sanitize.mjs";

// `JEV_DUMP` used to be a path prefix a caller supplied themselves (`${JEV_DUMP}.<ts>.json`,
// with no redaction). It is now a boolean flag: dumps land under a fixed private directory,
// message content is omitted by default, and every dump is redacted for secret-shaped fields.
// Computed lazily, not at import, so tests can point it at a temporary directory.
export const defaultDumpRoot = () => join(homedir(), ".jev-router", "dumps");

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Writes a sanitized wire-shape dump for `body` under `JEV_DUMP=1`. Never throws. */
export function dumpRequest(session, body, { root = defaultDumpRoot() } = {}) {
  if (!boolEnv("JEV_DUMP")) return;
  try {
    const dir = join(root, (session || "").replace(/[^\w-]/g, "") || "unknown");
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    chmodSync(dir, DIR_MODE);
    const shaped = boolEnv("JEV_DUMP_CONTENT") ? body : omitContent(body);
    const file = join(dir, `${randomUUID()}.json`);
    writeFileSync(file, JSON.stringify(redact(shaped), null, 2), { mode: FILE_MODE });
    chmodSync(file, FILE_MODE);
  } catch {
    // Diagnostics must never block a request.
  }
}

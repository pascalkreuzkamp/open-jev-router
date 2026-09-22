// Shared gate for the explicitly invoked live suites (spec §21.4). Nothing here runs from
// `npm test` or CI: each script refuses to do anything until the caller both supplies the
// credentials or login it needs and states, in an environment variable, that they accept the
// cost. Evidence is written sanitized, because a live run touches real prompts and real keys.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "../../src/sanitize.mjs";
import { ROUTER_VERSION } from "../../src/version.mjs";

export const EVIDENCE_DIR = join(homedir(), ".jev-router", "live-evidence");

const note = (line) => process.stderr.write(`${line}\n`);

/**
 * Refuses to proceed unless the run was explicitly authorized and every named environment
 * variable is present. Exits 2 (distinct from a test failure) so an accidental invocation in
 * a script is obviously a setup problem, not a product defect.
 */
export function requireLive({ name, requires = [], requiresLogin = [] }) {
  const missing = requires.filter((variable) => !process.env[variable]);
  if (!process.env.JEV_LIVE) {
    note(`[live:${name}] refusing to run: set JEV_LIVE=1 to authorize a live, billable run.`);
    process.exit(2);
  }
  if (missing.length) {
    note(`[live:${name}] refusing to run: missing ${missing.join(", ")}.`);
    note(`[live:${name}] live credentials are never read from CI; supply them in this shell.`);
    process.exit(2);
  }
  for (const requirement of requiresLogin) note(`[live:${name}] assumes: ${requirement}`);
}

/**
 * Prints the cost of the run before it happens. An unknown estimate is printed as unknown;
 * inventing a figure would be worse than admitting the provider has not quoted one.
 */
export function discloseCost({ name, decisions, estimateUsd = null, inference = null }) {
  note(`[live:${name}] router ${ROUTER_VERSION}, node ${process.version}`);
  note(`[live:${name}] routing decisions to be purchased: ${decisions}`);
  note(
    `[live:${name}] estimated routing cost: ${
      estimateUsd == null ? "unknown (provider does not quote in advance)" : `~$${estimateUsd.toFixed(5)}`
    }`,
  );
  if (inference) note(`[live:${name}] Claude inference: ${inference}`);
  note(`[live:${name}] set JEV_LIVE=1 authorized this run; press Ctrl-C now to abort.`);
}

/** Actual cost as the provider reported it; silence is reported as silence, never as zero. */
export function reportCost({ name, costs }) {
  const known = costs.filter((cost) => typeof cost === "number");
  if (!known.length) {
    note(`[live:${name}] actual routing cost: not reported by the provider`);
    return null;
  }
  const total = known.reduce((sum, cost) => sum + cost, 0);
  note(
    `[live:${name}] actual routing cost: $${total.toFixed(6)} over ${known.length}/${costs.length} reported decisions`,
  );
  return total;
}

/**
 * Writes a sanitized record of the run. `redact` strips keys/secrets; prompts are recorded by
 * their own text only when the caller passes them, and these scripts pass synthetic prompts.
 */
export function writeEvidence(name, record) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(EVIDENCE_DIR, `${name}-${stamp}.json`);
  mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(
    file,
    `${JSON.stringify(
      redact({
        suite: name,
        recordedAt: new Date().toISOString(),
        routerVersion: ROUTER_VERSION,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        ...record,
      }),
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  note(`[live:${name}] evidence: ${file}`);
  return file;
}

export function finish(name, { passed, failed }) {
  note(`[live:${name}] ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

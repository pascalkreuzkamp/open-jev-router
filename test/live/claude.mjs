// A real Claude Code print-mode turn through the real proxy and a real Jev decision
// (spec §21.4). Run:
//   JEV_LIVE=1 OPENROUTER_API_KEY=... npm run test:live:claude
// Requires `claude` on PATH and an already signed-in Claude Pro/Max session. No
// ANTHROPIC_API_KEY is set by this script: proving the subscription path still works is the
// point of the run (FR-003, acceptance A12).
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireLive, discloseCost, reportCost, writeEvidence, finish } from "./harness.mjs";

const NAME = "claude";
const PROMPT = "Reply with exactly the word OK and nothing else.";

requireLive({
  name: NAME,
  requires: [],
  requiresLogin: [
    "`claude` is on PATH",
    "Claude Code is already signed in to a Pro/Max subscription",
    "this run spends subscription inference, which Anthropic does not itemize per request",
  ],
});

const { startProxy } = await import("../../src/proxy.mjs");
const { selectProvider } = await import("../../src/providers/select.mjs");
const { readStatus } = await import("../../src/status.mjs");
const { AUTO_MODEL } = await import("../../src/config.mjs");

const selected = selectProvider();
if (selected.status !== "ok") {
  process.stderr.write(`[live:${NAME}] refusing to run: no usable provider (${selected.status}).\n`);
  process.exit(2);
}
if (process.env.ANTHROPIC_API_KEY) {
  process.stderr.write(
    `[live:${NAME}] refusing to run: ANTHROPIC_API_KEY is set, which would prove nothing about the subscription path.\n`,
  );
  process.exit(2);
}

discloseCost({
  name: NAME,
  decisions: 1,
  estimateUsd: null,
  inference: "one short Claude turn, billed to the signed-in subscription, not itemized",
});

const decisions = [];
const { port, close, telemetry } = await startProxy({
  route: async (question) => {
    const answer = await (await import("../../src/router.mjs")).askJev(question);
    decisions.push(answer);
    return answer;
  },
});

const workspace = mkdtempSync(join(tmpdir(), "jev-live-claude-"));
mkdirSync(join(workspace, ".claude"), { recursive: true });

const child = spawn(
  "claude",
  ["-p", PROMPT, "--model", AUTO_MODEL],
  {
    cwd: workspace,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));
const exitCode = await new Promise((resolve) => child.on("exit", resolve));
await close();

const checks = [];
const check = (description, ok, detail = null) => {
  checks.push({ description, ok, detail });
  process.stdout.write(`${ok ? "ok  " : "FAIL"}  ${description}${detail ? ` (${detail})` : ""}\n`);
};

check("claude exited cleanly", exitCode === 0, `exit ${exitCode}`);
check("the turn produced output", stdout.trim().length > 0);
check("the fresh turn purchased exactly one routing decision", decisions.length === 1, `${decisions.length} decisions`);
const answer = decisions[0] ?? null;
check("the provider answered rather than failing open", Boolean(answer), answer ? answer.provider : "null");
check(
  "the enforced model is a real Claude model, not the sentinel",
  Boolean(answer?.choice) && answer.choice !== AUTO_MODEL,
  answer?.choice ?? "none",
);
check("no Anthropic API key was required", !process.env.ANTHROPIC_API_KEY);

const total = reportCost({ name: NAME, costs: decisions.map((decision) => decision?.cost ?? null) });
writeEvidence(NAME, {
  prompt: PROMPT,
  exitCode,
  provider: selected.provider.name,
  telemetryEnabled: Boolean(telemetry?.enabled),
  actualRoutingCostUsd: total,
  decisions: decisions.map((decision) => ({
    choice: decision?.choice ?? null,
    confidence: decision?.confidence ?? null,
    decisionId: decision?.decisionId ?? null,
    resolvedModel: decision?.resolvedModel ?? null,
    cost: decision?.cost ?? null,
    ms: decision?.ms ?? null,
  })),
  status: readStatus(null),
  checks,
  // Claude Code's own stderr can name file paths from the workspace; the workspace is a
  // throwaway temp directory and `writeEvidence` redacts key-shaped values.
  stderrTail: stderr.split("\n").slice(-5).join("\n"),
});

finish(NAME, {
  passed: checks.filter((entry) => entry.ok).length,
  failed: checks.filter((entry) => !entry.ok).length,
});

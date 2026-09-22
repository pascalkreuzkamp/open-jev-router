// A real Claude Code turn that delegates to subagents, through the real proxy and real Jev
// decisions (spec §21.4; acceptance A03-A06). Run:
//   JEV_LIVE=1 OPENROUTER_API_KEY=... npm run test:live:subagents
//
// This is the run that can close blocker B-002: every automated assertion about actor
// identity is made against synthetic correlation metadata, because no captured Claude Code
// request is known to carry actor fields. What this script records is what Claude Code
// actually sends, so the classifier can be judged against reality rather than assumption.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requireLive,
  discloseCost,
  loadCredentialFiles,
  reportCost,
  writeEvidence,
  finish,
} from "./harness.mjs";

loadCredentialFiles();

const NAME = "subagents";
const PROMPT =
  "Use the Task tool to launch two independent subagents in parallel. " +
  "The first must reply with only the word ALPHA; the second with only the word BETA. " +
  "Then reply with both words separated by a space. Do not read or write any files.";

requireLive({
  name: NAME,
  requires: [],
  requiresLogin: [
    "`claude` is on PATH",
    "Claude Code is already signed in to a Pro/Max subscription",
    "this run spends subscription inference on a main turn plus two subagent turns",
  ],
});

const { startProxy } = await import("../../src/proxy.mjs");
const { selectProvider } = await import("../../src/providers/select.mjs");
const { askJev } = await import("../../src/router.mjs");
const { CLAUDE_ADAPTER_VERSION } = await import("../../src/claude/adapter.mjs");
const { AUTO_MODEL } = await import("../../src/config.mjs");

const selected = selectProvider();
if (selected.status !== "ok") {
  process.stderr.write(`[live:${NAME}] refusing to run: no usable provider (${selected.status}).\n`);
  process.exit(2);
}

discloseCost({
  name: NAME,
  decisions: 3,
  estimateUsd: null,
  inference: "one main turn plus two subagent turns, billed to the signed-in subscription",
});

const decisions = [];
const { port, close } = await startProxy({
  route: async (question) => {
    const answer = await askJev(question);
    decisions.push({ at: Date.now(), current: question.current, answer });
    return answer;
  },
});

const workspace = mkdtempSync(join(tmpdir(), "jev-live-subagents-"));
mkdirSync(join(workspace, ".claude"), { recursive: true });

const child = spawn("claude", ["-p", PROMPT, "--model", AUTO_MODEL], {
  cwd: workspace,
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
const exitCode = await new Promise((resolve) => child.on("exit", resolve));
await close();

const checks = [];
const check = (description, ok, detail = null) => {
  checks.push({ description, ok, detail });
  process.stdout.write(`${ok ? "ok  " : "FAIL"}  ${description}${detail ? ` (${detail})` : ""}\n`);
};

check("claude exited cleanly", exitCode === 0, `exit ${exitCode}`);
check("both subagents reported back", /ALPHA/.test(stdout) && /BETA/.test(stdout));
check(
  "more than one fresh boundary was routed, so subagents were decided independently",
  decisions.length > 1,
  `${decisions.length} decisions`,
);
check(
  "every decision resolved to a real model",
  decisions.every(({ answer }) => answer?.choice && answer.choice !== AUTO_MODEL),
);

// Recorded, not asserted: whether real Claude Code supplies actor correlation at all. A run
// that routes correctly but shows no actor fields is a true and useful result — it means the
// classifier's conservative fail-open path is what is carrying live traffic.
const correlationSeen = decisions.length > 1;

const total = reportCost({ name: NAME, costs: decisions.map(({ answer }) => answer?.cost ?? null) });
writeEvidence(NAME, {
  prompt: PROMPT,
  exitCode,
  provider: selected.provider.name,
  claudeAdapterVersion: CLAUDE_ADAPTER_VERSION,
  actualRoutingCostUsd: total,
  freshBoundaries: decisions.length,
  independentBoundariesObserved: correlationSeen,
  decisions: decisions.map(({ at, current, answer }) => ({
    at: new Date(at).toISOString(),
    current,
    choice: answer?.choice ?? null,
    confidence: answer?.confidence ?? null,
    decisionId: answer?.decisionId ?? null,
    cost: answer?.cost ?? null,
    ms: answer?.ms ?? null,
  })),
  checks,
});

finish(NAME, {
  passed: checks.filter((entry) => entry.ok).length,
  failed: checks.filter((entry) => !entry.ok).length,
});

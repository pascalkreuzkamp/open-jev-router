// Live routing decisions against the configured Jev provider (spec §21.4).
// Run: JEV_LIVE=1 OPENROUTER_API_KEY=... npm run test:live:jev-openrouter
// Replaces the older ad-hoc `test/live-routing.mjs`: same prompts, plus the credential gate,
// cost disclosure and sanitized evidence the acceptance phase requires.
import { requireLive, discloseCost, reportCost, writeEvidence, finish } from "./harness.mjs";

for (const file of [".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // No .env; the key may still come from the real environment.
  }
}

const { askJev } = await import("../../src/router.mjs");
const { selectProvider } = await import("../../src/providers/select.mjs");
const { TIERS } = await import("../../src/config.mjs");

const NAME = "jev-openrouter";
const PROMPTS = [
  { prompt: "fix the typo 'recieve' in README.md", expect: "haiku" },
  { prompt: "add a unit test for the existing formatDate helper", expect: null },
  { prompt: "users intermittently get logged out after deploy, figure out why", expect: null },
  { prompt: "migrate the entire monorepo from webpack to vite", expect: "opus" },
];

requireLive({
  name: NAME,
  // Either key is enough; the check below reports which provider was actually selected.
  requires: [],
});

const selected = selectProvider();
if (selected.status !== "ok") {
  process.stderr.write(`[live:${NAME}] refusing to run: no usable provider (${selected.status}).\n`);
  process.exit(2);
}

discloseCost({ name: NAME, decisions: PROMPTS.length, estimateUsd: null });

const models = TIERS.map(({ id, name }) => ({ id, tier: name }));
const results = [];
let passed = 0;
let failed = 0;

for (const { prompt, expect } of PROMPTS) {
  const answer = await askJev({ prompt, current: "claude-sonnet-5", contextTokens: 0, models });
  if (!answer) {
    failed++;
    results.push({ prompt, ok: false, reason: "no answer (failed open)" });
    process.stdout.write(`FAIL  ${prompt}\n`);
    continue;
  }
  const known = models.some(({ id }) => id === answer.choice);
  // A live decision is judged on being a usable answer, not on matching a preferred tier:
  // asserting an exact model would make the suite a measure of Jev's taste, not our wiring.
  const ok = known;
  ok ? passed++ : failed++;
  results.push({
    prompt,
    ok,
    choice: answer.choice,
    confidence: answer.confidence,
    provider: answer.provider,
    decisionId: answer.decisionId,
    configuredModel: answer.configuredModel,
    resolvedModel: answer.resolvedModel,
    usage: answer.usage,
    cost: answer.cost,
    ms: answer.ms,
    preferredTier: expect,
  });
  const confidence = answer.confidence == null ? "n/a" : answer.confidence.toFixed(2);
  process.stdout.write(
    `${ok ? "ok  " : "FAIL"}  ${String(answer.choice).padEnd(28)} conf=${confidence} ${String(answer.ms).padStart(5)}ms via ${answer.provider}\n`,
  );
}

const total = reportCost({ name: NAME, costs: results.map((result) => result.cost) });
writeEvidence(NAME, {
  provider: selected.provider.name,
  configuredModel: results.find((result) => result.configuredModel)?.configuredModel ?? null,
  resolvedModel: results.find((result) => result.resolvedModel)?.resolvedModel ?? null,
  actualRoutingCostUsd: total,
  decisions: results,
});
finish(NAME, { passed, failed });

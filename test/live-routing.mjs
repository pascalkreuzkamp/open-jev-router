try {
  process.loadEnvFile();
} catch {
  // No .env; the key may still come from the real environment.
}
const { askJev } = await import("../src/router.mjs");
const { TIERS } = await import("../src/config.mjs");
const models = TIERS.map(({ id, name }) => ({ id, tier: name }));
const prompts = [
  "fix the typo 'recieve' in README.md",
  "add a unit test for the existing formatDate helper",
  "users intermittently get logged out after deploy, figure out why",
  "migrate the entire monorepo from webpack to vite",
];
for (const prompt of prompts) {
  const a = await askJev({ prompt, current: "claude-sonnet-5", contextTokens: 0, models });
  if (!a) { console.log(`FAIL  ${prompt}`); continue; }
  const p = a.probabilities ? Object.entries(a.probabilities).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ") : "n/a";
  const conf = a.confidence == null ? "n/a" : a.confidence.toFixed(2);
  console.log(`${a.choice.padEnd(20)} conf=${conf} ${String(a.ms).padStart(5)}ms via ${a.provider} | ${p} | ${prompt}`);
}

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../../src/proxy.mjs";
import { readStatus } from "../../src/status.mjs";

test("proxy forwards and records the same effective model and effort", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url.startsWith("/v1/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ data: [
          { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
          { id: "claude-opus-5", display_name: "Claude Opus 5" },
        ] }));
      }
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message","model":"claude-sonnet-5"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ profiles, decisionMode }) => {
      assert.equal(decisionMode, "profiles");
      assert.ok(profiles.some(({ id }) => id === "sonnet-low"));
      return { choice: "sonnet-low", confidence: 0.9, provider: "mock", decisionId: "dec_1", ms: 1 };
    },
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.json());
  const sid = `effort-${process.pid}`;
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      tools: [{ name: "Bash" }],
      metadata: { user_id: JSON.stringify({ session_id: sid }) },
      output_config: { format: { type: "json_schema" }, effort: "high" },
      thinking: { type: "enabled", budget_tokens: 5000 },
      messages: [{ role: "user", content: "make this small change" }],
    }),
  });

  assert.equal(seen[0].model, "claude-sonnet-5");
  assert.deepEqual(seen[0].output_config, { format: { type: "json_schema" }, effort: "low" });
  assert.deepEqual(seen[0].thinking, { type: "adaptive" });
  const status = readStatus(sid);
  assert.equal(status.model, seen[0].model);
  assert.equal(status.effectiveEffort, seen[0].output_config.effort);
  assert.equal(status.profileId, "sonnet-low");
  assert.equal(status.source, "jev");
  assert.equal(status.thinkingPolicy, "adaptive");
  assert.match(status.normalizationNotes.join(" "), /manual thinking normalized/);
});

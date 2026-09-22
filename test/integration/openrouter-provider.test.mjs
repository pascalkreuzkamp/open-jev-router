// End-to-end coverage through the real `askJev` facade (provider selection + normalization),
// not the `route` dependency-injection shortcut the other proxy tests use. `test/unit/
// providers/*.test.mjs` cover each adapter's error categories and edge cases in isolation;
// this file proves the pieces work wired together, including through the Claude proxy.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { askJev } from "../../src/router.mjs";
import { startProxy } from "../../src/proxy.mjs";
import { readStatus } from "../../src/status.mjs";

const MODELS = [
  { id: "claude-haiku-4-5-20251001", tier: "haiku" },
  { id: "claude-sonnet-5", tier: "sonnet" },
  { id: "claude-opus-5", tier: "opus" },
];

function jsonServer(handler) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handler(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined));
  });
}

async function listening(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const decisionFor = (choice, extra = {}) => ({
  id: "gen-dec-int-1",
  model: "typesafe/jev-1.13-resolved",
  answers: {
    model: { type: "choice", choice, confidence: 0.82 },
    task_complexity: { type: "score", score: 4 },
    reasoning_required: { type: "score", score: 3 },
    tool_complexity: { type: "score", score: 1 },
  },
  usage: { input_tokens: 200, output_tokens: 30, cost: 0.00005 },
  ...extra,
});

test("askJev has no provider key configured: fails open without any network call", async () => {
  let called = false;
  const server = jsonServer((req, res) => {
    called = true;
    res.end("{}");
  });
  const baseURL = await listening(server);
  server.close();

  const result = await askJev({
    prompt: "p",
    current: "claude-sonnet-5",
    contextTokens: 0,
    models: MODELS,
    env: { OPENROUTER_BASE_URL: baseURL },
  });

  assert.equal(result, null);
  assert.equal(called, false);
});

test("askJev routes through OpenRouter end-to-end when OPENROUTER_API_KEY is set", async (t) => {
  const server = jsonServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(decisionFor("claude-opus-5")));
  });
  const baseURL = await listening(server);
  t.after(() => server.close());

  const result = await askJev({
    prompt: "design the migration",
    current: "claude-sonnet-5",
    contextTokens: 500,
    models: MODELS,
    env: { OPENROUTER_API_KEY: "sk-or-canary", OPENROUTER_BASE_URL: baseURL },
  });

  assert.ok(result);
  assert.equal(result.choice, "claude-opus-5");
  assert.equal(result.provider, "openrouter");
  assert.equal(result.decisionId, "gen-dec-int-1");
  assert.equal(result.cost, 0.00005);
});

test("askJev routes through direct TypeSafe end-to-end when only its key is set", async (t) => {
  const server = jsonServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(decisionFor("claude-haiku-4-5-20251001")));
  });
  const baseURL = await listening(server);
  const previousBaseURL = process.env.TYPESAFE_BASE_URL;
  process.env.TYPESAFE_BASE_URL = baseURL;
  t.after(() => {
    server.close();
    if (previousBaseURL === undefined) delete process.env.TYPESAFE_BASE_URL;
    else process.env.TYPESAFE_BASE_URL = previousBaseURL;
  });

  const result = await askJev({
    prompt: "rename this variable",
    current: "claude-sonnet-5",
    contextTokens: 50,
    models: MODELS,
    env: { JEV_API_KEY: "ts-canary" },
  });

  assert.ok(result);
  assert.equal(result.choice, "claude-haiku-4-5-20251001");
  assert.equal(result.provider, "typesafe");
});

test("a hallucinated model id fails open through the full proxy, same as no answer at all", async (t) => {
  const openrouter = jsonServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(decisionFor("gpt-9-nonexistent")));
  });
  const openrouterBaseURL = await listening(openrouter);
  t.after(() => openrouter.close());

  const anthropic = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message","model":"claude-sonnet-5"}');
    });
  });
  await new Promise((resolve) => anthropic.listen(0, "127.0.0.1", resolve));
  t.after(() => anthropic.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${anthropic.address().port}`,
    route: (input) =>
      askJev({ ...input, env: { OPENROUTER_API_KEY: "sk-or-canary", OPENROUTER_BASE_URL: openrouterBaseURL } }),
  });
  t.after(close);

  const sid = `hallucinated-${process.pid}`;
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      tools: [{ name: "Bash" }],
      metadata: { user_id: JSON.stringify({ session_id: sid }) },
      messages: [{ role: "user", content: "do something" }],
    }),
  });

  const status = readStatus(sid);
  assert.ok(status);
  assert.equal(status.tier, "opus", "keeps the account default when Jev names a model that isn't in the catalog");
  assert.match(status.reason, /jev-unavailable/);
});

test("Claude auth and the OpenRouter key never cross, at the network boundary or in stored diagnostics", async (t) => {
  const seenByOpenRouter = { authHeaders: [], bodies: [] };
  const openrouter = jsonServer((req, res, body) => {
    seenByOpenRouter.authHeaders.push(req.headers.authorization);
    seenByOpenRouter.bodies.push(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(decisionFor("claude-opus-5")));
  });
  const openrouterBaseURL = await listening(openrouter);
  t.after(() => openrouter.close());

  const seenByAnthropic = { authHeaders: [] };
  const anthropic = http.createServer((req, res) => {
    seenByAnthropic.authHeaders.push(req.headers.authorization);
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message","model":"claude-opus-5"}');
    });
  });
  await new Promise((resolve) => anthropic.listen(0, "127.0.0.1", resolve));
  t.after(() => anthropic.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${anthropic.address().port}`,
    route: (input) =>
      askJev({ ...input, env: { OPENROUTER_API_KEY: "sk-or-CANARY-OR", OPENROUTER_BASE_URL: openrouterBaseURL } }),
  });
  t.after(close);

  const sid = `isolation-${process.pid}`;
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-ant-CANARY-CLAUDE" },
    body: JSON.stringify({
      model: "jev-router",
      tools: [{ name: "Bash" }],
      metadata: { user_id: JSON.stringify({ session_id: sid }) },
      messages: [{ role: "user", content: "debug this race" }],
    }),
  });

  // The OpenRouter key reaches only OpenRouter, as its own bearer token.
  assert.deepEqual(seenByOpenRouter.authHeaders, ["Bearer sk-or-CANARY-OR"]);
  // Claude's own auth reaches only Anthropic, forwarded unchanged.
  assert.deepEqual(seenByAnthropic.authHeaders, ["Bearer sk-ant-CANARY-CLAUDE"]);

  // Neither canary crossed to the other party.
  const openrouterTraffic = JSON.stringify(seenByOpenRouter.bodies);
  assert.doesNotMatch(openrouterTraffic, /sk-ant-CANARY-CLAUDE/);
  assert.doesNotMatch(JSON.stringify(seenByAnthropic.authHeaders), /sk-or-CANARY-OR/);

  // Nor into the persisted decision.
  const status = readStatus(sid);
  const stored = JSON.stringify(status);
  assert.doesNotMatch(stored, /sk-or-CANARY-OR/);
  assert.doesNotMatch(stored, /sk-ant-CANARY-CLAUDE/);
  assert.equal(status.tier, "opus");
  assert.equal(status.provider, "openrouter");
});

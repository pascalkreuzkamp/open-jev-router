import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTypeSafeProvider } from "../../../src/providers/typesafe.mjs";
import { PROVIDER_ERROR_CATEGORIES } from "../../../src/config.mjs";

const MODELS = [
  { id: "claude-haiku-4-5-20251001", tier: "haiku" },
  { id: "claude-sonnet-5", tier: "sonnet" },
];

const ROUTE_INPUT = { prompt: "fix the bug", current: "claude-sonnet-5", contextTokens: 100, models: MODELS };

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

const VALID_ANSWER = {
  model: "jev-latest-resolved",
  answers: {
    model: { type: "choice", choice: "claude-sonnet-5", confidence: 0.8, probabilities: { "claude-sonnet-5": 0.8 } },
    task_complexity: { type: "score", score: 3 },
    reasoning_required: { type: "score", score: 2 },
    tool_complexity: { type: "score", score: 1 },
  },
  usage: { input_tokens: 100, output_tokens: 20 },
};

test("sends the SDK's own systemone shape and normalizes a successful answer", async (t) => {
  let seenPath;
  let seenAuth;
  let seenBody;
  const server = jsonServer((req, res, body) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    seenBody = body;
    res.setHeader("content-type", "application/json");
    res.setHeader("x-typesafe-request-id", "req-123");
    res.end(JSON.stringify(VALID_ANSWER));
  });
  const baseURL = await listening(server);
  t.after(() => server.close());

  const provider = createTypeSafeProvider({ apiKey: "ts-key", baseURL });
  const result = await provider.route(ROUTE_INPUT);

  assert.equal(seenPath, "/v1/systemone");
  assert.equal(seenAuth, "Bearer ts-key");
  assert.ok(seenBody.state);
  assert.ok(seenBody.questions.model);

  assert.equal(provider.name, "typesafe");
  assert.equal(result.ok, true);
  assert.equal(result.choice, "claude-sonnet-5");
  assert.equal(result.confidence, 0.8);
  assert.equal(result.decisionId, "req-123");
  assert.equal(result.resolvedModel, "jev-latest-resolved");
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20 });
  assert.equal(result.cost, null, "the direct API has no per-call cost field");
  assert.ok(Number.isFinite(result.metrics.taskComplexity));
});

for (const [status, category] of [
  [401, "auth_error"],
  [429, "rate_limited"],
  [500, "provider_error"],
  [422, "provider_error"],
]) {
  test(`HTTP ${status} categorizes as ${category}`, async (t) => {
    const server = jsonServer((req, res) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "denied" }));
    });
    const baseURL = await listening(server);
    t.after(() => server.close());

    const provider = createTypeSafeProvider({ apiKey: "ts-key", baseURL });
    const result = await provider.route(ROUTE_INPUT);

    assert.equal(result.ok, false);
    assert.ok(PROVIDER_ERROR_CATEGORIES.includes(category), "test table only uses FR-002's categories");
    assert.equal(result.category, category);
  });
}

test("a malformed answer shape is invalid_response, not a crash", async (t) => {
  const server = jsonServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answers: { model: { type: "choice" } } }));
  });
  const baseURL = await listening(server);
  t.after(() => server.close());

  const provider = createTypeSafeProvider({ apiKey: "ts-key", baseURL });
  const result = await provider.route(ROUTE_INPUT);

  assert.equal(result.ok, false);
  assert.equal(result.category, "invalid_response");
});

test("a slow server is cancelled at the configured deadline and categorized as timeout", async (t) => {
  const server = jsonServer((req, res) => {
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(VALID_ANSWER));
    }, 500);
  });
  const baseURL = await listening(server);
  t.after(() => server.close());

  const provider = createTypeSafeProvider({ apiKey: "ts-key", baseURL, timeoutMs: 40 });
  const started = Date.now();
  const result = await provider.route(ROUTE_INPUT);

  assert.equal(result.ok, false);
  assert.equal(result.category, "timeout");
  assert.ok(Date.now() - started < 450, "cancelled well before the server would have responded");
});

test("a connection failure categorizes as network_error", async (t) => {
  const server = jsonServer((req, res) => res.end("{}"));
  const baseURL = await listening(server);
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  t.after(() => {});

  const provider = createTypeSafeProvider({ apiKey: "ts-key", baseURL: `http://127.0.0.1:${port}` });
  const result = await provider.route(ROUTE_INPUT);

  assert.equal(result.ok, false);
  assert.equal(result.category, "network_error");
});

test("healthCheck lists models without asking a question, at no decision cost", async (t) => {
  let seenPath;
  let seenMethod;
  const server = jsonServer((req, res) => {
    seenPath = req.url;
    seenMethod = req.method;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ models: [{ id: "claude-sonnet-5" }] }));
  });
  const baseURL = await listening(server);
  t.after(() => server.close());

  const provider = createTypeSafeProvider({ apiKey: "ts-key", baseURL });
  const health = await provider.healthCheck();

  assert.equal(seenPath, "/v1/models");
  assert.equal(seenMethod, "GET");
  assert.equal(health.ok, true);
});

test("healthCheck reports failure without throwing on an invalid key", async (t) => {
  const server = jsonServer((req, res) => {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "invalid api key" }));
  });
  const baseURL = await listening(server);
  t.after(() => server.close());

  const provider = createTypeSafeProvider({ apiKey: "ts-bad", baseURL });
  const health = await provider.healthCheck();

  assert.equal(health.ok, false);
  assert.match(health.message, /invalid api key/);
});

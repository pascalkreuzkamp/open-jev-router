import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createOpenRouterProvider } from "../../../src/providers/openrouter.mjs";
import { DEFAULT_OPENROUTER_MODEL, PROVIDER_ERROR_CATEGORIES } from "../../../src/config.mjs";

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

const VALID_DECISION = {
  id: "gen-dec-1",
  model: "typesafe/jev-1.13-x",
  answers: {
    model: { type: "choice", choice: "claude-sonnet-5", confidence: 0.8, probabilities: { "claude-sonnet-5": 0.8 } },
    task_complexity: { type: "score", score: 3 },
    reasoning_required: { type: "score", score: 2 },
    tool_complexity: { type: "score", score: 1 },
  },
  usage: { input_tokens: 100, output_tokens: 20, cost: 0.0001 },
};

test("sends the Decisions API shape and normalizes a successful answer", async (t) => {
  let seenPath;
  let seenAuth;
  let seenBody;
  const server = jsonServer((req, res, body) => {
    seenPath = req.url;
    seenAuth = req.headers.authorization;
    seenBody = body;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(VALID_DECISION));
  });
  const baseURL = await listening(server);
  t.after(() => server.close());

  const provider = createOpenRouterProvider({ apiKey: "sk-or-test", model: "typesafe/jev-latest", baseURL });
  const result = await provider.route(ROUTE_INPUT);

  assert.equal(seenPath, "/api/alpha/decisions");
  assert.equal(seenAuth, "Bearer sk-or-test");
  assert.equal(seenBody.model, "typesafe/jev-latest");
  assert.ok(seenBody.state);
  assert.ok(seenBody.questions.model, "candidate models become a choice question, not a chat message");
  assert.equal(seenBody.messages, undefined, "never sends a chat-completion body");

  assert.equal(provider.name, "openrouter");
  assert.equal(result.ok, true);
  assert.equal(result.choice, "claude-sonnet-5");
  assert.equal(result.confidence, 0.8);
  assert.deepEqual(result.probabilities, { "claude-sonnet-5": 0.8 });
  assert.equal(result.decisionId, "gen-dec-1");
  assert.equal(result.configuredModel, "typesafe/jev-latest");
  assert.equal(result.resolvedModel, "typesafe/jev-1.13-x");
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20 });
  assert.equal(result.cost, 0.0001);
  assert.ok(Number.isFinite(result.metrics.taskComplexity));
  assert.ok(result.raw);
});

test("profiles mode sends only validated profile choices", async (t) => {
  let seenBody;
  const server = jsonServer((req, res, body) => {
    seenBody = body;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ...VALID_DECISION,
      answers: {
        ...VALID_DECISION.answers,
        model: { type: "choice", choice: "sonnet-low", confidence: 0.9 },
      },
    }));
  });
  const baseURL = await listening(server);
  t.after(() => server.close());
  const provider = createOpenRouterProvider({ apiKey: "sk-or-test", model: "typesafe/jev-latest", baseURL });
  const profiles = [{
    id: "sonnet-low",
    model: "claude-sonnet-5",
    tier: "balanced",
    effort: "low",
  }];

  const result = await provider.route({ ...ROUTE_INPUT, profiles, decisionMode: "profiles" });

  assert.equal(result.choice, "sonnet-low");
  assert.deepEqual(seenBody.state.environment.available_profiles, ["sonnet-low"]);
  assert.deepEqual(Object.keys(seenBody.questions.model.criteria), ["sonnet-low"]);
});

test("missing confidence/cost/usage normalize to null, never a manufactured value", async (t) => {
  const server = jsonServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        answers: {
          model: { type: "choice", choice: "claude-sonnet-5" },
          task_complexity: { type: "score", score: 3 },
          reasoning_required: { type: "score", score: 2 },
          tool_complexity: { type: "score", score: 1 },
        },
      }),
    );
  });
  const baseURL = await listening(server);
  t.after(() => server.close());

  const provider = createOpenRouterProvider({ apiKey: "sk-or-test", model: "typesafe/jev-latest", baseURL });
  const result = await provider.route(ROUTE_INPUT);

  assert.equal(result.ok, true);
  assert.equal(result.confidence, null);
  assert.equal(result.probabilities, null);
  assert.equal(result.cost, null);
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null });
  assert.equal(result.decisionId, null);
  assert.equal(result.resolvedModel, null);
});

test("an out-of-range legacy score is rejected as an invalid response", async (t) => {
  const server = jsonServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ...VALID_DECISION,
      answers: {
        ...VALID_DECISION.answers,
        reasoning_required: { type: "score", score: 10 },
      },
    }));
  });
  const baseURL = await listening(server);
  t.after(() => server.close());
  const provider = createOpenRouterProvider({ apiKey: "sk-or-test", model: "typesafe/jev-latest", baseURL });

  const result = await provider.route(ROUTE_INPUT);

  assert.equal(result.ok, false);
  assert.equal(result.category, "invalid_response");
});

for (const [status, category] of [
  [401, "auth_error"],
  [403, "auth_error"],
  [429, "rate_limited"],
  [524, "timeout"],
  [402, "provider_error"],
  [500, "provider_error"],
  [529, "provider_error"],
]) {
  test(`HTTP ${status} categorizes as ${category}`, async (t) => {
    const server = jsonServer((req, res) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "denied" } }));
    });
    const baseURL = await listening(server);
    t.after(() => server.close());

    const provider = createOpenRouterProvider({ apiKey: "sk-or-test", model: "m", baseURL });
    const result = await provider.route(ROUTE_INPUT);

    assert.equal(result.ok, false);
    assert.ok(PROVIDER_ERROR_CATEGORIES.includes(category), "test table only uses FR-002's categories");
    assert.equal(result.category, category);
    assert.match(result.message, /denied/);
  });
}

test("a malformed answer shape is invalid_response, not a crash", async (t) => {
  const server = jsonServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answers: { model: { type: "choice" } } }));
  });
  const baseURL = await listening(server);
  t.after(() => server.close());

  const provider = createOpenRouterProvider({ apiKey: "sk-or-test", model: "m", baseURL });
  const result = await provider.route(ROUTE_INPUT);

  assert.equal(result.ok, false);
  assert.equal(result.category, "invalid_response");
  assert.ok(PROVIDER_ERROR_CATEGORIES.includes(result.category));
});

test("non-JSON body is invalid_response", async (t) => {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => res.end("not json"));
  });
  const baseURL = await listening(server);
  t.after(() => server.close());

  const provider = createOpenRouterProvider({ apiKey: "sk-or-test", model: "m", baseURL });
  const result = await provider.route(ROUTE_INPUT);

  assert.equal(result.ok, false);
  assert.equal(result.category, "invalid_response");
});

test("a slow server is cancelled at the configured deadline and categorized as timeout", async (t) => {
  const server = jsonServer((req, res) => {
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(VALID_DECISION));
    }, 500);
  });
  const baseURL = await listening(server);
  t.after(() => server.close());

  const provider = createOpenRouterProvider({ apiKey: "sk-or-test", model: "m", baseURL, timeoutMs: 40 });
  const started = Date.now();
  const result = await provider.route(ROUTE_INPUT);

  assert.equal(result.ok, false);
  assert.equal(result.category, "timeout");
  assert.ok(Date.now() - started < 400, "cancelled well before the server would have responded");
});

test("a connection failure categorizes as network_error", async (t) => {
  const server = jsonServer((req, res) => res.end("{}"));
  const baseURL = await listening(server);
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  t.after(() => {});

  const provider = createOpenRouterProvider({ apiKey: "sk-or-test", model: "m", baseURL: `http://127.0.0.1:${port}` });
  const result = await provider.route(ROUTE_INPUT);

  assert.equal(result.ok, false);
  assert.equal(result.category, "network_error");
});

test("healthCheck hits GET /api/v1/key without a candidate model list, at no decision cost", async (t) => {
  let seenPath;
  let seenMethod;
  let seenAuth;
  const server = jsonServer((req, res) => {
    seenPath = req.url;
    seenMethod = req.method;
    seenAuth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: { label: "test-key", limit: null } }));
  });
  const baseURL = await listening(server);
  t.after(() => server.close());

  const provider = createOpenRouterProvider({ apiKey: "sk-or-test", model: "m", baseURL });
  const health = await provider.healthCheck();

  assert.equal(seenPath, "/api/v1/key");
  assert.equal(seenMethod, "GET");
  assert.equal(seenAuth, "Bearer sk-or-test");
  assert.equal(health.ok, true);
});

test("healthCheck reports failure without throwing on an invalid key", async (t) => {
  const server = jsonServer((req, res) => {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "invalid credentials" } }));
  });
  const baseURL = await listening(server);
  t.after(() => server.close());

  const provider = createOpenRouterProvider({ apiKey: "sk-or-bad", model: "m", baseURL });
  const health = await provider.healthCheck();

  assert.equal(health.ok, false);
  assert.match(health.message, /invalid credentials/);
});

test("the default Jev model names a real version, not a floating alias", () => {
  // OpenRouter publishes no floating alias for Jev. Verified live on 2026-09-22 against a
  // real key: `typesafe/jev-latest`, `typesafe/jev` and `typesafe/jev-1` each return HTTP
  // 400 "Model ... does not exist", while `typesafe/jev-1.13` returns a decision. Routing
  // fails open, so a non-existent default is invisible in normal use: every turn simply goes
  // unrouted. `typesafe/jev-latest` shipped as the default and did exactly that.
  assert.doesNotMatch(
    DEFAULT_OPENROUTER_MODEL,
    /-latest$/,
    "OpenRouter has no -latest alias for Jev; this default would disable routing entirely",
  );
  assert.match(
    DEFAULT_OPENROUTER_MODEL,
    /^typesafe\/jev-\d+\.\d+/,
    "the default must name a published Jev version line, e.g. typesafe/jev-1.13",
  );
});

test("a fractional score is a valid answer, because that is what Jev actually returns", async (t) => {
  // Jev scores are probability-weighted positions on the 0-9 legend, so real answers look
  // like 0.64, not 1. The normalizer once demanded integers and rejected every genuine
  // decision as invalid_response; routing fails open, so the only visible symptom was that
  // OpenRouter routing silently never did anything. Captured live on 2026-09-22.
  const server = jsonServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ...VALID_DECISION,
      answers: {
        ...VALID_DECISION.answers,
        task_complexity: { type: "score", score: 0.64, confidence: 0.85 },
        reasoning_required: { type: "score", score: 1.2, confidence: 0.85 },
        tool_complexity: { type: "score", score: 0, confidence: 0.9 },
      },
    }));
  });
  const baseURL = await listening(server);
  t.after(() => server.close());
  const provider = createOpenRouterProvider({ apiKey: "sk-or-test", model: "typesafe/jev-1.13", baseURL });

  const result = await provider.route(ROUTE_INPUT);

  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.metrics.taskComplexity - 0.64 / 9) < 1e-9, "the fraction is preserved, not rounded");
  assert.ok(Math.abs(result.metrics.reasoningRequired - 1.2 / 9) < 1e-9);
  assert.equal(result.metrics.toolComplexity, 0);
});

test("a score outside the legend is still refused", async (t) => {
  const server = jsonServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ...VALID_DECISION,
      answers: { ...VALID_DECISION.answers, task_complexity: { type: "score", score: 9.5 } },
    }));
  });
  const baseURL = await listening(server);
  t.after(() => server.close());
  const provider = createOpenRouterProvider({ apiKey: "sk-or-test", model: "typesafe/jev-1.13", baseURL });

  const result = await provider.route(ROUTE_INPUT);

  assert.equal(result.ok, false);
  assert.equal(result.category, "invalid_response");
});

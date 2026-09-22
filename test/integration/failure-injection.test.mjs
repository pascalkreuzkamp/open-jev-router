// The spec's failure matrix (§21.5) exercised end to end, deliberately without the SQLite
// driver: every case here must hold whether or not telemetry is installed, because core
// forwarding "MUST remain functional whenever technically possible". Cases that are only
// meaningful with a database (disk full, locked, unwritable, restart-with-data) live in
// `test/integration/telemetry.test.mjs`; concurrency and pinning live in
// `test/integration/subagent-routing.test.mjs`. This file covers the routing-provider
// outages and the upstream faults that follow a rewrite.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../../src/proxy.mjs";
import { ActorRegistry } from "../../src/routing/actors.mjs";
import { createTelemetry } from "../../src/telemetry/attach.mjs";
import { createRecorder } from "../../src/telemetry/recorder.mjs";

const CATALOG = [
  { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" },
  { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
  { id: "claude-opus-5", display_name: "Claude Opus 5" },
];

const SENTINEL = "jev-router";

function body({ session = "s-fail", prompt = "refactor the router", model = SENTINEL } = {}) {
  return {
    model,
    tools: [{ name: "Bash" }],
    metadata: { user_id: JSON.stringify({ session_id: session, actor_id: "main", actor_type: "main", logical_turn_id: "t1" }) },
    messages: [{ role: "user", content: prompt }],
  };
}

function setEnv(t, values) {
  const previous = {};
  for (const [name, value] of Object.entries(values)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

/**
 * A proxy in front of a controllable Anthropic mock. `route` is left at its default
 * (`askJev`) unless given, so the real provider stack runs and its outages are genuine
 * network behaviour rather than an injected rejection.
 */
async function harness(t, { respond, route, actorRegistry } = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url.startsWith("/v1/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ data: CATALOG }));
      }
      seen.push(JSON.parse(Buffer.concat(chunks)));
      if (respond) return respond(res, seen.length);
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message","model":"claude-sonnet-5"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const options = {
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    // Disabled for real, through the production factory: these guarantees must not depend
    // on the optional SQLite driver being installed.
    telemetry: createTelemetry({ recorder: createRecorder({ env: {} }), routerVersion: "test" }),
  };
  if (route) options.route = route;
  if (actorRegistry) options.actorRegistry = actorRegistry;
  const { port, close } = await startProxy(options);
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.json());
  const send = (payload) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  return { seen, send, port, close };
}

function jevServer(handler) {
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

/** Every fail-open path must still resolve the sentinel: it is not a model any API accepts. */
function assertForwardedUnrouted(seen) {
  assert.equal(seen.length, 1, "exactly one request reached upstream");
  assert.notEqual(seen[0].model, SENTINEL, "the sentinel was resolved to a real model");
  assert.ok(CATALOG.some(({ id }) => id === seen[0].model), `unexpected model ${seen[0].model}`);
}

test("the routing provider being offline forwards the turn unrouted", async (t) => {
  const dead = jevServer((req, res) => res.end("{}"));
  const baseURL = await listening(dead);
  await new Promise((resolve) => dead.close(resolve));
  setEnv(t, { OPENROUTER_API_KEY: "sk-or-canary", OPENROUTER_BASE_URL: baseURL, JEV_PROVIDER: undefined, TYPESAFE_API_KEY: undefined, JEV_API_KEY: undefined });

  const { seen, send } = await harness(t);
  const response = await send(body());

  assert.equal(response.status, 200);
  assertForwardedUnrouted(seen);
});

test("a routing host that does not resolve forwards the turn unrouted", async (t) => {
  // `.invalid` is reserved by RFC 2606 and must never resolve.
  setEnv(t, {
    OPENROUTER_API_KEY: "sk-or-canary",
    OPENROUTER_BASE_URL: "http://jev-router-does-not-exist.invalid",
    JEV_PROVIDER: undefined,
    TYPESAFE_API_KEY: undefined,
    JEV_API_KEY: undefined,
  });

  const { seen, send } = await harness(t);
  const response = await send(body());

  assert.equal(response.status, 200);
  assertForwardedUnrouted(seen);
});

test("a routing provider that never answers is abandoned at the deadline, not waited out", async (t) => {
  const stalled = jevServer(() => {});
  const baseURL = await listening(stalled);
  t.after(() => stalled.close());
  setEnv(t, {
    OPENROUTER_API_KEY: "sk-or-canary",
    OPENROUTER_BASE_URL: baseURL,
    JEV_TIMEOUT_MS: "150",
    JEV_PROVIDER: undefined,
    TYPESAFE_API_KEY: undefined,
    JEV_API_KEY: undefined,
  });

  const { seen, send } = await harness(t);
  const started = Date.now();
  const response = await send(body());
  const elapsed = Date.now() - started;

  assert.equal(response.status, 200);
  assertForwardedUnrouted(seen);
  // Generous headroom over the 150ms deadline; the point is that it is bounded by the
  // configured deadline rather than by the upstream's own patience.
  assert.ok(elapsed < 3000, `routing outage added ${elapsed}ms`);
});

test("a routing answer naming an unknown profile is refused and the turn forwarded unrouted", async (t) => {
  const inventing = jevServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "dec-unknown-profile",
        model: "typesafe/jev-resolved",
        answers: { model: { type: "choice", choice: "gpt-5-turbo-ultra", confidence: 0.99 } },
      }),
    );
  });
  const baseURL = await listening(inventing);
  t.after(() => inventing.close());
  setEnv(t, { OPENROUTER_API_KEY: "sk-or-canary", OPENROUTER_BASE_URL: baseURL, JEV_PROVIDER: undefined, TYPESAFE_API_KEY: undefined, JEV_API_KEY: undefined });

  const { seen, send } = await harness(t);
  const response = await send(body());

  assert.equal(response.status, 200);
  assertForwardedUnrouted(seen);
});

test("an upstream rejection after the rewrite is forwarded verbatim and never replayed", async (t) => {
  const failure = '{"type":"error","error":{"type":"invalid_request_error","message":"bad request"}}';
  const { seen, send } = await harness(t, {
    route: async () => ({ choice: "claude-opus-5", confidence: 0.95, provider: "mock", ms: 1 }),
    respond: (res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(failure);
    },
  });

  const response = await send(body());

  assert.equal(response.status, 400, "the upstream status is reported honestly");
  assert.equal(await response.text(), failure, "the upstream body is unchanged");
  assert.equal(seen.length, 1, "a rejected request is not retried against upstream");
  assert.equal(seen[0].model, "claude-opus-5", "the rewrite still happened");
});

test("a stream cut short mid-response is forwarded as far as it got, with no second attempt", async (t) => {
  const { seen, send } = await harness(t, {
    route: async () => ({ choice: "claude-opus-5", confidence: 0.95, provider: "mock", ms: 1 }),
    respond: (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      // Let the headers and first frame reach the proxy before the connection dies, which is
      // what a mid-stream failure looks like; destroying immediately is a pre-header failure
      // and is covered separately in the telemetry suite.
      setTimeout(() => res.destroy(), 20);
    },
  });

  const response = await send(body());
  let text = "";
  try {
    text = await response.text();
  } catch {
    // An aborted body is an acceptable outcome; the assertion below is about replay.
  }

  assert.equal(response.status, 200);
  assert.ok(text === "" || text.includes("message_start"), "no content was invented for the client");
  assert.equal(seen.length, 1, "possibly executed inference is never automatically replayed");
});

test("a router restart re-decides the next fresh boundary instead of reusing a lost pin", async (t) => {
  const asked = [];
  const route = async ({ prompt }) => {
    asked.push(prompt);
    return { choice: "claude-opus-5", confidence: 0.95, provider: "mock", ms: 1 };
  };

  const first = await harness(t, { route, actorRegistry: new ActorRegistry() });
  await first.send(body());
  await first.send(body());
  assert.equal(asked.length, 1, "the second request of the turn reused the pin");
  await first.close();

  // A new process: new registry, no in-memory pins, same session on the wire.
  const second = await harness(t, { route, actorRegistry: new ActorRegistry() });
  const response = await second.send(body());

  assert.equal(response.status, 200);
  assert.equal(asked.length, 2, "the restarted router decided the boundary again");
  assert.equal(second.seen.at(-1).model, "claude-opus-5");
});

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../../src/proxy.mjs";
import { createTelemetry } from "../../src/telemetry/attach.mjs";
import { createRecorder } from "../../src/telemetry/recorder.mjs";
import {
  actorBreakdown,
  openReader,
  requestBreakdown,
  routeDistribution,
  routingCost,
  usageByRoute,
  usageTotals,
} from "../../src/telemetry/read.mjs";

const require = createRequire(import.meta.url);
let driver = null;
try {
  driver = require("better-sqlite3");
} catch {
  // Optional native dependency.
}
const needsDriver = { skip: driver ? false : "better-sqlite3 is not installed" };

const CATALOG = [
  { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" },
  { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
  { id: "claude-opus-5", display_name: "Claude Opus 5" },
];

const TOOLS = [{ name: "Bash" }, { name: "Task" }];

const sse = (events) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

const streamFor = ({ input, output, cacheRead = 0, cacheCreate = 0 }) =>
  sse([
    {
      type: "message_start",
      message: {
        id: "msg_1",
        model: "claude-opus-5",
        usage: {
          input_tokens: input,
          output_tokens: 1,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreate,
        },
      },
    },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "working" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: Math.floor(output / 2) } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: output } },
    { type: "message_stop" },
  ]);

function body({ session = "s-telemetry", actor, type, parent, turn, prompt, toolResult }) {
  const messages = [{ role: "user", content: prompt }];
  if (toolResult) {
    messages.push(
      { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: toolResult }] },
    );
  }
  return {
    model: "jev-router",
    tools: TOOLS,
    metadata: {
      user_id: JSON.stringify({
        session_id: session,
        actor_id: actor,
        actor_type: type,
        ...(parent ? { parent_actor_id: parent } : {}),
        ...(turn ? { logical_turn_id: turn } : {}),
      }),
    },
    messages,
  };
}

const choose = (id) => ({
  choice: id,
  confidence: 0.9,
  provider: "mock",
  decisionId: `dec-${id}`,
  ms: 25,
  cost: 0.0001,
  usage: { inputTokens: 120, outputTokens: 8 },
});

/**
 * A proxy in front of a scripted upstream, with telemetry writing to a temporary database.
 * `respond` returns the exact bytes and headers the upstream should send, so a test can
 * compare what Claude Code receives against them byte for byte.
 */
async function harness(t, { route, respond, path = null, telemetry = null } = {}) {
  const sent = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url.startsWith("/v1/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ data: CATALOG }));
      }
      const reply = respond(JSON.parse(Buffer.concat(chunks)), sent.length);
      sent.push(reply);
      if (reply.destroyBeforeHeaders) return res.destroy();
      res.writeHead(reply.status ?? 200, reply.headers);
      for (const chunk of reply.chunks) res.write(chunk);
      if (reply.destroy) {
        // Flush what was written before dropping the connection, so the proxy sees a stream
        // that starts normally and then stops -- what an interrupted response looks like.
        return res.flushHeaders ? setTimeout(() => res.destroy(), 20) : res.destroy();
      }
      res.end();
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const dir = mkdtempSync(join(tmpdir(), "jev-telemetry-it-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path ?? join(dir, "telemetry.sqlite3");

  const sink =
    telemetry ??
    createTelemetry({
      routerVersion: "test",
      recorder: createRecorder({ env: { JEV_ENABLE_TELEMETRY: "1" }, path: dbPath }),
    });

  const asked = [];
  const proxy = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    telemetry: sink,
    route: async (question) => {
      asked.push(question);
      return route(question, asked.length);
    },
  });
  t.after(() => proxy.close());

  await fetch(`http://127.0.0.1:${proxy.port}/v1/models`).then((response) => response.json());

  return {
    dbPath,
    dir,
    port: proxy.port,
    asked,
    sent,
    telemetry: sink,
    send: (payload) =>
      fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    async read() {
      await sink.flush();
      const db = openReader({ path: dbPath });
      if (db) t.after(() => db.close());
      return db;
    },
  };
}

/**
 * Post and return the raw response bytes. `fetch` transparently decodes `content-encoding`,
 * so it cannot be used to prove that a compressed body was forwarded untouched.
 */
function postRaw(port, payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/messages",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": data.length },
      },
      (response) => {
        const chunks = [];
        const settle = () =>
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
        response.on("data", (chunk) => chunks.push(chunk));
        // A response that is cut off mid-stream ends in one of these instead of "end".
        for (const event of ["end", "error", "aborted", "close"]) response.on(event, settle);
      },
    );
    request.on("error", reject);
    request.end(data);
  });
}

const streamReply = (usage) => ({
  headers: { "content-type": "text/event-stream" },
  chunks: [Buffer.from(streamFor(usage), "utf8")],
});

test("a deterministic multi-actor session produces exact, fully linked totals", needsDriver, async (t) => {
  const usageByModel = {
    "claude-opus-5": { input: 1000, output: 100, cacheRead: 500, cacheCreate: 20 },
    "claude-haiku-4-5-20251001": { input: 200, output: 40, cacheRead: 0, cacheCreate: 0 },
  };
  const harnessed = await harness(t, {
    route: async ({ prompt }) => choose(prompt.startsWith("main") ? "opus-high" : "haiku-default"),
    respond: (request) => streamReply(usageByModel[request.model]),
  });
  const { send, read } = harnessed;

  await send(body({ actor: "main", type: "main", turn: "t1", prompt: "main task" }));
  await send(body({ actor: "main", type: "main", turn: "t1", prompt: "main task", toolResult: "ok" }));
  await send(body({ actor: "sub", type: "subagent", parent: "main", turn: "s1", prompt: "sub task" }));
  await send(
    body({ actor: "sub", type: "subagent", parent: "main", turn: "s1", prompt: "sub task", toolResult: "ok" }),
  );
  await send(body({ actor: "main", type: "main", turn: "t1", prompt: "main task", toolResult: "done" }));

  const db = await read();
  const sessionId = "s-telemetry";

  // Two fresh decisions, five requests: routes count decisions, not traffic.
  const routes = routeDistribution(db, { sessionId });
  assert.equal(
    routes.reduce((total, { routes: count }) => total + count, 0),
    2,
  );
  assert.deepEqual(
    routes.map(({ model, effort }) => `${model}/${effort}`).sort(),
    ["claude-haiku-4-5-20251001/null", "claude-opus-5/high"].sort(),
  );

  const requests = requestBreakdown(db, { sessionId });
  assert.equal(
    requests.reduce((total, { requests: count }) => total + count, 0),
    5,
  );
  assert.equal(
    requests
      .filter(({ isContinuation }) => isContinuation === 1)
      .reduce((total, { requests: count }) => total + count, 0),
    3,
  );

  const actors = actorBreakdown(db, { sessionId });
  assert.deepEqual(
    actors.map(({ actorType, routes: r, requests: q, continuations }) => [actorType, r, q, continuations]),
    [
      ["main", 1, 3, 2],
      ["subagent", 1, 2, 1],
    ],
  );
  assert.equal(actors[1].parentActorId, actors[0].id, "the subagent is linked to its parent");

  // Three opus responses at 1000/100 and two haiku at 200/40, each counted once.
  const totals = usageTotals(db, { sessionId });
  assert.equal(totals.inputTokens, 3 * 1000 + 2 * 200);
  assert.equal(totals.outputTokens, 3 * 100 + 2 * 40);
  assert.equal(totals.cacheReadInputTokens, 3 * 500);
  assert.equal(totals.cacheCreationInputTokens, 3 * 20);
  assert.equal(totals.requests, 5);
  assert.equal(totals.requestsMissingUsage, 0);
  assert.equal(totals.complete, true);

  const byRoute = usageByRoute(db, { sessionId });
  assert.equal(byRoute.length, 2);
  assert.equal(byRoute.find(({ model }) => model === "claude-opus-5").outputTokens, 300);
  assert.equal(
    byRoute.find(({ model }) => model === "claude-haiku-4-5-20251001").outputTokens,
    80,
  );

  const cost = routingCost(db, { sessionId });
  assert.equal(cost.jevCalls, 2);
  assert.ok(Math.abs(cost.jevCostUsd - 0.0002) < 1e-9, "routing cost is the provider's own figure");
  assert.equal(cost.averageLatencyMs, 25);

  // Every stored row resolves to its parents.
  assert.equal(db.pragma("foreign_key_check").length, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM inference_requests WHERE route_id IS NULL").get().c,
    0,
    "every request is attributed to the route that served it",
  );
});

test("the forwarded response is byte-identical to what upstream sent", needsDriver, async (t) => {
  const payload = streamFor({ input: 10, output: 20 });
  const fragments = [];
  for (let at = 0; at < payload.length; at += 7) {
    fragments.push(Buffer.from(payload.slice(at, at + 7), "utf8"));
  }
  const { send, sent } = await harness(t, {
    route: async () => choose("opus-high"),
    respond: () => ({ headers: { "content-type": "text/event-stream" }, chunks: fragments }),
  });

  const response = await send(body({ actor: "main", type: "main", turn: "t1", prompt: "main task" }));
  const received = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(received, Buffer.concat(sent[0].chunks));
  assert.equal(received.toString("utf8"), payload);
});

test("a compressed response is forwarded compressed and still yields usage", needsDriver, async (t) => {
  const payload = streamFor({ input: 77, output: 88 });
  const compressed = zlib.gzipSync(Buffer.from(payload, "utf8"));
  const harnessed = await harness(t, {
    route: async () => choose("opus-high"),
    respond: () => ({
      headers: { "content-type": "text/event-stream", "content-encoding": "gzip" },
      chunks: [compressed.subarray(0, 20), compressed.subarray(20)],
    }),
  });

  const response = await postRaw(
    harnessed.port,
    body({ actor: "main", type: "main", turn: "t1", prompt: "main task" }),
  );
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.deepEqual(response.body, compressed, "the compressed bytes pass through untouched");

  const db = await harnessed.read();
  const totals = usageTotals(db, { sessionId: "s-telemetry" });
  assert.equal(totals.inputTokens, 77);
  assert.equal(totals.outputTokens, 88);
});

test("a stream cut short is forwarded as-is and recorded as incomplete usage", needsDriver, async (t) => {
  const payload = streamFor({ input: 500, output: 60 });
  const truncated = payload.slice(0, payload.indexOf("message_stop"));
  const harnessed = await harness(t, {
    route: async () => choose("opus-high"),
    respond: () => ({
      headers: { "content-type": "text/event-stream" },
      chunks: [Buffer.from(truncated, "utf8")],
      destroy: true,
    }),
  });

  await postRaw(harnessed.port, body({ actor: "main", type: "main", turn: "t1", prompt: "main task" })).catch(
    () => null,
  );

  const db = await harnessed.read();
  const stored = db.prepare("SELECT raw_usage_json j FROM usage_events").get();
  assert.ok(stored, "partial usage is still recorded");
  const raw = JSON.parse(stored.j);
  assert.equal(raw.input_tokens, 500);
  assert.equal(raw.complete, false, "an interrupted stream is visibly incomplete");
});

test("a response with no usage leaves the request visibly unaccounted for", needsDriver, async (t) => {
  const harnessed = await harness(t, {
    route: async () => choose("opus-high"),
    respond: () => ({
      headers: { "content-type": "application/json" },
      chunks: [Buffer.from('{"id":"msg_1","type":"message"}', "utf8")],
    }),
  });
  await harnessed.send(body({ actor: "main", type: "main", turn: "t1", prompt: "main task" }));

  const db = await harnessed.read();
  const totals = usageTotals(db, { sessionId: "s-telemetry" });
  assert.equal(totals.requests, 1);
  assert.equal(totals.requestsMissingUsage, 1);
  assert.equal(totals.inputTokens, null, "unknown, not zero");
  assert.equal(totals.complete, false);
});

test("an upstream error is recorded as a failed request without usage", needsDriver, async (t) => {
  const harnessed = await harness(t, {
    route: async () => choose("opus-high"),
    respond: () => ({
      status: 400,
      headers: { "content-type": "application/json" },
      chunks: [Buffer.from('{"type":"error","error":{"message":"bad request"}}', "utf8")],
    }),
  });
  const response = await harnessed.send(
    body({ actor: "main", type: "main", turn: "t1", prompt: "main task" }),
  );
  assert.equal(response.status, 400, "the status passes through unchanged");

  const db = await harnessed.read();
  const stored = db.prepare("SELECT http_status s, success ok FROM inference_requests").get();
  assert.equal(stored.s, 400);
  assert.equal(stored.ok, 0);
});

test("a connection failure before response headers is recorded as a failed attempt", needsDriver, async (t) => {
  const harnessed = await harness(t, {
    route: async () => choose("opus-high"),
    respond: () => ({ destroyBeforeHeaders: true }),
  });
  const response = await harnessed.send(
    body({ actor: "main", type: "main", turn: "t1", prompt: "main task" }),
  );
  assert.equal(response.status, 502);

  const db = await harnessed.read();
  const stored = db.prepare("SELECT http_status s, success ok FROM inference_requests").get();
  assert.equal(stored.s, 502);
  assert.equal(stored.ok, 0);
});

test("telemetry stores a request hash and no prompt text by default", needsDriver, async (t) => {
  const secret = "deploy with token sk-ant-do-not-store-me";
  const harnessed = await harness(t, {
    route: async () => choose("opus-high"),
    respond: () => streamReply({ input: 5, output: 5 }),
  });
  await harnessed.send(body({ actor: "main", type: "main", turn: "t1", prompt: secret }));

  const db = await harnessed.read();
  const route = db.prepare("SELECT request_hash h, prompt_preview p FROM routes").get();
  assert.match(route.h, /^[0-9a-f]{64}$/, "a hash is stored instead of the prompt");
  assert.equal(route.p, null);

  const everything = ["sessions", "actors", "routes", "inference_requests", "usage_events"]
    .map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()))
    .join("\n");
  assert.equal(everything.includes("do-not-store-me"), false, "no prompt text reached the database");
  assert.equal(everything.includes("sk-ant-"), false, "no secret-shaped token reached the database");
});

test("an unwritable telemetry database never affects forwarding", needsDriver, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jev-telemetry-broken-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "telemetry.sqlite3");
  writeFileSync(path, "this file is not a database");

  const harnessed = await harness(t, {
    path,
    route: async () => choose("opus-high"),
    respond: () => streamReply({ input: 12, output: 34 }),
  });

  const response = await harnessed.send(
    body({ actor: "main", type: "main", turn: "t1", prompt: "main task" }),
  );
  const received = await response.text();
  assert.equal(response.status, 200);
  assert.ok(received.includes("message_stop"), "the full response still arrived");
  assert.equal(harnessed.asked.length, 1, "routing was unaffected");

  await harnessed.telemetry.flush({ timeoutMs: 1500 });
  assert.equal(harnessed.telemetry.stats().failed, true, "the failure is visible in the counters");
});

test("a disk-full writer drops telemetry but never affects forwarding", needsDriver, async (t) => {
  const recorder = createRecorder({
    env: { JEV_ENABLE_TELEMETRY: "1" },
    path: ":memory:",
    workerURL: new URL("../fixtures/telemetry/full-worker.mjs", import.meta.url),
  });
  const telemetry = createTelemetry({ recorder, routerVersion: "test" });
  const harnessed = await harness(t, {
    telemetry,
    route: async () => choose("opus-high"),
    respond: () => streamReply({ input: 12, output: 34 }),
  });

  const response = await harnessed.send(
    body({ actor: "main", type: "main", turn: "t1", prompt: "main task" }),
  );
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes("message_stop"));
  await telemetry.flush();
  assert.ok(telemetry.stats().rejected >= 5, "each lost telemetry event is counted");
  assert.equal(telemetry.stats().failed, false, "a full disk does not disable routing");
});

test("with telemetry disabled nothing is written and routing is unchanged", async (t) => {
  const telemetry = createTelemetry({ recorder: createRecorder({ env: {} }), routerVersion: "test" });
  const harnessed = await harness(t, {
    telemetry,
    route: async () => choose("opus-high"),
    respond: () => streamReply({ input: 1, output: 2 }),
  });

  const response = await harnessed.send(
    body({ actor: "main", type: "main", turn: "t1", prompt: "main task" }),
  );
  assert.equal(response.status, 200);
  assert.equal(harnessed.asked.length, 1);
  assert.equal(telemetry.enabled, false);
  assert.equal(existsSync(harnessed.dbPath), false, "no database is created when telemetry is off");
});

test("auxiliary and unidentified traffic is counted rather than misattributed", needsDriver, async (t) => {
  const harnessed = await harness(t, {
    route: async () => choose("opus-high"),
    respond: () => streamReply({ input: 10, output: 10 }),
  });

  await harnessed.send(body({ actor: "main", type: "main", turn: "t1", prompt: "main task" }));
  await harnessed.send({
    model: "claude-haiku-4-5-20251001",
    metadata: { user_id: JSON.stringify({ session_id: "s-telemetry" }) },
    messages: [{ role: "user", content: "write a conversation title" }],
  });

  const db = await harnessed.read();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM inference_requests").get().c, 1);
  assert.equal(
    harnessed.telemetry.stats().unattributedRequests,
    1,
    "the auxiliary call is counted, not attributed to the main actor",
  );
  const totals = usageTotals(db, { sessionId: "s-telemetry" });
  assert.equal(totals.inputTokens, 10, "auxiliary tokens are not folded into the actor's totals");
});

test("two concurrent actors record independent routes and usage", needsDriver, async (t) => {
  const harnessed = await harness(t, {
    route: async ({ prompt }) => choose(prompt === "task a" ? "haiku-default" : "sonnet-medium"),
    respond: (request) =>
      streamReply(
        request.model === "claude-haiku-4-5-20251001"
          ? { input: 11, output: 22 }
          : { input: 33, output: 44 },
      ),
  });

  await Promise.all([
    harnessed.send(body({ actor: "a", type: "subagent", parent: "main", turn: "ta", prompt: "task a" })),
    harnessed.send(body({ actor: "b", type: "subagent", parent: "main", turn: "tb", prompt: "task b" })),
  ]);

  const db = await harnessed.read();
  const byRoute = usageByRoute(db, { sessionId: "s-telemetry" });
  assert.equal(byRoute.length, 2);
  assert.deepEqual(
    byRoute.map(({ model, inputTokens, outputTokens }) => [model, inputTokens, outputTokens]).sort(),
    [
      ["claude-haiku-4-5-20251001", 11, 22],
      ["claude-sonnet-5", 33, 44],
    ].sort(),
  );
});

test("no prompt text or secret reaches the database file, its WAL, or the sidecars", needsDriver, async (t) => {
  const canary = "CANARY-PROMPT-TEXT-9f2a";
  const secret = "sk-ant-api03-CANARYSECRET";
  const harnessed = await harness(t, {
    route: async () => choose("opus-high"),
    respond: () => streamReply({ input: 5, output: 5 }),
  });
  await harnessed.send(
    body({ actor: "main", type: "main", turn: "t1", prompt: `${canary} using ${secret}` }),
  );
  await harnessed.telemetry.flush();

  // Read the raw files rather than the rows: a value could survive in a WAL frame or a freed
  // page even when no query returns it.
  const onDisk = readdirSync(harnessed.dir)
    .map((name) => readFileSync(join(harnessed.dir, name)))
    .map((buffer) => buffer.toString("latin1"))
    .join("\n");
  assert.ok(onDisk.length > 0, "there is something on disk to inspect");
  assert.equal(onDisk.includes(canary), false, "prompt text reached the telemetry files");
  assert.equal(onDisk.includes(secret), false, "a secret reached the telemetry files");
  assert.equal(onDisk.includes("sk-ant-"), false, "a secret-shaped token reached the telemetry files");
});

test("a prompt preview is stored only when explicitly enabled", needsDriver, async (t) => {
  const previous = process.env.JEV_STORE_PROMPT_PREVIEW;
  process.env.JEV_STORE_PROMPT_PREVIEW = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.JEV_STORE_PROMPT_PREVIEW;
    else process.env.JEV_STORE_PROMPT_PREVIEW = previous;
  });

  const harnessed = await harness(t, {
    route: async () => choose("opus-high"),
    respond: () => streamReply({ input: 5, output: 5 }),
  });
  await harnessed.send(body({ actor: "main", type: "main", turn: "t1", prompt: "refactor the router" }));

  const db = await harnessed.read();
  const stored = db.prepare("SELECT prompt_preview p FROM routes").get();
  assert.equal(stored.p, "refactor the router");
});

test("telemetry survives a restart and keeps both sessions' data", needsDriver, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jev-telemetry-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "telemetry.sqlite3");

  const first = await harness(t, {
    path,
    route: async () => choose("opus-high"),
    respond: () => streamReply({ input: 100, output: 10 }),
  });
  await first.send(body({ session: "run-1", actor: "main", type: "main", turn: "t1", prompt: "first run" }));
  await first.telemetry.close();

  // A second proxy against the same database is a restart: the schema is already current, so
  // the existing rows must survive and new ones must append.
  const second = await harness(t, {
    path,
    route: async () => choose("haiku-default"),
    respond: () => streamReply({ input: 200, output: 20 }),
  });
  await second.send(body({ session: "run-2", actor: "main", type: "main", turn: "t1", prompt: "second run" }));

  const db = await second.read();
  assert.deepEqual(
    db.prepare("SELECT id FROM sessions ORDER BY id").all().map(({ id }) => id),
    ["run-1", "run-2"],
  );
  const totals = usageTotals(db, {});
  assert.equal(totals.inputTokens, 300, "both runs' usage is present");
  assert.equal(db.pragma("user_version", { simple: true }), 1);
});

test("closing the proxy marks observed sessions ended so retention can expire them", needsDriver, async (t) => {
  const harnessed = await harness(t, {
    route: async () => choose("opus-high"),
    respond: () => streamReply({ input: 5, output: 5 }),
  });
  await harnessed.send(body({ actor: "main", type: "main", turn: "t1", prompt: "main task" }));

  await harnessed.telemetry.close();
  const db = openReader({ path: harnessed.dbPath });
  t.after(() => db?.close());
  const session = db.prepare("SELECT started_at startedAt, ended_at endedAt FROM sessions").get();
  assert.equal(typeof session.endedAt, "number");
  assert.ok(session.endedAt >= session.startedAt);
});

test("a locked database never delays or breaks forwarding", needsDriver, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jev-telemetry-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "telemetry.sqlite3");

  // Create the schema, then hold an exclusive write lock from another connection.
  const first = await harness(t, {
    path,
    route: async () => choose("opus-high"),
    respond: () => streamReply({ input: 10, output: 10 }),
  });
  await first.send(body({ session: "before-lock", actor: "main", type: "main", turn: "t1", prompt: "first" }));
  await first.telemetry.close();

  const locker = new driver(path);
  locker.pragma("journal_mode = WAL");
  locker.exec("BEGIN EXCLUSIVE");
  t.after(() => {
    try {
      locker.exec("ROLLBACK");
      locker.close();
    } catch {
      // Already released.
    }
  });

  const locked = await harness(t, {
    path,
    route: async () => choose("opus-high"),
    respond: () => streamReply({ input: 20, output: 20 }),
  });
  const started = Date.now();
  const response = await locked.send(
    body({ session: "during-lock", actor: "main", type: "main", turn: "t1", prompt: "second" }),
  );
  const elapsed = Date.now() - started;

  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes("message_stop"), "the response arrived in full");
  assert.ok(elapsed < 1500, `forwarding waited ${elapsed}ms on a locked database`);
  assert.equal(locked.asked.length, 1, "routing was unaffected");
});

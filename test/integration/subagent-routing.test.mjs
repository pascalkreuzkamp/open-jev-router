import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy } from "../../src/proxy.mjs";
import { readStatus } from "../../src/status.mjs";

const CATALOG = [
  { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" },
  { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
  { id: "claude-opus-5", display_name: "Claude Opus 5" },
];

const TOOLS = [{ name: "Bash" }, { name: "Task" }];

/**
 * All correlation metadata below is synthetic. No captured Claude Code request is known to
 * carry actor fields (overview blocker B-002), so these runs prove the router's behaviour
 * given correlation, not that Claude Code supplies it.
 */
function body({ session = "s-canonical", actor, type, parent, turn, prompt, toolResult, model = "jev-router", extra = {} }) {
  const messages = [{ role: "user", content: prompt }];
  if (toolResult) {
    messages.push(
      { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: toolResult }] },
    );
  }
  return {
    model,
    tools: TOOLS,
    metadata: {
      user_id: JSON.stringify({
        session_id: session,
        actor_id: actor,
        actor_type: type,
        ...(parent ? { parent_actor_id: parent } : {}),
        ...(turn ? { logical_turn_id: turn } : {}),
        ...extra,
      }),
    },
    messages,
  };
}

async function harness(t, { route, env = {} } = {}) {
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
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message","model":"claude-sonnet-5"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const previous = {};
  for (const [name, value] of Object.entries(env)) {
    previous[name] = process.env[name];
    process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const asked = [];
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async (question) => {
      asked.push(question);
      return route(question, asked.length);
    },
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.json());
  const send = (payload) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  return { seen, asked, send };
}

const choose = (id) => ({ choice: id, confidence: 0.92, provider: "mock", decisionId: `dec-${id}`, ms: 1 });

test("the canonical flow routes exactly once per boundary and pins each actor independently", async (t) => {
  const byPrompt = {
    "refactor the router": "opus-high",
    "explore the test directory": "haiku-default",
    "summarise the changelog": "sonnet-medium",
  };
  const { seen, asked, send } = await harness(t, {
    route: async ({ prompt }) => {
      const id = byPrompt[prompt];
      assert.ok(id, `unexpected Jev call for prompt ${JSON.stringify(prompt)}`);
      return choose(id);
    },
  });

  // 1. main fresh turn
  await send(body({ actor: "main", type: "main", turn: "t1", prompt: "refactor the router" }));
  // 2. main tool continuation
  await send(
    body({ actor: "main", type: "main", turn: "t1", prompt: "refactor the router", toolResult: "ok" }),
  );
  // 3. subagent A fresh
  await send(
    body({ actor: "sub-a", type: "subagent", parent: "main", turn: "ta1", prompt: "explore the test directory" }),
  );
  // 4. subagent A tool continuation
  await send(
    body({
      actor: "sub-a",
      type: "subagent",
      parent: "main",
      turn: "ta1",
      prompt: "explore the test directory",
      toolResult: "files listed",
    }),
  );
  // 5. subagent B fresh, concurrent with A
  await send(
    body({ actor: "sub-b", type: "subagent", parent: "main", turn: "tb1", prompt: "summarise the changelog" }),
  );
  // 6. the main agent's turn resumes with the subagent results
  await send(
    body({ actor: "main", type: "main", turn: "t1", prompt: "refactor the router", toolResult: "subagents done" }),
  );

  assert.equal(asked.length, 3, "one Jev decision per routed boundary, none for continuations");
  assert.deepEqual(
    seen.map(({ model }) => model),
    [
      "claude-opus-5",
      "claude-opus-5",
      "claude-haiku-4-5-20251001",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-5",
      "claude-opus-5",
    ],
  );
  assert.deepEqual(
    seen.map(({ output_config }) => output_config?.effort ?? null),
    ["high", "high", null, null, "medium", "high"],
  );
});

test("a subagent's route never overwrites the main agent's pin, in either order", async (t) => {
  const { seen, asked, send } = await harness(t, {
    route: async ({ prompt }) => choose(prompt.startsWith("main") ? "opus-high" : "haiku-default"),
  });

  await send(body({ actor: "main", type: "main", turn: "t1", prompt: "main task" }));
  await send(body({ actor: "sub", type: "subagent", parent: "main", turn: "s1", prompt: "sub task" }));
  await send(body({ actor: "main", type: "main", turn: "t1", prompt: "main task", toolResult: "ok" }));
  await send(body({ actor: "sub", type: "subagent", parent: "main", turn: "s1", prompt: "sub task", toolResult: "ok" }));

  assert.equal(asked.length, 2);
  assert.deepEqual(
    seen.map(({ model }) => model),
    ["claude-opus-5", "claude-haiku-4-5-20251001", "claude-opus-5", "claude-haiku-4-5-20251001"],
  );
});

test("two identical simultaneous subagent tasks get independent routes and one decision each", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { seen, asked, send } = await harness(t, {
    route: async ({ prompt }, callNumber) => {
      assert.equal(prompt, "identical task");
      await gate;
      return choose(callNumber === 1 ? "haiku-default" : "sonnet-medium");
    },
  });

  const both = Promise.all([
    send(body({ actor: "sub-a", type: "subagent", parent: "main", turn: "ta", prompt: "identical task" })),
    send(body({ actor: "sub-b", type: "subagent", parent: "main", turn: "tb", prompt: "identical task" })),
  ]);
  release();
  await both;

  assert.equal(asked.length, 2, "identical task text must not collapse two actors into one");
  assert.deepEqual(
    seen.map(({ model }) => model).sort(),
    ["claude-haiku-4-5-20251001", "claude-sonnet-5"],
  );
});

test("simultaneous requests for one boundary make a single Jev call", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { seen, asked, send } = await harness(t, {
    route: async () => {
      await gate;
      return choose("opus-high");
    },
  });

  const both = Promise.all([
    send(body({ actor: "main", type: "main", turn: "t1", prompt: "one boundary" })),
    send(body({ actor: "main", type: "main", turn: "t1", prompt: "one boundary" })),
  ]);
  release();
  await both;

  assert.equal(asked.length, 1);
  assert.deepEqual(seen.map(({ model }) => model), ["claude-opus-5", "claude-opus-5"]);
});

test("interleaved sessions keep separate main pins", async (t) => {
  const { seen, asked, send } = await harness(t, {
    route: async ({ prompt }) => choose(prompt === "session one" ? "opus-high" : "haiku-default"),
  });

  await send(body({ session: "s1", actor: "main", type: "main", turn: "t1", prompt: "session one" }));
  await send(body({ session: "s2", actor: "main", type: "main", turn: "t1", prompt: "session two" }));
  await send(body({ session: "s1", actor: "main", type: "main", turn: "t1", prompt: "session one", toolResult: "ok" }));
  await send(body({ session: "s2", actor: "main", type: "main", turn: "t1", prompt: "session two", toolResult: "ok" }));

  assert.equal(asked.length, 2);
  assert.deepEqual(
    seen.map(({ model }) => model),
    ["claude-opus-5", "claude-haiku-4-5-20251001", "claude-opus-5", "claude-haiku-4-5-20251001"],
  );
});

test("subagent policy inherit takes the parent's route and asks Jev nothing", async (t) => {
  const { seen, asked, send } = await harness(t, {
    env: { JEV_SUBAGENT_MODEL_POLICY: "inherit" },
    route: async () => choose("opus-high"),
  });

  await send(body({ actor: "main", type: "main", turn: "t1", prompt: "main task" }));
  await send(body({ actor: "sub", type: "subagent", parent: "main", turn: "s1", prompt: "sub task" }));

  assert.equal(asked.length, 1, "inherit must not consult Jev for the subagent");
  assert.deepEqual(seen.map(({ model }) => model), ["claude-opus-5", "claude-opus-5"]);
  assert.equal(seen[1].output_config?.effort, "high");
});

test("subagent policy respect-explicit leaves an explicitly requested model alone", async (t) => {
  const { seen, asked, send } = await harness(t, {
    env: { JEV_SUBAGENT_MODEL_POLICY: "respect-explicit" },
    route: async () => choose("haiku-default"),
  });

  await send(
    body({
      actor: "sub",
      type: "subagent",
      parent: "main",
      turn: "s1",
      prompt: "sub task",
      model: "claude-opus-5",
      extra: { model_source: "default" },
    }),
  );
  assert.equal(asked.length, 0);
  assert.equal(seen[0].model, "claude-opus-5");
});

test("a user hard lock on a subagent wins under the default route policy", async (t) => {
  const { seen, asked, send } = await harness(t, { route: async () => choose("haiku-default") });

  await send(
    body({
      actor: "sub",
      type: "subagent",
      parent: "main",
      turn: "s1",
      prompt: "sub task",
      model: "claude-opus-5",
      extra: { model_source: "user" },
    }),
  );
  assert.equal(asked.length, 0);
  assert.equal(seen[0].model, "claude-opus-5");
});

test("auxiliary traffic makes no Jev call and changes no pin", async (t) => {
  const { seen, asked, send } = await harness(t, { route: async () => choose("opus-high") });

  const session = "s-aux";
  await send(body({ session, actor: "main", type: "main", turn: "t1", prompt: "main task" }));
  const before = readStatus(session);
  await send({
    model: "claude-haiku-4-5-20251001",
    metadata: { user_id: JSON.stringify({ session_id: session, actor_id: "main", actor_type: "main" }) },
    messages: [{ role: "user", content: "write a conversation title" }],
  });
  await send(body({ session, actor: "main", type: "main", turn: "t1", prompt: "main task", toolResult: "ok" }));

  assert.equal(asked.length, 1);
  assert.deepEqual(seen.map(({ model }) => model), [
    "claude-opus-5",
    "claude-haiku-4-5-20251001",
    "claude-opus-5",
  ]);
  assert.deepEqual(readStatus(session), before, "auxiliary traffic must not rewrite the status file");
});

test("an auxiliary request carrying the sentinel is resolved to a real model", async (t) => {
  const { seen, asked, send } = await harness(t, { route: async () => choose("opus-high") });
  await send({
    model: "jev-router",
    metadata: { user_id: JSON.stringify({ session_id: "s-aux2" }) },
    messages: [{ role: "user", content: "write a conversation title" }],
  });
  assert.equal(asked.length, 0);
  assert.equal(seen[0].model, "claude-haiku-4-5-20251001");
});

test("auxiliary policy fast and inherit pick their documented routes", async (t) => {
  const inheritRun = await harness(t, {
    env: { JEV_AUXILIARY_POLICY: "inherit" },
    route: async () => choose("opus-high"),
  });
  await inheritRun.send(body({ session: "s-i", actor: "main", type: "main", turn: "t1", prompt: "main task" }));
  await inheritRun.send({
    model: "claude-haiku-4-5-20251001",
    metadata: { user_id: JSON.stringify({ session_id: "s-i", actor_id: "main", actor_type: "main" }) },
    messages: [{ role: "user", content: "title this" }],
  });
  assert.equal(inheritRun.seen[1].model, "claude-opus-5");

  const fastRun = await harness(t, {
    env: { JEV_AUXILIARY_POLICY: "fast" },
    route: async () => choose("opus-high"),
  });
  await fastRun.send(body({ session: "s-f", actor: "main", type: "main", turn: "t1", prompt: "main task" }));
  await fastRun.send({
    model: "claude-sonnet-5",
    metadata: { user_id: JSON.stringify({ session_id: "s-f", actor_id: "main", actor_type: "main" }) },
    messages: [{ role: "user", content: "title this" }],
  });
  assert.equal(fastRun.seen[1].model, "claude-haiku-4-5-20251001");
});

test("an unidentified actor fails open without touching the main agent's pin", async (t) => {
  const { seen, asked, send } = await harness(t, {
    route: async () => choose("haiku-default"),
  });

  // No correlation at all: the first root establishes main, a second root stays unknown.
  await send({
    model: "jev-router",
    tools: TOOLS,
    metadata: { user_id: JSON.stringify({ session_id: "s-anon" }) },
    messages: [{ role: "user", content: "the main task" }],
  });
  await send({
    model: "jev-router",
    tools: TOOLS,
    metadata: { user_id: JSON.stringify({ session_id: "s-anon" }) },
    messages: [{ role: "user", content: "an unidentifiable second root" }],
  });
  await send({
    model: "jev-router",
    tools: TOOLS,
    metadata: { user_id: JSON.stringify({ session_id: "s-anon" }) },
    messages: [
      { role: "user", content: "the main task" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
    ],
  });

  assert.equal(asked.length, 1, "an unknown actor is never routed");
  assert.deepEqual(seen.map(({ model }) => model), [
    "claude-haiku-4-5-20251001",
    "claude-opus-5-5",
    "claude-haiku-4-5-20251001",
  ]);
});

test("a malformed body reaches upstream unrouted with the sentinel resolved", async (t) => {
  const { seen, asked, send } = await harness(t, { route: async () => choose("haiku-default") });
  await send({ model: "jev-router", tools: TOOLS, messages: "not an array" });
  assert.equal(asked.length, 0);
  assert.equal(seen[0].model, "claude-opus-5-5");
});

test("a manual selection reports manual state without disturbing another actor", async (t) => {
  const session = "s-manual";
  const { seen, asked, send } = await harness(t, { route: async () => choose("haiku-default") });

  await send(body({ session, actor: "main", type: "main", turn: "t1", prompt: "main task" }));
  assert.equal(readStatus(session).model, "claude-haiku-4-5-20251001");
  await send(
    body({ session, actor: "main", type: "main", turn: "t2", prompt: "next task", model: "claude-opus-5" }),
  );

  assert.equal(readStatus(session).manual, true);
  assert.equal(asked.length, 1);
  assert.deepEqual(seen.map(({ model }) => model), ["claude-haiku-4-5-20251001", "claude-opus-5"]);
});

test("returning to the Jev Router row resumes routing at the next boundary", async (t) => {
  const session = "s-resume";
  const { seen, asked, send } = await harness(t, { route: async () => choose("haiku-default") });

  // Routed, then the user picks a concrete model from /model, then picks Jev Router again.
  await send(body({ session, actor: "main", type: "main", turn: "t1", prompt: "first task" }));
  await send(body({ session, actor: "main", type: "main", turn: "t2", prompt: "second task", model: "claude-opus-5" }));
  assert.equal(readStatus(session).manual, true);
  await send(body({ session, actor: "main", type: "main", turn: "t3", prompt: "third task" }));

  assert.equal(asked.length, 2, "the manual turn bought no decision; the return bought one");
  assert.deepEqual(
    seen.map(({ model }) => model),
    ["claude-haiku-4-5-20251001", "claude-opus-5", "claude-haiku-4-5-20251001"],
  );
  // The status line treats any falsy `manual` as routed, so a routed decision simply omits it.
  assert.ok(!readStatus(session).manual, "the status line stops reporting a paused router");
});

test("after a restart a continuation falls back safely instead of reconstructing identity", async (t) => {
  const first = await harness(t, { route: async () => choose("haiku-default") });
  await first.send(body({ session: "s-restart", actor: "main", type: "main", turn: "t1", prompt: "main task" }));
  assert.equal(first.seen[0].model, "claude-haiku-4-5-20251001");

  // A second proxy is a restart: its registry is empty, and the persisted decision from the
  // first run is telemetry, not identity, so it must not be replayed as a pin.
  const restarted = await harness(t, { route: async () => choose("haiku-default") });
  await restarted.send(
    body({ session: "s-restart", actor: "main", type: "main", turn: "t1", prompt: "main task", toolResult: "ok" }),
  );
  assert.equal(restarted.asked.length, 0, "a continuation is never a routing boundary");
  assert.equal(restarted.seen[0].model, "claude-opus-5-5", "falls back to the strongest safe model");

  await restarted.send(
    body({ session: "s-restart", actor: "main", type: "main", turn: "t2", prompt: "a new turn" }),
  );
  assert.equal(restarted.asked.length, 1, "routing resumes at the next confirmed boundary");
  assert.equal(restarted.seen[1].model, "claude-haiku-4-5-20251001");
});

test("a nested subagent inherits from its own parent, not from the root agent", async (t) => {
  const { seen, asked, send } = await harness(t, {
    env: { JEV_SUBAGENT_MODEL_POLICY: "inherit" },
    route: async () => choose("opus-high"),
  });

  await send(body({ actor: "main", type: "main", turn: "t1", prompt: "main task" }));
  // The intermediate subagent is routed by Jev-free inheritance from main...
  await send(body({ actor: "sub", type: "subagent", parent: "main", turn: "s1", prompt: "sub task" }));
  // ...and the nested actor inherits that same pinned route through its own parent link.
  await send(body({ actor: "nested", type: "subagent", parent: "sub", turn: "n1", prompt: "nested task" }));

  assert.equal(asked.length, 1);
  assert.deepEqual(seen.map(({ model }) => model), [
    "claude-opus-5",
    "claude-opus-5",
    "claude-opus-5",
  ]);
});

test("an orphaned subagent under inherit falls back rather than borrowing another actor's route", async (t) => {
  const { seen, asked, send } = await harness(t, {
    env: { JEV_SUBAGENT_MODEL_POLICY: "inherit" },
    route: async () => choose("opus-high"),
  });

  await send(body({ actor: "main", type: "main", turn: "t1", prompt: "main task" }));
  // No parent_actor_id: the parent route is not safely known, so main's opus pin is not taken.
  await send(body({ actor: "orphan", type: "subagent", turn: "o1", prompt: "orphan task" }));

  assert.equal(asked.length, 2, "an unknown parent falls back to an ordinary routed decision");
  assert.deepEqual(seen.map(({ model }) => model), ["claude-opus-5", "claude-opus-5"]);
});

test("a retried request for the same boundary reuses the pin without a second Jev call", async (t) => {
  const { seen, asked, send } = await harness(t, { route: async () => choose("sonnet-medium") });
  const payload = body({ actor: "main", type: "main", turn: "t1", prompt: "retried task" });
  await send(payload);
  await send(payload);
  assert.equal(asked.length, 1);
  assert.deepEqual(seen.map(({ model }) => model), ["claude-sonnet-5", "claude-sonnet-5"]);
  assert.deepEqual(seen.map(({ output_config }) => output_config?.effort ?? null), ["medium", "medium"]);
});

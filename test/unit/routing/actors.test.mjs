import test from "node:test";
import assert from "node:assert/strict";
import { inspectClaudeRequest } from "../../../src/claude/adapter.mjs";
import { ActorRegistry, RESEND_WINDOW_MS } from "../../../src/routing/actors.mjs";

const TOOLS = [{ name: "Bash" }];

const request = ({ metadata = {}, root = "root task", shape = "fresh" } = {}) => {
  const messages = [{ role: "user", content: root }];
  if (shape === "continuation") {
    messages.push(
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    );
  }
  return inspectClaudeRequest({
    model: "jev-router",
    tools: TOOLS,
    metadata: { user_id: JSON.stringify(metadata) },
    messages,
  });
};

const route = (model) => ({ model, legacyTier: "sonnet" });

test("explicit wire correlation identifies an actor with high confidence", () => {
  const registry = new ActorRegistry();
  const detection = registry.detect(
    request({ metadata: { session_id: "s1", actor_id: "a1", actor_type: "main" } }),
  );
  assert.equal(detection.actorType, "main");
  assert.equal(detection.actorKey, "wire:a1");
  assert.equal(detection.confidence, "high");
  assert.equal(detection.isFresh, true);
  assert.equal(detection.actor.requestCount, 1);
});

test("a subagent keeps its own state and records its parent link", () => {
  const registry = new ActorRegistry();
  registry.detect(request({ metadata: { session_id: "s1", actor_id: "main", actor_type: "main" } }));
  const sub = registry.detect(
    request({
      metadata: {
        session_id: "s1",
        actor_id: "sub-a",
        parent_actor_id: "main",
        actor_type: "subagent",
        agent_name: "Explore",
      },
      root: "explore the tests",
    }),
  );
  assert.equal(sub.actorType, "subagent");
  assert.equal(sub.parentActorKey, "wire:main");
  assert.equal(sub.actor.agentName, "Explore");
  assert.equal(registry.parentOf(sub).actorKey, "wire:main");
  assert.equal(sub.session.mainActorKey, "wire:main");
});

test("two identical concurrent subagent tasks stay separate actors", () => {
  const registry = new ActorRegistry();
  const shared = { session_id: "s1", parent_actor_id: "main", actor_type: "subagent" };
  const a = registry.detect(request({ metadata: { ...shared, actor_id: "sub-a" }, root: "same text" }));
  const b = registry.detect(request({ metadata: { ...shared, actor_id: "sub-b" }, root: "same text" }));
  assert.notEqual(a.actorKey, b.actorKey);
  assert.equal(a.actor.fingerprint, b.actor.fingerprint);
  a.actor.pinnedRoute = route("claude-haiku-4-5-20251001");
  b.actor.pinnedRoute = route("claude-sonnet-5");
  assert.equal(a.actor.pinnedRoute.model, "claude-haiku-4-5-20251001");
});

test("an unknown parent link is recorded as unknown, not invented", () => {
  const registry = new ActorRegistry();
  const orphan = registry.detect(
    request({ metadata: { session_id: "s1", actor_id: "sub-x", actor_type: "subagent" } }),
  );
  assert.equal(orphan.parentActorKey, null);
  assert.equal(registry.parentOf(orphan), null);
});

test("sessions namespace identities, so the same actor id does not leak across them", () => {
  const registry = new ActorRegistry();
  const one = registry.detect(request({ metadata: { session_id: "s1", actor_id: "a", actor_type: "main" } }));
  const two = registry.detect(request({ metadata: { session_id: "s2", actor_id: "a", actor_type: "main" } }));
  assert.equal(one.actorKey, two.actorKey);
  assert.notEqual(one.actor, two.actor);
  assert.notEqual(one.session, two.session);
});

test("without correlation, the first inference root establishes main and its follow-ups match it", () => {
  const registry = new ActorRegistry();
  const first = registry.detect(request({ root: "main task" }));
  assert.equal(first.actorType, "main");
  assert.equal(first.confidence, "medium");
  assert.match(first.actorKey, /^local:/);

  const continuation = registry.detect(request({ root: "main task", shape: "continuation" }));
  assert.equal(continuation.actorType, "main");
  assert.equal(continuation.actorKey, first.actorKey);
  assert.equal(continuation.isFresh, false);
  assert.equal(continuation.actor.continuationCount, 1);

  const nextTurn = registry.detect(request({ root: "main task" }));
  assert.equal(nextTurn.actorKey, first.actorKey);
  assert.equal(nextTurn.isFresh, true);
});

test("without correlation, a second root is unknown rather than claimed as a new actor", () => {
  const registry = new ActorRegistry();
  const main = registry.detect(request({ root: "main task" }));
  const other = registry.detect(request({ root: "some subagent task" }));
  assert.equal(other.actorType, "unknown");
  assert.equal(other.actorKey, null);
  assert.equal(other.confidence, "low");
  assert.deepEqual(other.evidence, [
    "no explicit actor correlation",
    "not the established main transcript",
  ]);
  assert.equal(main.actor.requestCount, 1, "the unknown request must not touch the main actor");
});

test("a fingerprint-less request never adopts the established main actor", () => {
  const registry = new ActorRegistry();
  registry.detect(request({ root: "main task" }));
  const empty = inspectClaudeRequest({ model: "jev-router", tools: TOOLS, messages: [] });
  const detection = registry.detect(empty);
  assert.equal(detection.actorType, "unknown");
});

test("decideOnce pins one route per logical turn and reuses it for continuations", async () => {
  const registry = new ActorRegistry();
  const { actor } = registry.detect(
    request({ metadata: { session_id: "s1", actor_id: "a1", actor_type: "main" } }),
  );
  let calls = 0;
  const factory = async () => {
    calls += 1;
    return { route: route("claude-opus-5"), decision: { reason: "jev" } };
  };

  const first = await registry.decideOnce(actor, "turn-1", factory);
  assert.equal(first.reused, false);
  assert.equal(first.logicalTurnId, "turn-1");
  assert.equal(actor.pinnedRoute.model, "claude-opus-5");

  const again = await registry.decideOnce(actor, "turn-1", factory);
  assert.equal(again.reused, true);
  assert.equal(again.route.model, "claude-opus-5");
  assert.equal(calls, 1);

  const next = await registry.decideOnce(actor, "turn-2", factory);
  assert.equal(next.reused, false);
  assert.equal(calls, 2);
});

test("simultaneous requests for one boundary share a single in-flight decision", async () => {
  const registry = new ActorRegistry();
  const { actor } = registry.detect(
    request({ metadata: { session_id: "s1", actor_id: "a1", actor_type: "main" } }),
  );
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const factory = async () => {
    calls += 1;
    await gate;
    return { route: route("claude-sonnet-5"), decision: { reason: "jev" } };
  };

  const both = Promise.all([
    registry.decideOnce(actor, "turn-1", factory),
    registry.decideOnce(actor, "turn-1", factory),
  ]);
  release();
  const [a, b] = await both;
  assert.equal(calls, 1);
  assert.equal(a.route.model, "claude-sonnet-5");
  assert.deepEqual(a.route, b.route);
});

test("unrelated actors are not serialised behind each other", async () => {
  const registry = new ActorRegistry();
  const main = registry.detect(
    request({ metadata: { session_id: "s1", actor_id: "main", actor_type: "main" } }),
  ).actor;
  const sub = registry.detect(
    request({
      metadata: { session_id: "s1", actor_id: "sub", actor_type: "subagent", parent_actor_id: "main" },
      root: "sub task",
    }),
  ).actor;

  let blocked = true;
  const slow = registry.decideOnce(main, "turn-main", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    blocked = false;
    return { route: route("claude-opus-5"), decision: null };
  });
  const fast = await registry.decideOnce(sub, "turn-sub", async () => ({
    route: route("claude-haiku-4-5-20251001"),
    decision: null,
  }));
  assert.equal(blocked, true, "the subagent decision waited on the main decision");
  assert.equal(fast.route.model, "claude-haiku-4-5-20251001");
  await slow;
  assert.equal(main.pinnedRoute.model, "claude-opus-5");
  assert.equal(sub.pinnedRoute.model, "claude-haiku-4-5-20251001");
});

test("a failed decision releases the in-flight slot and leaves the pin untouched", async () => {
  const registry = new ActorRegistry();
  const { actor } = registry.detect(
    request({ metadata: { session_id: "s1", actor_id: "a1", actor_type: "main" } }),
  );
  await assert.rejects(
    registry.decideOnce(actor, "turn-1", async () => {
      throw new Error("provider exploded");
    }),
    /provider exploded/,
  );
  assert.equal(actor.pinnedRoute, null);
  const retry = await registry.decideOnce(actor, "turn-1", async () => ({
    route: route("claude-sonnet-5"),
    decision: null,
  }));
  assert.equal(retry.reused, false);
  assert.equal(actor.pinnedRoute.model, "claude-sonnet-5");
});

test("with no turn id on the wire, a repeated opening reuses the pin instead of re-deciding", async () => {
  // Claude Code sends the opening request of a turn twice, about a second apart: once as
  // [user, system] and again as a fuller single user message. Verified live against 2.1.278
  // on 2026-09-22. Both classify as fresh, so minting a local turn id per call bought two
  // routing decisions for one user turn and let the model change between them.
  const registry = new ActorRegistry();
  const { actor } = registry.detect(request({ root: "main task" }));
  let calls = 0;
  const factory = async () => {
    calls += 1;
    return { route: route("claude-sonnet-5"), decision: null };
  };

  const first = await registry.decideOnce(actor, null, factory);
  const resend = await registry.decideOnce(actor, null, factory);

  assert.match(first.logicalTurnId, /^local-turn:/);
  assert.equal(first.reused, false);
  assert.equal(resend.reused, true, "the second opening is the same turn");
  assert.equal(resend.logicalTurnId, first.logicalTurnId);
  assert.equal(calls, 1, "one user turn buys exactly one routing decision");
});

test("a continuation proves the turn started, so the next opening is a real new turn", async () => {
  const registry = new ActorRegistry();
  const { actor } = registry.detect(request({ root: "main task" }));
  let calls = 0;
  const factory = async () => {
    calls += 1;
    return { route: route("claude-sonnet-5"), decision: null };
  };

  const first = await registry.decideOnce(actor, null, factory);
  // The turn is genuinely under way: Claude called a tool and came back.
  registry.detect(request({ root: "main task", shape: "continuation" }));
  const nextTurn = await registry.decideOnce(actor, null, factory);

  assert.equal(nextTurn.reused, false, "routing resumes at the next genuine boundary");
  assert.notEqual(nextTurn.logicalTurnId, first.logicalTurnId);
  assert.equal(calls, 2);
});

test("the resend window is bounded, so a later turn is never absorbed by an old pin", async () => {
  const registry = new ActorRegistry();
  const { actor } = registry.detect(request({ root: "main task" }));
  let calls = 0;
  const factory = async () => {
    calls += 1;
    return { route: route("claude-sonnet-5"), decision: null };
  };

  await registry.decideOnce(actor, null, factory);
  // A turn that used no tools leaves no continuation behind, so only the clock separates the
  // resend from a genuine next turn.
  actor.lastDecisionAt -= RESEND_WINDOW_MS + 1;
  const later = await registry.decideOnce(actor, null, factory);

  assert.equal(later.reused, false);
  assert.equal(calls, 2);
});

test("an explicit wire turn id is still authoritative and unaffected by the resend window", async () => {
  const registry = new ActorRegistry();
  const { actor } = registry.detect(
    request({ metadata: { session_id: "s1", actor_id: "a1", actor_type: "main" } }),
  );
  let calls = 0;
  const factory = async () => {
    calls += 1;
    return { route: route("claude-sonnet-5"), decision: null };
  };

  await registry.decideOnce(actor, "turn-1", factory);
  const sameTurn = await registry.decideOnce(actor, "turn-1", factory);
  const nextTurn = await registry.decideOnce(actor, "turn-2", factory);

  assert.equal(sameTurn.reused, true);
  assert.equal(nextTurn.reused, false, "a declared new turn decides immediately, clock or not");
  assert.equal(calls, 2);
});

test("snapshot exposes session and actor state without leaking the live objects", () => {
  const registry = new ActorRegistry();
  const { actor } = registry.detect(
    request({ metadata: { session_id: "s1", actor_id: "a1", actor_type: "main" } }),
  );
  actor.pinnedRoute = route("claude-opus-5");
  const [session] = registry.snapshot();
  assert.equal(session.sessionId, "s1");
  assert.equal(session.mainActorKey, "wire:a1");
  assert.equal(session.actors[0].pinnedRoute.model, "claude-opus-5");
  session.actors[0].pinnedRoute = null;
  assert.equal(actor.pinnedRoute.model, "claude-opus-5");
});

test("idle actors are pruned by age while an active pin survives a burst of others", async () => {
  const registry = new ActorRegistry({ idleTtlMs: 30 });
  const main = registry.detect(
    request({ metadata: { session_id: "s1", actor_id: "main", actor_type: "main" } }),
  ).actor;
  main.pinnedRoute = route("claude-opus-5");

  for (let index = 0; index < 100; index += 1) {
    registry.detect(
      request({
        metadata: { session_id: "s1", actor_id: `sub-${index}`, actor_type: "subagent", parent_actor_id: "main" },
        root: `task ${index}`,
      }),
    );
  }
  const [busy] = registry.snapshot();
  assert.equal(busy.actors.length, 101, "no global count evicts the main agent's pin");
  assert.equal(
    registry.detect(request({ metadata: { session_id: "s1", actor_id: "main", actor_type: "main" } })).actor
      .pinnedRoute.model,
    "claude-opus-5",
  );

  await new Promise((resolve) => setTimeout(resolve, 40));
  const fresh = registry.detect(
    request({ metadata: { session_id: "s2", actor_id: "later", actor_type: "main" } }),
  );
  assert.equal(fresh.actorType, "main");
  const sessions = registry.snapshot();
  assert.deepEqual(
    sessions.map(({ sessionId }) => sessionId),
    ["s2"],
    "an entirely idle session is dropped",
  );
});

test("pruning never removes an actor with a decision in flight", async () => {
  const registry = new ActorRegistry({ idleTtlMs: 10 });
  const { actor } = registry.detect(
    request({ metadata: { session_id: "s1", actor_id: "a1", actor_type: "main" } }),
  );
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const pending = registry.decideOnce(actor, "turn-1", async () => {
    await gate;
    return { route: route("claude-opus-5"), decision: null };
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(registry.prune(), 0);
  release();
  await pending;
  assert.equal(registry.snapshot()[0].actors.length, 1);
});

const BILLING = (subagent) => [
  {
    type: "text",
    text:
      `x-anthropic-billing-header: cc_version=2.1.278.${subagent ? "d48" : "fdc"}; ` +
      `cc_entrypoint=claude-vscode; ${subagent ? "cc_is_subagent=true; " : ""}You are a Claude agent.`,
  },
];

const declared = ({ root, subagent, shape = "fresh" }) => {
  const messages = [{ role: "user", content: root }];
  if (shape === "continuation") {
    messages.push(
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    );
  }
  return inspectClaudeRequest({
    model: "jev-router",
    tools: TOOLS,
    system: BILLING(subagent),
    metadata: { user_id: JSON.stringify({ session_id: "s-live" }) },
    messages,
  });
};

test("a client-declared subagent becomes its own actor without an actor id", () => {
  // Real Claude Code declares the type but supplies no identity, so the task fingerprint has
  // to serve as the key. Captured from 2.1.278 on 2026-09-22.
  const registry = new ActorRegistry();
  const main = registry.detect(declared({ root: "refactor the router", subagent: false }));
  const sub = registry.detect(declared({ root: "explore the test directory", subagent: true }));

  assert.equal(main.actorType, "main");
  assert.equal(sub.actorType, "subagent");
  assert.notEqual(sub.actorKey, main.actorKey);
  assert.equal(sub.parentActorKey, main.actorKey, "the subagent hangs off the session's main actor");
  assert.equal(sub.isFresh, true, "a declared subagent root is a routing boundary");
});

test("a subagent can never reach the main agent's pin, whatever its task text says", () => {
  // This is the hazard that made splitting uncorrelated roots by prompt text unsafe. A
  // declared subagent can only ever create or match a subagent actor, so the hazard is gone:
  // even a subagent whose task text is identical to the main transcript root stays separate.
  const registry = new ActorRegistry();
  const main = registry.detect(declared({ root: "refactor the router", subagent: false }));
  main.actor.pinnedRoute = route("claude-opus-5");

  const impostor = registry.detect(declared({ root: "refactor the router", subagent: true }));

  assert.equal(impostor.actorType, "subagent");
  assert.notEqual(impostor.actorKey, main.actorKey);
  assert.equal(main.actor.pinnedRoute.model, "claude-opus-5", "the main pin is untouched");
  assert.equal(impostor.actor.pinnedRoute, null);
});

test("concurrent subagents with different tasks route independently", () => {
  const registry = new ActorRegistry();
  registry.detect(declared({ root: "main task", subagent: false }));
  const a = registry.detect(declared({ root: "explore the test directory", subagent: true }));
  const b = registry.detect(declared({ root: "summarise the changelog", subagent: true }));

  assert.notEqual(a.actorKey, b.actorKey);
  a.actor.pinnedRoute = route("claude-haiku-4-5-20251001");
  b.actor.pinnedRoute = route("claude-opus-5");
  assert.equal(a.actor.pinnedRoute.model, "claude-haiku-4-5-20251001");
  assert.equal(b.actor.pinnedRoute.model, "claude-opus-5");
});

test("two subagents running the identical task share one route rather than colliding", () => {
  // Without an id there is nothing to tell them apart, and the same task deserves the same
  // model, so sharing is the correct answer here rather than a lost pin.
  const registry = new ActorRegistry();
  registry.detect(declared({ root: "main task", subagent: false }));
  const first = registry.detect(declared({ root: "identical task", subagent: true }));
  const second = registry.detect(declared({ root: "identical task", subagent: true }));

  assert.equal(first.actorKey, second.actorKey);
  assert.equal(second.actor.requestCount, 2);
});

test("a subagent continuation is not a routing boundary", () => {
  const registry = new ActorRegistry();
  registry.detect(declared({ root: "main task", subagent: false }));
  registry.detect(declared({ root: "explore the tests", subagent: true }));
  const continued = registry.detect(declared({ root: "explore the tests", subagent: true, shape: "continuation" }));

  assert.equal(continued.actorType, "subagent");
  assert.equal(continued.isFresh, false);
  assert.equal(continued.actor.continuationCount, 1);
});

test("losing the billing header returns subagents to the previous behaviour, not to a broken one", () => {
  // The header is an internal field and may disappear. If it does, a subagent request simply
  // stops being recognised as its own root; nothing throws and nothing is misattributed.
  const registry = new ActorRegistry();
  registry.detect(declared({ root: "main task", subagent: false }));
  const undeclared = registry.detect(request({ root: "explore the tests" }));

  assert.notEqual(undeclared.actorType, "subagent");
  assert.ok(["main", "unknown"].includes(undeclared.actorType));
});

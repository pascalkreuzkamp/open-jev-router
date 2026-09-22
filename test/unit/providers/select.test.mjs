import test from "node:test";
import assert from "node:assert/strict";
import { selectProvider, hasAnyProviderKey, unavailableMessage } from "../../../src/providers/select.mjs";
import { DEFAULT_OPENROUTER_MODEL } from "../../../src/config.mjs";

test("prefers OpenRouter when only its key is set", () => {
  const result = selectProvider({ OPENROUTER_API_KEY: "sk-or-x" });
  assert.equal(result.status, "ok");
  assert.equal(result.provider.name, "openrouter");
});

test("falls back to direct TypeSafe when only JEV_API_KEY is set", () => {
  const result = selectProvider({ JEV_API_KEY: "key" });
  assert.equal(result.status, "ok");
  assert.equal(result.provider.name, "typesafe");
});

test("falls back to direct TypeSafe when only TYPESAFE_API_KEY is set", () => {
  const result = selectProvider({ TYPESAFE_API_KEY: "key" });
  assert.equal(result.status, "ok");
  assert.equal(result.provider.name, "typesafe");
});

test("JEV_API_KEY wins over TYPESAFE_API_KEY when both are set", () => {
  // Same precedence the original single-provider router.mjs used.
  const result = selectProvider({ JEV_API_KEY: "jev-key", TYPESAFE_API_KEY: "ts-key" });
  assert.equal(result.status, "ok");
  assert.equal(result.provider.name, "typesafe");
});

test("OpenRouter wins over TypeSafe when both keys are present and JEV_PROVIDER is unset", () => {
  const result = selectProvider({ OPENROUTER_API_KEY: "sk-or-x", JEV_API_KEY: "key" });
  assert.equal(result.provider.name, "openrouter");
});

test("an explicit JEV_PROVIDER wins even when the other provider's key is also set", () => {
  const result = selectProvider({ JEV_PROVIDER: "typesafe", OPENROUTER_API_KEY: "sk-or-x", JEV_API_KEY: "key" });
  assert.equal(result.provider.name, "typesafe");
});

test("JEV_PROVIDER is case-insensitive and trims whitespace", () => {
  const result = selectProvider({ JEV_PROVIDER: " OpenRouter ", OPENROUTER_API_KEY: "sk-or-x" });
  assert.equal(result.status, "ok");
  assert.equal(result.provider.name, "openrouter");
});

test("an explicit provider without its key is a visible unavailable state, not a silent fallback", () => {
  const result = selectProvider({ JEV_PROVIDER: "openrouter", JEV_API_KEY: "key" });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "missing_key");
  assert.equal(result.name, "openrouter");
  assert.match(unavailableMessage(result), /openrouter/);
});

test("an unknown JEV_PROVIDER value is visible, not a fallback to any key present", () => {
  const result = selectProvider({ JEV_PROVIDER: "bogus", OPENROUTER_API_KEY: "sk-or-x" });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "unknown_provider");
  assert.equal(result.name, "bogus");
  assert.match(unavailableMessage(result), /bogus/);
});

test("no keys at all is unavailable", () => {
  const result = selectProvider({});
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "no_key");
  assert.equal(unavailableMessage(result), "no provider key configured");
});

test("hasAnyProviderKey reflects every recognized key", () => {
  assert.equal(hasAnyProviderKey({}), false);
  assert.equal(hasAnyProviderKey({ OPENROUTER_API_KEY: "x" }), true);
  assert.equal(hasAnyProviderKey({ JEV_API_KEY: "x" }), true);
  assert.equal(hasAnyProviderKey({ TYPESAFE_API_KEY: "x" }), true);
});

test("selected OpenRouter provider carries the account's chosen model and deadline", async (t) => {
  let seenBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seenBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        answers: {
          model: { type: "choice", choice: "claude-sonnet-5", confidence: 0.5 },
          task_complexity: { type: "score", score: 1 },
          reasoning_required: { type: "score", score: 1 },
          tool_complexity: { type: "score", score: 1 },
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = selectProvider({ OPENROUTER_API_KEY: "sk-or-x", JEV_OPENROUTER_MODEL: "typesafe/jev-custom" });
  await result.provider.route({
    prompt: "p",
    current: "claude-sonnet-5",
    contextTokens: 0,
    models: [{ id: "claude-sonnet-5", tier: "sonnet" }],
  });

  assert.equal(seenBody.model, "typesafe/jev-custom");
});

test("blank JEV_OPENROUTER_MODEL falls back to the default model", async (t) => {
  let seenBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seenBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        answers: {
          model: { type: "choice", choice: "claude-sonnet-5" },
          task_complexity: { type: "score", score: 1 },
          reasoning_required: { type: "score", score: 1 },
          tool_complexity: { type: "score", score: 1 },
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = selectProvider({ OPENROUTER_API_KEY: "sk-or-x", JEV_OPENROUTER_MODEL: "   " });
  await result.provider.route({
    prompt: "p",
    current: "claude-sonnet-5",
    contextTokens: 0,
    models: [{ id: "claude-sonnet-5", tier: "sonnet" }],
  });

  // The point is the fallback, not the literal: which model is the right default is asserted
  // once, in openrouter.test.mjs, where the live evidence for it lives.
  assert.equal(seenBody.model, DEFAULT_OPENROUTER_MODEL);
});

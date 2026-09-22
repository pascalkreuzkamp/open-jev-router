import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boolEnv } from "../src/env.mjs";
import { redact, redactText, omitContent, REDACTED } from "../src/sanitize.mjs";
import { dumpRequest } from "../src/dump.mjs";
import { buildDecision } from "../src/decision.mjs";
import { log } from "../src/log.mjs";

test("boolEnv parses only 1/true as on, including an explicit 0", () => {
  assert.equal(boolEnv("X", {}), false, "unset is off");
  assert.equal(boolEnv("X", { X: "1" }), true);
  assert.equal(boolEnv("X", { X: "true" }), true);
  assert.equal(boolEnv("X", { X: "TRUE" }), true);
  assert.equal(boolEnv("X", { X: "0" }), false, "explicit 0 must be off, unlike Boolean(str)");
  assert.equal(boolEnv("X", { X: "false" }), false);
  assert.equal(boolEnv("X", { X: "" }), false);
  assert.equal(boolEnv("X", { X: "yes" }), false, "only 1/true are recognised");
});

test("redact strips secret-shaped keys case-insensitively, nested and in arrays", () => {
  const input = {
    Authorization: "Bearer abc123",
    "X-Api-Key": "sk-live-xyz",
    headers: { Cookie: "session=1", "set-cookie": "a=b" },
    nested: [{ token: "t1", note: "kept" }],
    provider_error: { proxy_authorization: "hidden", message: "kept" },
  };
  const out = redact(input);
  assert.equal(out.Authorization, REDACTED);
  assert.equal(out["X-Api-Key"], REDACTED);
  assert.equal(out.headers.Cookie, REDACTED);
  assert.equal(out.headers["set-cookie"], REDACTED);
  assert.equal(out.nested[0].token, REDACTED);
  assert.equal(out.nested[0].note, "kept");
  assert.equal(out.provider_error.proxy_authorization, REDACTED);
  assert.equal(out.provider_error.message, "kept");
});

test("redact leaves non-secret data and primitives untouched", () => {
  assert.equal(redact(null), null);
  assert.equal(redact("plain string"), "plain string");
  assert.deepEqual(redact({ model: "claude-opus-5", tier: "opus" }), { model: "claude-opus-5", tier: "opus" });
});

test("redactText scrubs secret-shaped tokens embedded in free text", () => {
  const text = "failed with key sk-live-abcdefghijklmnop and Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6";
  const out = redactText(text);
  assert.doesNotMatch(out, /sk-live-abcdefghijklmnop/);
  assert.doesNotMatch(out, /eyJhbGciOiJIUzI1NiIsInR5cCI6/);
  assert.match(out, new RegExp(REDACTED.replace(/[[\]]/g, "\\$&")));
});

test("redactText passes short, ordinary text through unchanged", () => {
  assert.equal(redactText("fix the failing test"), "fix the failing test");
});

test("omitContent replaces message/system/instructions text with a length placeholder", () => {
  const body = {
    model: "claude-opus-5",
    system: "you are a careful engineer",
    messages: [{ role: "user", content: "debug this race condition in the scheduler" }],
  };
  const out = omitContent(body);
  assert.equal(out.model, "claude-opus-5");
  assert.match(out.system, /^\[content omitted; \d+ chars\]$/);
  assert.match(out.messages[0].content, /^\[content omitted; \d+ chars\]$/);
});

test("omitContent reaches text blocks nested inside array content and preserves structure", () => {
  const body = {
    input: [{ role: "user", content: [{ type: "input_text", text: "rename this variable" }] }],
  };
  const out = omitContent(body);
  assert.equal(out.input[0].role, "user");
  assert.equal(out.input[0].content[0].type, "input_text");
  assert.match(out.input[0].content[0].text, /^\[content omitted; \d+ chars\]$/);
});

function tempDumpRoot() {
  return mkdtempSync(join(tmpdir(), "jev-dump-test-"));
}

function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("dumpRequest is a no-op unless JEV_DUMP is explicitly on", () => {
  const root = tempDumpRoot();
  withEnv({ JEV_DUMP: undefined }, () => dumpRequest("s1", { model: "x" }, { root }));
  withEnv({ JEV_DUMP: "0" }, () => dumpRequest("s1", { model: "x" }, { root }));
  assert.equal(existsSync(root) && readdirSync(root).length > 0, false);
});

test("JEV_DUMP=1 writes a redacted, content-omitted dump under session/private permissions", { skip: process.platform === "win32" }, () => {
  const root = tempDumpRoot();
  withEnv({ JEV_DUMP: "1" }, () =>
    dumpRequest(
      "abc-123",
      { model: "claude-opus-5", messages: [{ role: "user", content: "the real prompt text" }] },
      { root },
    ),
  );
  const sessionDir = join(root, "abc-123");
  assert.equal(statSync(sessionDir).mode & 0o777, 0o700);
  const [file] = readdirSync(sessionDir);
  assert.ok(file, "a dump file was written");
  assert.equal(statSync(join(sessionDir, file)).mode & 0o777, 0o600);
  const dumped = JSON.parse(readFileSync(join(sessionDir, file), "utf8"));
  assert.equal(dumped.model, "claude-opus-5");
  assert.doesNotMatch(JSON.stringify(dumped), /the real prompt text/);
});

test("JEV_DUMP_CONTENT=1 includes message content, still redacted for secrets", () => {
  const root = tempDumpRoot();
  withEnv({ JEV_DUMP: "1", JEV_DUMP_CONTENT: "1" }, () =>
    dumpRequest(
      "abc-content",
      {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "the real prompt text" }],
        metadata: { authorization: "Bearer secret-token" },
      },
      { root },
    ),
  );
  const sessionDir = join(root, "abc-content");
  const [file] = readdirSync(sessionDir);
  const dumped = JSON.parse(readFileSync(join(sessionDir, file), "utf8"));
  assert.equal(dumped.messages[0].content, "the real prompt text");
  assert.equal(dumped.metadata.authorization, REDACTED);
});

test("dumpRequest never throws even when the directory cannot be created", () => {
  assert.doesNotThrow(() =>
    withEnv({ JEV_DUMP: "1" }, () => dumpRequest("s", { a: 1 }, { root: "\0invalid" })),
  );
});

test("dumpRequest falls back to an 'unknown' bucket for an empty session id", { skip: process.platform === "win32" }, () => {
  const root = tempDumpRoot();
  withEnv({ JEV_DUMP: "1" }, () => dumpRequest("", { a: 1 }, { root }));
  assert.ok(existsSync(join(root, "unknown")));
});

test("buildDecision stores only a prompt hash by default, never the raw Jev exchange", () => {
  withEnv({ JEV_STORE_PROMPTS: undefined, JEV_STORE_PROMPT_PREVIEW: undefined }, () => {
    const decision = buildDecision({
      tier: "sonnet",
      model: "claude-sonnet-5",
      reason: "jev",
      prompt: "debug this race condition, here is my key sk-live-abcdefghijklmnop",
      jev: { confidence: 0.9, metrics: { taskComplexity: 0.5 }, request: { secret: "x" }, response: { secret: "y" } },
      recommendedTier: "sonnet",
      currentModel: "claude-haiku-4-5-20251001",
      contextTokens: 1200,
    });
    assert.equal(decision.prompt, undefined);
    assert.equal(decision.promptPreview, undefined);
    assert.equal(decision.jev, undefined);
    assert.equal(decision.request, undefined);
    assert.equal(decision.response, undefined);
    assert.match(decision.promptHash, /^[0-9a-f]{64}$/);
    assert.equal(decision.confidence, 0.9);
    assert.equal(decision.recommendedTier, "sonnet");
    assert.equal(decision.currentModel, "claude-haiku-4-5-20251001");
    assert.equal(decision.contextTokens, 1200);
  });
});

test("JEV_STORE_PROMPTS=1 stores the exact prompt", () => {
  withEnv({ JEV_STORE_PROMPTS: "1" }, () => {
    const decision = buildDecision({ tier: "sonnet", model: "m", reason: "jev", prompt: "fix the bug" });
    assert.equal(decision.prompt, "fix the bug");
    assert.equal(decision.promptPreview, undefined);
  });
});

test("JEV_STORE_PROMPT_PREVIEW=1 stores a truncated, secret-scrubbed preview instead of the full prompt", () => {
  withEnv({ JEV_STORE_PROMPTS: undefined, JEV_STORE_PROMPT_PREVIEW: "1" }, () => {
    const longPrompt =
      "explain the routing architecture in detail, walk through every module and its tests, " +
      "here is my key sk-live-abcdefghijklmnop";
    const decision = buildDecision({ tier: "sonnet", model: "m", reason: "jev", prompt: longPrompt });
    assert.equal(decision.prompt, undefined);
    assert.ok(decision.promptPreview.length <= 81, "preview is truncated");
    assert.doesNotMatch(decision.promptPreview, /sk-live-abcdefghijklmnop/);
  });
});

test("the interactive debug log file is private to its owner", { skip: process.platform === "win32" }, () => {
  const root = tempDumpRoot();
  const file = join(root, "jev-claude.log");
  const wasTTY = process.stdout.isTTY;
  process.stdout.isTTY = true;
  try {
    log("a debug line", file);
  } finally {
    process.stdout.isTTY = wasTTY;
  }
  assert.ok(existsSync(file));
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("an explicit 0 for JEV_STORE_PROMPTS is treated as off", () => {
  withEnv({ JEV_STORE_PROMPTS: "0" }, () => {
    const decision = buildDecision({ tier: "sonnet", model: "m", reason: "jev", prompt: "fix the bug" });
    assert.equal(decision.prompt, undefined);
  });
});

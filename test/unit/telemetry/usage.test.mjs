import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { createUsageObserver, mergeUsage } from "../../../src/telemetry/usage.mjs";

const SSE = { contentType: "text/event-stream" };

const event = (type, payload) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

const CANONICAL_STREAM =
  event("message_start", {
    message: {
      id: "msg_1",
      model: "claude-opus-5",
      usage: {
        input_tokens: 1200,
        output_tokens: 1,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 64,
      },
    },
  }) +
  event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
  event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hello " } }) +
  event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "world" } }) +
  event("content_block_stop", { index: 0 }) +
  event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }) +
  event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 57 } }) +
  event("message_stop", {});

async function observe(text, options = SSE, { chunkSize = null } = {}) {
  const observer = createUsageObserver(options);
  const buffer = Buffer.from(text, "utf8");
  if (chunkSize) {
    for (let at = 0; at < buffer.length; at += chunkSize) {
      observer.write(buffer.subarray(at, at + chunkSize));
    }
  } else {
    observer.write(buffer);
  }
  return observer.end();
}

test("mergeUsage keeps the largest reported value and never sums cumulative counters", () => {
  const usage = { inputTokens: null, outputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null };
  assert.equal(mergeUsage(usage, { input_tokens: 10, output_tokens: 1 }), true);
  assert.equal(mergeUsage(usage, { output_tokens: 20 }), true);
  assert.equal(mergeUsage(usage, { output_tokens: 57 }), true);
  // A restated smaller value is a duplicate of an earlier event, not a new count.
  assert.equal(mergeUsage(usage, { output_tokens: 20 }), false);
  assert.equal(usage.outputTokens, 57);
  assert.equal(usage.inputTokens, 10);
});

test("mergeUsage ignores non-numeric, negative, and absent fields", () => {
  const usage = { inputTokens: null, outputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null };
  assert.equal(mergeUsage(usage, null), false);
  assert.equal(mergeUsage(usage, "nope"), false);
  assert.equal(mergeUsage(usage, { input_tokens: "12" }), false);
  assert.equal(mergeUsage(usage, { input_tokens: -1 }), false);
  assert.equal(mergeUsage(usage, { input_tokens: Number.NaN }), false);
  assert.equal(usage.inputTokens, null, "an unreported field stays unknown, not zero");
});

test("a canonical stream yields the final cumulative totals exactly once", async () => {
  const result = await observe(CANONICAL_STREAM);
  assert.equal(result.inputTokens, 1200);
  assert.equal(result.outputTokens, 57, "two deltas of 20 and 57 are one running total, not 77");
  assert.equal(result.cacheReadInputTokens, 800);
  assert.equal(result.cacheCreationInputTokens, 64);
  assert.equal(result.streaming, true);
  assert.equal(result.complete, true);
  assert.deepEqual(result.notes, []);
});

test("the totals are identical at every chunk boundary, down to one byte at a time", async () => {
  const whole = await observe(CANONICAL_STREAM);
  for (const chunkSize of [1, 2, 3, 7, 13, 64, 512]) {
    const split = await observe(CANONICAL_STREAM, SSE, { chunkSize });
    assert.deepEqual(
      { ...split, bytes: null },
      { ...whole, bytes: null },
      `chunk size ${chunkSize} produced different usage`,
    );
  }
});

test("a multi-byte character split across chunks does not corrupt parsing", async () => {
  const stream =
    event("message_start", { message: { usage: { input_tokens: 5, output_tokens: 1 } } }) +
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "héllo 🌍 世界" } }) +
    event("message_delta", { delta: {}, usage: { output_tokens: 9 } }) +
    event("message_stop", {});
  const result = await observe(stream, SSE, { chunkSize: 1 });
  assert.equal(result.inputTokens, 5);
  assert.equal(result.outputTokens, 9);
  assert.equal(result.complete, true);
});

test("a repeated identical usage event does not inflate the totals", async () => {
  const repeated =
    event("message_start", { message: { usage: { input_tokens: 100, output_tokens: 1 } } }) +
    event("message_delta", { delta: {}, usage: { output_tokens: 42 } }) +
    event("message_delta", { delta: {}, usage: { output_tokens: 42 } }) +
    event("message_delta", { delta: {}, usage: { output_tokens: 42 } }) +
    event("message_stop", {});
  const result = await observe(repeated);
  assert.equal(result.outputTokens, 42);
  assert.equal(result.inputTokens, 100);
});

test("a malformed event is noted and the surrounding usage still lands", async () => {
  const stream =
    event("message_start", { message: { usage: { input_tokens: 7, output_tokens: 1 } } }) +
    'event: message_delta\ndata: {"usage": {"output_tokens": NOT JSON\n\n' +
    event("message_delta", { delta: {}, usage: { output_tokens: 11 } }) +
    event("message_stop", {});
  const result = await observe(stream);
  assert.equal(result.inputTokens, 7);
  assert.equal(result.outputTokens, 11);
  assert.deepEqual(result.notes, ["malformed event"]);
  assert.equal(result.complete, true);
});

test("a stream that ends early reports partial usage marked incomplete", async () => {
  const cut = CANONICAL_STREAM.slice(0, CANONICAL_STREAM.indexOf("message_stop"));
  const result = await observe(cut);
  assert.equal(result.inputTokens, 1200);
  assert.equal(result.outputTokens, 57);
  assert.equal(result.complete, false, "no message_stop means the numbers may not be final");
  assert.equal(result.sawUsage, true);
});

test("a stream with no usage at all reports unknown rather than zero", async () => {
  const result = await observe(
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }),
  );
  assert.equal(result.inputTokens, null);
  assert.equal(result.outputTokens, null);
  assert.equal(result.sawUsage, false);
  assert.equal(result.complete, false);
});

test("a non-streaming JSON response is read from the whole body", async () => {
  const body = JSON.stringify({
    id: "msg_1",
    type: "message",
    model: "claude-sonnet-5",
    usage: {
      input_tokens: 30,
      output_tokens: 12,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
  const result = await observe(body, { contentType: "application/json" }, { chunkSize: 5 });
  assert.equal(result.streaming, false);
  assert.equal(result.inputTokens, 30);
  assert.equal(result.outputTokens, 12);
  assert.equal(result.cacheReadInputTokens, 0, "a reported zero is a real zero");
  assert.equal(result.complete, true);
});

test("a non-JSON body is noted without throwing", async () => {
  const result = await observe("upstream returned plain text", { contentType: "text/plain" });
  assert.equal(result.sawUsage, false);
  assert.deepEqual(result.notes, ["response body was not usage-bearing JSON"]);
});

test("a gzip-encoded stream is observed through a separate decoded path", async () => {
  const compressed = zlib.gzipSync(Buffer.from(CANONICAL_STREAM, "utf8"));
  const observer = createUsageObserver({ ...SSE, contentEncoding: "gzip" });
  for (let at = 0; at < compressed.length; at += 16) {
    observer.write(compressed.subarray(at, at + 16));
  }
  const result = await observer.end();
  assert.equal(result.inputTokens, 1200);
  assert.equal(result.outputTokens, 57);
  assert.equal(result.complete, true);
  assert.equal(result.bytes, compressed.length, "the observer counts the bytes actually sent");
});

test("brotli and deflate encodings are handled too", async () => {
  for (const [encoding, compress] of [
    ["br", zlib.brotliCompressSync],
    ["deflate", zlib.deflateSync],
  ]) {
    const observer = createUsageObserver({ ...SSE, contentEncoding: encoding });
    observer.write(compress(Buffer.from(CANONICAL_STREAM, "utf8")));
    const result = await observer.end();
    assert.equal(result.outputTokens, 57, `${encoding} did not decode`);
  }
});

test("an unsupported encoding is reported rather than parsed as garbage", async () => {
  const observer = createUsageObserver({ ...SSE, contentEncoding: "exotic-v9" });
  observer.write(Buffer.from(CANONICAL_STREAM, "utf8"));
  const result = await observer.end();
  assert.equal(result.sawUsage, false);
  assert.deepEqual(result.notes, ["unsupported content-encoding exotic-v9"]);
  assert.ok(result.bytes > 0, "byte accounting still works for an unreadable body");
});

test("corrupt compressed bytes are noted, never thrown", async () => {
  const observer = createUsageObserver({ ...SSE, contentEncoding: "gzip" });
  observer.write(Buffer.from("this is not gzip at all", "utf8"));
  const result = await observer.end();
  assert.equal(result.sawUsage, false);
  assert.deepEqual(result.notes, ["could not decompress for usage"]);
});

test("an event line that never terminates is dropped at the cap instead of growing", async () => {
  const observer = createUsageObserver(SSE);
  const chunk = Buffer.from(`data: ${"x".repeat(100_000)}`, "utf8");
  for (let i = 0; i < 12; i += 1) observer.write(chunk);
  const result = await observer.end();
  assert.equal(result.complete, false);
  assert.ok(result.notes.includes("event line exceeded the buffer limit"));
});

test("a [DONE] sentinel and blank lines are tolerated", async () => {
  const stream =
    event("message_start", { message: { usage: { input_tokens: 3, output_tokens: 1 } } }) +
    "\n\n: keep-alive comment\n\n" +
    event("message_stop", {}) +
    "data: [DONE]\n\n";
  const result = await observe(stream);
  assert.equal(result.inputTokens, 3);
  assert.equal(result.complete, true);
});

test("CRLF line endings parse the same as LF", async () => {
  const result = await observe(CANONICAL_STREAM.replace(/\n/g, "\r\n"));
  assert.equal(result.inputTokens, 1200);
  assert.equal(result.outputTokens, 57);
  assert.equal(result.complete, true);
});

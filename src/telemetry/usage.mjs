import { StringDecoder } from "node:string_decoder";
import zlib from "node:zlib";

/**
 * Longest partial line held while waiting for its terminator. A well-formed Anthropic event is
 * far smaller; the cap exists so a response that never sends a newline cannot grow unbounded.
 */
export const MAX_PENDING_BYTES = 1024 * 1024;

/** Non-streaming replies are one JSON object, so they are buffered -- but never unboundedly. */
export const MAX_BUFFERED_JSON_BYTES = 4 * 1024 * 1024;

const USAGE_FIELDS = {
  input_tokens: "inputTokens",
  output_tokens: "outputTokens",
  cache_read_input_tokens: "cacheReadInputTokens",
  cache_creation_input_tokens: "cacheCreationInputTokens",
};

const emptyUsage = () => ({
  inputTokens: null,
  outputTokens: null,
  cacheReadInputTokens: null,
  cacheCreationInputTokens: null,
});

/**
 * Merge one reported usage object into the running totals.
 *
 * Anthropic reports these counters cumulatively: `message_start` carries the input and cache
 * figures with output at 1, and each `message_delta` restates the running output total for the
 * whole message. Summing them would multiply the output count by the number of deltas, so the
 * merge keeps the largest value seen for each field and never adds. A field that never appears
 * stays `null` -- unknown, which is not zero.
 */
export function mergeUsage(into, reported) {
  if (!reported || typeof reported !== "object") return false;
  let changed = false;
  for (const [wire, field] of Object.entries(USAGE_FIELDS)) {
    const value = reported[wire];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    if (into[field] == null || value > into[field]) {
      into[field] = value;
      changed = true;
    }
  }
  return changed;
}

function decompressorFor(encoding) {
  switch ((encoding ?? "").toLowerCase()) {
    case "gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    case "zstd":
      return typeof zlib.createZstdDecompress === "function" ? zlib.createZstdDecompress() : null;
    default:
      return null;
  }
}

/**
 * Observe a Claude response for usage metadata without touching the bytes being forwarded.
 *
 * The caller feeds it the same buffers it writes downstream. Everything here is best-effort:
 * any parse failure marks the result incomplete and is otherwise ignored, because usage
 * numbers are never worth failing a response over.
 */
export function createUsageObserver({ contentType = "", contentEncoding = null } = {}) {
  const usage = emptyUsage();
  const notes = [];
  let events = 0;
  let sawUsage = false;
  let sawMessageStop = false;
  let truncated = false;
  let bytes = 0;

  const streaming = /text\/event-stream/i.test(contentType);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let jsonBuffer = streaming ? null : "";

  function note(reason) {
    if (!notes.includes(reason)) notes.push(reason);
  }

  function consumeLine(line) {
    const trimmed = line.trimEnd();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    events += 1;
    // Most events are content deltas with no usage at all; skip parsing those outright.
    if (!payload.includes('"usage"') && !payload.includes('"message_stop"')) return;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      note("malformed event");
      return;
    }
    if (parsed?.type === "message_stop") sawMessageStop = true;
    const reported = parsed?.usage ?? parsed?.message?.usage;
    if (mergeUsage(usage, reported)) sawUsage = true;
  }

  function consumeText(text) {
    if (jsonBuffer !== null) {
      if (jsonBuffer.length + text.length > MAX_BUFFERED_JSON_BYTES) {
        truncated = true;
        note("response too large to buffer for usage");
        jsonBuffer = null;
        return;
      }
      jsonBuffer += text;
      return;
    }
    pending += text;
    let index = pending.indexOf("\n");
    while (index !== -1) {
      consumeLine(pending.slice(0, index));
      pending = pending.slice(index + 1);
      index = pending.indexOf("\n");
    }
    if (pending.length > MAX_PENDING_BYTES) {
      truncated = true;
      note("event line exceeded the buffer limit");
      pending = "";
    }
  }

  // A compressed body is observed through its own decoder. The forwarded bytes stay exactly as
  // they arrived; only this side path sees plaintext.
  const decompressor = decompressorFor(contentEncoding);
  if (decompressor) {
    decompressor.on("data", (chunk) => consumeText(decoder.write(chunk)));
    decompressor.on("error", () => note("could not decompress for usage"));
  } else if (contentEncoding && contentEncoding !== "identity") {
    note(`unsupported content-encoding ${contentEncoding}`);
  }
  const unreadable = Boolean(contentEncoding && contentEncoding !== "identity" && !decompressor);

  return {
    write(chunk) {
      bytes += chunk.length;
      if (unreadable) return;
      try {
        if (decompressor) decompressor.write(chunk);
        else consumeText(decoder.write(chunk));
      } catch {
        note("usage observation failed");
      }
    },

    /**
     * Finish observing and resolve with the result. Decompression is asynchronous, so this is
     * always a promise: awaiting it is what guarantees the trailing usage event was seen.
     */
    async end() {
      if (unreadable) return this.result();
      try {
        if (decompressor) {
          // A stream cut short leaves the decompressor with a truncated tail; treat that as
          // partial usage rather than an error.
          await new Promise((resolve) => {
            decompressor.on("end", resolve);
            decompressor.on("error", resolve);
            decompressor.on("close", resolve);
            decompressor.end();
          });
        }
        consumeText(decoder.end());
        if (pending) consumeLine(pending);
        pending = "";
        if (jsonBuffer) {
          try {
            const parsed = JSON.parse(jsonBuffer);
            if (mergeUsage(usage, parsed?.usage)) sawUsage = true;
            if (parsed?.type === "message") sawMessageStop = true;
          } catch {
            note("response body was not usage-bearing JSON");
          }
          jsonBuffer = null;
        }
      } catch {
        note("usage observation failed");
      }
      return this.result();
    },

    result() {
      return {
        ...usage,
        streaming,
        bytes,
        events,
        // Complete means: usage was reported and the response reached its documented end. A
        // stream cut short is reported as incomplete rather than as smaller numbers.
        complete: sawUsage && (streaming ? sawMessageStop : true) && !truncated,
        sawUsage,
        notes,
      };
    },
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import {
  barWidth,
  formatCompact,
  formatConfidence,
  formatCount,
  formatDuration,
  formatPercent,
  formatTime,
  formatUsd,
  label,
  nextDelay,
  pageText,
  routeOutcome,
  tokenSegments,
} from "../../../src/dashboard/public/format.js";

test("numbers and missing values format explicitly", () => {
  assert.equal(formatCount(1234567), "1,234,567");
  assert.equal(formatCount(null), "unknown");
  assert.equal(formatCompact(1500), "1.5k");
  assert.equal(formatCompact(2_000_000), "2M");
  assert.equal(formatCompact(undefined), "unknown");
  assert.equal(formatPercent(0.25), "25.0%");
  assert.equal(formatUsd(0.0002), "$0.000200");
  assert.equal(formatUsd(null), "unknown");
  assert.equal(formatConfidence(0.9), "0.90");
  assert.equal(formatConfidence(null), "–");
  assert.equal(formatDuration(65_000), "1m 5s");
  assert.equal(formatTime(0), "1970-01-01 00:00:00Z");
  assert.equal(label(null), "unknown");
  assert.equal(label("", "none"), "none");
});

test("bar widths are bounded and never NaN", () => {
  assert.equal(barWidth(5, 10), "50.00%");
  assert.equal(barWidth(20, 10), "100.00%");
  assert.equal(barWidth(1, 0), "0%");
  assert.equal(barWidth(null, 10), "0%");
  assert.equal(barWidth(-3, 10), "0%");
});

test("token segments skip unknown series and report them", () => {
  const result = tokenSegments({
    inputTokens: 100,
    cacheReadInputTokens: 300,
    cacheCreationInputTokens: null,
    outputTokens: 100,
  });
  assert.equal(result.total, 500);
  assert.deepEqual(result.unknown, ["Cache creation"]);
  assert.deepEqual(result.segments.map((s) => s.share), [0.2, 0.6, 0.2]);
  assert.equal(tokenSegments({}).total, 0);
});

test("route outcome, page text and polling backoff", () => {
  assert.equal(routeOutcome({ requests: 0 }), "unknown");
  assert.equal(routeOutcome({ requests: 3, succeeded: 2, failed: 1 }), "2/3 ok");
  assert.equal(routeOutcome({ requests: 2, succeeded: 2, failed: 0 }), "2 ok");
  assert.equal(pageText({ limit: 50, offset: 50, total: 120 }), "51–100 of 120");
  assert.equal(pageText({ limit: 50, offset: 0, total: 0 }), "0 of 0");
  assert.equal(nextDelay(0), 5_000);
  assert.equal(nextDelay(1), 10_000);
  assert.equal(nextDelay(3), 40_000);
  assert.equal(nextDelay(4), 60_000);
  assert.equal(nextDelay(100), 60_000);
});

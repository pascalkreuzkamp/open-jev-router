// Pure formatting helpers shared by the dashboard page and its Node tests. No DOM access here.

export const TOKEN_SERIES = [
  { key: "inputTokens", label: "Input", className: "series-input" },
  { key: "cacheReadInputTokens", label: "Cache read", className: "series-cache-read" },
  { key: "cacheCreationInputTokens", label: "Cache creation", className: "series-cache-creation" },
  { key: "outputTokens", label: "Output", className: "series-output" },
];

export function formatCount(value) {
  if (value == null || !Number.isFinite(Number(value))) return "unknown";
  return Math.round(Number(value)).toLocaleString("en-US");
}

export function formatCompact(value) {
  if (value == null || !Number.isFinite(Number(value))) return "unknown";
  const n = Number(value);
  const abs = Math.abs(n);
  if (abs < 1_000) return `${Math.round(n)}`;
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatPercent(share) {
  if (share == null || !Number.isFinite(Number(share))) return "–";
  return `${(Number(share) * 100).toFixed(1)}%`;
}

export function formatUsd(value) {
  if (value == null || !Number.isFinite(Number(value))) return "unknown";
  return `$${Number(value).toFixed(6)}`;
}

export function formatMs(value) {
  if (value == null || !Number.isFinite(Number(value))) return "unknown";
  return `${Math.round(Number(value))} ms`;
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return "unknown";
  const seconds = Math.max(0, Math.round(Number(ms) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${rest}s` : `${rest}s`;
}

export function formatTime(timestamp) {
  if (timestamp == null || !Number.isFinite(Number(timestamp))) return "unknown";
  return new Date(Number(timestamp)).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

export function formatConfidence(value) {
  if (value == null || !Number.isFinite(Number(value))) return "–";
  return Number(value).toFixed(2);
}

/** Shows a missing label as an explicit word rather than an empty cell. */
export const label = (value, fallback = "unknown") =>
  value == null || value === "" ? fallback : String(value);

/** Bar width as a CSS percentage relative to the largest value; never NaN, never above 100. */
export function barWidth(value, max) {
  const v = Number(value);
  const m = Number(max);
  if (!Number.isFinite(v) || !Number.isFinite(m) || m <= 0 || v <= 0) return "0%";
  return `${Math.min(100, (v / m) * 100).toFixed(2)}%`;
}

/** Segments of the stacked token bar; unknown series are omitted and reported separately. */
export function tokenSegments(totals) {
  const known = TOKEN_SERIES.filter(({ key }) => totals?.[key] != null);
  const total = known.reduce((n, { key }) => n + Math.max(0, Number(totals[key]) || 0), 0);
  return {
    total,
    unknown: TOKEN_SERIES.filter(({ key }) => totals?.[key] == null).map(({ label: name }) => name),
    segments: known.map((series) => {
      const value = Math.max(0, Number(totals[series.key]) || 0);
      return { ...series, value, share: total ? value / total : 0 };
    }),
  };
}

export function routeOutcome(row) {
  if (!row || !row.requests) return "unknown";
  return row.failed > 0 ? `${row.succeeded}/${row.requests} ok` : `${row.requests} ok`;
}

/** Page description for a paginated table, e.g. "51–100 of 240". */
export function pageText({ limit, offset, total }) {
  if (!total) return "0 of 0";
  const first = Math.min(total, offset + 1);
  const last = Math.min(total, offset + limit);
  return `${first}–${last} of ${total}`;
}

/** Polling delay: the base interval while healthy, doubling per consecutive failure up to a cap. */
export function nextDelay(failures, base = 5_000, cap = 60_000) {
  if (!failures) return base;
  return Math.min(cap, base * 2 ** Math.min(failures, 16));
}

export function actorName(actor) {
  if (!actor) return "unknown";
  return actor.agentName ? `${actor.agentName} (${label(actor.actorType)})` : label(actor.actorType);
}

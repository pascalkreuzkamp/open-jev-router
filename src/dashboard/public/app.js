// Dashboard page. Every node is built with createElement and every stored label is assigned
// through textContent, so telemetry text can never become markup or script.
import {
  TOKEN_SERIES,
  actorName,
  barWidth,
  formatCompact,
  formatConfidence,
  formatCount,
  formatDuration,
  formatMs,
  formatPercent,
  formatTime,
  formatUsd,
  label,
  nextDelay,
  pageText,
  routeOutcome,
  tokenSegments,
} from "./format.js";

const API = "/api/v1";
const ROUTE_PAGE = 50;
const POLL_MS = 5_000;

const state = {
  sessionId: new URLSearchParams(location.search).get("session"),
  routesOffset: 0,
  failures: 0,
  timer: null,
  inflight: false,
  rendered: false,
};

const $ = (id) => document.getElementById(id);

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  if (props.className) el.className = props.className;
  if (props.text != null) el.textContent = String(props.text);
  if (props.id) el.id = props.id;
  if (props.scope) el.scope = props.scope;
  for (const child of children) if (child) el.append(child);
  return el;
}

class HttpError extends Error {
  constructor(status, body) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function getJson(path) {
  const response = await fetch(`${API}/${path}`, { headers: { Accept: "application/json" } });
  let body = null;
  try {
    body = await response.json();
  } catch {}
  if (!response.ok) throw new HttpError(response.status, body);
  return body;
}

function setBanner(text, kind = "warn") {
  const banner = $("banner");
  banner.textContent = text ?? "";
  banner.className = kind === "error" ? "banner error" : "banner";
  banner.hidden = !text;
}

function replaceContent(...nodes) {
  const main = $("content");
  main.replaceChildren(...nodes);
  main.classList.remove("stale");
  main.setAttribute("aria-busy", "false");
}

function stateMessage(title, lines = []) {
  return h("div", { className: "state" }, [
    h("h2", { text: title }),
    ...lines.map((line) => (typeof line === "string" ? h("p", { text: line }) : line)),
  ]);
}

function telemetryOffMessage(status) {
  const hint = h("p");
  hint.append("Telemetry is off by default. Enable it with ");
  hint.append(h("code", { text: "JEV_ENABLE_TELEMETRY=1" }));
  hint.append(" before launching jev-claude, then reload this page.");
  const title = status.database === "missing"
    ? "No telemetry database yet"
    : "The telemetry database cannot be read";
  const detail = status.database === "missing"
    ? `Expected at ${status.path}.`
    : `Found at ${status.path}, but it could not be opened read-only (is the optional better-sqlite3 driver installed?).`;
  return stateMessage(title, [detail, hint]);
}

// ---------- tables and charts ----------

function table(caption, columns, rows) {
  const head = h("tr", {}, columns.map((col) => {
    const th = h("th", { className: col.num ? "num" : "", text: col.title });
    th.scope = "col";
    return th;
  }));
  const body = rows.map((row) => h("tr", {}, columns.map((col) => {
    const cell = h("td", { className: col.num ? "num" : col.bar ? "bar-cell" : "wrap" });
    const value = col.render(row);
    if (value instanceof Node) cell.append(value);
    else cell.textContent = value;
    return cell;
  })));
  return h("table", {}, [h("caption", { text: caption }), h("thead", {}, [head]), h("tbody", {}, body)]);
}

function bar(value, max, text) {
  const fill = h("div", { className: "bar" });
  fill.style.setProperty("width", barWidth(value, max));
  const track = h("div", { className: "bar-track" }, [fill]);
  track.setAttribute("aria-hidden", "true");
  track.title = text;
  return track;
}

function distributionTable(caption, rows, field, name) {
  if (!rows.length) return h("p", { className: "subtle", text: `No fresh routes recorded, so no ${name.toLowerCase()} distribution.` });
  const max = Math.max(...rows.map((row) => row.freshRoutes));
  return table(caption, [
    { title: name, render: (row) => label(row[field], field === "effort" ? "default / none" : "unknown") },
    { title: "Fresh routes", num: true, render: (row) => formatCount(row.freshRoutes) },
    { title: "Share", num: true, render: (row) => formatPercent(row.share) },
    { title: "Chart", bar: true, render: (row) => bar(row.freshRoutes, max, formatPercent(row.share)) },
  ], rows);
}

function card(title, ...children) {
  return h("section", { className: "card" }, [h("h2", { text: title }), ...children]);
}

function kpi(title, value, note) {
  return h("div", { className: "kpi" }, [
    h("dt", { text: title }),
    h("dd", {}, [document.createTextNode(value), note ? h("span", { className: "note", text: note }) : null]),
  ]);
}

// ---------- sections ----------

function summarySection(summary) {
  const fresh = summary.routes.reduce((n, row) => n + row.freshRoutes, 0);
  const meta = h("p", {
    className: "meta",
    text: `${label(summary.scope.projectPath)} · started ${formatTime(summary.period.startedAt)} · ${formatDuration(summary.period.durationMs)}`,
  });
  const kpis = h("dl", { className: "kpis" }, [
    kpi("Fresh routes", formatCount(fresh), "decisions, not requests"),
    kpi("Continuations", formatCount(summary.actors.continuations), "reuse the turn's route"),
    kpi("Main / subagent fresh", `${formatCount(summary.actors.mainFresh)} / ${formatCount(summary.actors.subagentFresh)}`),
    kpi("Auxiliary requests", summary.actors.auxiliary == null ? "unknown" : formatCount(summary.actors.auxiliary)),
    kpi("Jev decisions", formatCount(summary.jev.decisions), `${formatCount(summary.jev.fallbacks)} fallbacks`),
    kpi("Jev latency", formatMs(summary.jev.averageLatencyMs), `p95 ${formatMs(summary.jev.p95LatencyMs)}`),
    kpi("Actual routing cost", formatUsd(summary.jev.actualRoutingCostUsd), summary.jev.costComplete ? "Jev provider cost" : "partial: some calls reported no cost"),
  ]);
  return card("Summary", meta, kpis);
}

function profilesSection(summary) {
  if (!summary.routes.length) return card("Route profiles", h("p", { className: "subtle", text: "No fresh routes recorded." }));
  const max = Math.max(...summary.routes.map((row) => row.freshRoutes));
  return card("Route profiles", table("Fresh routes by effective profile", [
    { title: "Profile", render: (row) => label(row.profile) },
    { title: "Model", render: (row) => label(row.model) },
    { title: "Effort", render: (row) => label(row.effort, "default / none") },
    { title: "Sources", render: (row) => Object.entries(row.sources).map(([s, n]) => `${s} ${n}`).join(", ") },
    { title: "Fresh routes", num: true, render: (row) => formatCount(row.freshRoutes) },
    { title: "Share", num: true, render: (row) => formatPercent(row.share) },
    { title: "Chart", bar: true, render: (row) => bar(row.freshRoutes, max, formatPercent(row.share)) },
  ], summary.routes));
}

function tokenSection(usage) {
  const totals = usage.totals;
  const { segments, total, unknown } = tokenSegments(totals);
  const children = [];
  const completeness = totals.complete
    ? "Complete: every recorded request reported usage."
    : `Partial: ${formatCount(totals.requestsMissingUsage)} of ${formatCount(totals.requests)} requests reported no usage.`;
  children.push(h("p", { className: "meta" }, [
    document.createTextNode("Claude subscription usage, not a bill. "),
    h("span", { className: totals.complete ? "badge" : "badge warn", text: completeness }),
  ]));
  if (total > 0) {
    const legend = h("ul", { className: "legend" }, segments.map((segment) => h("li", {}, [
      h("span", { className: `swatch ${segment.className}` }),
      document.createTextNode(`${segment.label} ${formatCompact(segment.value)}`),
    ])));
    const stack = h("div", { className: "stack" }, segments.filter((s) => s.value > 0).map((segment) => {
      const part = h("div", { className: `segment ${segment.className}` });
      part.style.setProperty("width", `${(segment.share * 100).toFixed(2)}%`);
      part.title = `${segment.label}: ${formatCount(segment.value)}`;
      return part;
    }));
    stack.setAttribute("aria-hidden", "true");
    children.push(legend, stack);
  }
  if (unknown.length) children.push(h("p", { className: "subtle", text: `Not reported: ${unknown.join(", ")}.` }));
  children.push(table("Token totals (the table is the exact form of the bar above)", [
    { title: "Series", render: (row) => row.label },
    { title: "Tokens", num: true, render: (row) => formatCount(totals[row.key]) },
    { title: "Share", num: true, render: (row) => totals[row.key] == null || !total ? "–" : formatPercent(totals[row.key] / total) },
  ], TOKEN_SERIES));
  if (usage.byProfile.length) {
    children.push(h("h3", { text: "By route profile" }), table("Tokens by effective route profile; rows add up to the totals", [
      { title: "Profile", render: (row) => label(row.profile, "no route recorded") },
      { title: "Requests", num: true, render: (row) => formatCount(row.requests) },
      { title: "Missing usage", num: true, render: (row) => formatCount(row.requestsMissingUsage) },
      ...TOKEN_SERIES.map((series) => ({ title: series.label, num: true, render: (row) => formatCompact(row[series.key]) })),
    ], usage.byProfile));
  }
  return card("Token usage", ...children);
}

function actorNode(node) {
  const text = `${actorName(node)} · ${formatCount(node.routes)} routes · ${formatCount(node.requests)} requests (${formatCount(node.continuations)} continuations)` +
    (node.models.length ? ` · ${node.models.join(", ")}` : "");
  const item = h("li", {}, [h("span", { className: "wrap", text })]);
  if (node.children?.length) item.append(h("ul", {}, node.children.map(actorNode)));
  return item;
}

function actorSection(report) {
  const { roots, parentNotRecorded, parentMissing } = report.tree;
  const children = [];
  if (!report.actors.length) children.push(h("p", { className: "subtle", text: "No actors recorded." }));
  if (roots.length) children.push(h("ul", { className: "tree" }, roots.map(actorNode)));
  if (parentNotRecorded.length) {
    children.push(
      h("h3", { text: "Parent not recorded" }),
      h("p", { className: "subtle", text: "Telemetry did not record which actor started these; they are not assumed to belong to the main agent." }),
      h("ul", { className: "tree" }, parentNotRecorded.map(actorNode)),
    );
  }
  if (parentMissing.length) {
    children.push(
      h("h3", { text: "Parent missing" }),
      h("p", { className: "subtle", text: "The recorded parent is not in this session's telemetry (or the links form a cycle)." }),
      h("ul", { className: "tree" }, parentMissing.map(actorNode)),
    );
  }
  return card("Actors", ...children);
}

function routesSection(report) {
  const children = [];
  if (!report.routes.length) {
    children.push(h("p", { className: "subtle", text: "No fresh routes recorded." }));
  } else {
    children.push(table("Most recent fresh routing decisions first", [
      { title: "Time (UTC)", render: (row) => formatTime(row.timestamp) },
      { title: "Actor", render: (row) => actorName({ agentName: row.actorName, actorType: row.actorType }) },
      { title: "Route", render: (row) => label(row.effectiveProfile ?? row.model) },
      { title: "Recommended", render: (row) => label(row.recommendedProfile, "–") },
      { title: "Source", render: (row) => label(row.source) + (row.fallbackReason ? ` (${row.fallbackReason})` : "") },
      { title: "Confidence", num: true, render: (row) => formatConfidence(row.confidence) },
      { title: "Jev latency", num: true, render: (row) => formatMs(row.jevLatencyMs) },
      { title: "Jev cost", num: true, render: (row) => formatUsd(row.jevCostUsd) },
      { title: "Outcome", render: (row) => routeOutcome(row) },
      { title: "Rewrites", render: (row) => row.normalizationNotes.length ? row.normalizationNotes.map(String).join("; ") : "–" },
    ], report.routes));
  }
  const { page } = report;
  const prev = h("button", { text: "Newer" });
  const next = h("button", { text: "Older" });
  prev.type = next.type = "button";
  prev.disabled = page.offset === 0;
  next.disabled = page.offset + page.limit >= page.total;
  prev.addEventListener("click", () => { state.routesOffset = Math.max(0, page.offset - page.limit); refreshNow(); });
  next.addEventListener("click", () => { state.routesOffset = page.offset + page.limit; refreshNow(); });
  children.push(h("div", { className: "pager" }, [prev, h("span", { text: pageText(page) }), next]));
  return card("Recent routes", ...children);
}

function rewritesSection(summary) {
  const fallbacks = summary.fallbacks.length
    ? table("Fallback routes by reason", [
        { title: "Reason", render: (row) => label(row.reason) },
        { title: "Routes", num: true, render: (row) => formatCount(row.routes) },
      ], summary.fallbacks)
    : h("p", { className: "subtle", text: "No fallbacks recorded." });
  const rewrites = summary.rewrites.length
    ? table("Fresh routes whose request was adjusted for the chosen model", [
        { title: "Compatibility note", render: (row) => label(row.note) },
        { title: "Routes", num: true, render: (row) => formatCount(row.routes) },
      ], summary.rewrites)
    : h("p", { className: "subtle", text: "No compatibility rewrites recorded." });
  return card("Fallbacks and compatibility rewrites", fallbacks, rewrites);
}

// ---------- data flow ----------

function renderPicker(sessions, selected) {
  const picker = $("session-picker");
  const options = sessions.map((session) => {
    const option = h("option", {
      text: `${formatTime(session.startedAt)} · ${label(session.projectPath)} · ${session.routes} routes${session.endedAt == null ? " · active" : ""}`,
    });
    option.value = session.id;
    option.selected = session.id === selected;
    return option;
  });
  if (selected && !sessions.some((session) => session.id === selected)) {
    const option = h("option", { text: `${selected} (not in the most recent sessions)` });
    option.value = selected;
    option.selected = true;
    options.unshift(option);
  }
  picker.replaceChildren(...options);
  picker.disabled = options.length === 0;
}

function selectSession(id) {
  state.sessionId = id;
  state.routesOffset = 0;
  const url = new URL(location.href);
  if (id) url.searchParams.set("session", id);
  else url.searchParams.delete("session");
  history.replaceState(null, "", url);
}

async function load() {
  const status = await getJson("status");
  if (status.database !== "available") {
    renderPicker([], null);
    replaceContent(telemetryOffMessage(status));
    return;
  }
  const list = await getJson("sessions?limit=200");
  if (!list.sessions.length) {
    renderPicker([], null);
    replaceContent(stateMessage("No sessions recorded yet", [
      "The telemetry database exists but holds no sessions. Run jev-claude with JEV_ENABLE_TELEMETRY=1 to record one.",
    ]));
    return;
  }
  if (!state.sessionId) selectSession(list.current?.id ?? list.sessions[0].id);
  renderPicker(list.sessions, state.sessionId);
  const id = encodeURIComponent(state.sessionId);
  let summary, actors, usage, routes;
  try {
    [summary, actors, usage, routes] = await Promise.all([
      getJson(`sessions/${id}/summary`),
      getJson(`sessions/${id}/actors`),
      getJson(`sessions/${id}/usage`),
      getJson(`sessions/${id}/routes?limit=${ROUTE_PAGE}&offset=${state.routesOffset}`),
    ]);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      replaceContent(stateMessage("Session not found", [
        `Session ${state.sessionId} is no longer in the telemetry database; it may have been deleted by retention. Pick another session above.`,
      ]));
      return;
    }
    throw error;
  }
  if (routes.routes.length === 0 && state.routesOffset > 0 && routes.page.total > 0) {
    state.routesOffset = Math.max(0, Math.floor((routes.page.total - 1) / ROUTE_PAGE) * ROUTE_PAGE);
    return load();
  }
  replaceContent(
    summarySection(summary),
    h("div", { className: "grid" }, [
      card("Models", distributionTable("Fresh routes by model", summary.models, "model", "Model")),
      card("Efforts", distributionTable("Fresh routes by effective effort", summary.efforts, "effort", "Effort")),
    ]),
    profilesSection(summary),
    tokenSection(usage),
    actorSection(actors),
    routesSection(routes),
    rewritesSection(summary),
  );
}

async function tick() {
  state.timer = null;
  if (state.inflight) return;
  if (document.hidden) return;
  state.inflight = true;
  try {
    await load();
    state.failures = 0;
    state.rendered = true;
    setBanner(null);
    $("updated").textContent = `Last updated ${new Date().toLocaleTimeString()}; refreshes every ${POLL_MS / 1000}s while this tab is visible.`;
  } catch (error) {
    state.failures += 1;
    const wait = Math.round(nextDelay(state.failures, POLL_MS) / 1000);
    const reason = error?.body?.message ?? error?.message ?? "unknown error";
    if (state.rendered) {
      $("content").classList.add("stale");
      setBanner(`Showing stale data: the last refresh failed (${reason}). Retrying in ${wait}s.`);
    } else {
      replaceContent(stateMessage("The dashboard could not load telemetry", [reason, `Retrying in ${wait}s.`]));
      setBanner(`Load failed; retrying in ${wait}s.`, "error");
    }
  } finally {
    state.inflight = false;
    schedule();
  }
}

function schedule() {
  clearTimeout(state.timer);
  if (document.hidden) return;
  state.timer = setTimeout(tick, nextDelay(state.failures, POLL_MS));
}

function refreshNow() {
  clearTimeout(state.timer);
  if (state.inflight) {
    state.timer = setTimeout(refreshNow, 100);
    return;
  }
  tick();
}

$("session-picker").addEventListener("change", (event) => {
  selectSession(event.target.value);
  refreshNow();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(state.timer);
  else refreshNow();
});
refreshNow();

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { databasePath } from "../telemetry/config.mjs";
import {
  actorBreakdown,
  countRoutes,
  countSessions,
  findSession,
  listSessions,
  openReader,
  routeHistory,
  sessionSummary,
  usageByProfile,
  usageTotals,
} from "../telemetry/read.mjs";
import { resolveSession } from "../ui/session.mjs";
import {
  buildActorsReport,
  buildRoutesReport,
  buildStatsReport,
  buildUsageReport,
} from "../ui/reports.mjs";
import { redactText } from "../sanitize.mjs";

export const API_VERSION = "v1";

export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
});

// A fixed map, never a path join: nothing outside these four files can be served.
const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/format.js", ["format.js", "text/javascript; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
]);

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Hostname part of a Host header value (`name[:port]`, IPv6 in brackets), lowercased. */
export function hostnameOf(host) {
  if (typeof host !== "string" || !host) return null;
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return null;
    const rest = value.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return null;
    return value.slice(0, end + 1);
  }
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(value);
  return match ? match[1] : null;
}

/** Only loopback names are accepted, which blocks DNS-rebinding pages from reading the API. */
export const isLoopbackHost = (host) => LOOPBACK_HOSTNAMES.has(hostnameOf(host));

/** An absent Origin is a same-origin navigation or a non-browser client; a present one must be loopback http. */
export function isAllowedOrigin(origin) {
  if (origin == null) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname) && !url.username && !url.password;
}

const DEFAULT_ROUTE_LIMIT = 50;
const MAX_ROUTE_LIMIT = 200;
const DEFAULT_SESSION_LIMIT = 50;
const MAX_SESSION_LIMIT = 200;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Parse a non-negative integer query parameter with a default and an upper bound. */
export function intParam(params, name, { fallback, max = Number.MAX_SAFE_INTEGER }) {
  const raw = params.get(name);
  if (raw == null || raw === "") return fallback;
  if (!/^\d{1,9}$/.test(raw)) {
    throw new ApiError(400, "invalid_parameter", `${name} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (value > max) throw new ApiError(400, "invalid_parameter", `${name} must be at most ${max}`);
  return value;
}

export async function startDashboard({
  env = process.env,
  cwd = process.cwd(),
  host = "127.0.0.1",
  port = 0,
  openDb = (options) => openReader(options),
} = {}) {
  const assetRoot = new URL("./public/", import.meta.url);
  const assets = new Map(
    [...ASSETS].map(([path, [file, type]]) => [path, { body: readFileSync(new URL(file, assetRoot)), type }]),
  );

  const send = (req, res, status, type, body, extra = {}) => {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      "Content-Type": type,
      "Content-Length": Buffer.byteLength(body),
      ...extra,
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };
  const sendJson = (req, res, status, value, extra) =>
    send(req, res, status, "application/json; charset=utf-8", JSON.stringify(value), extra);
  const sendError = (req, res, status, code, message, extra) =>
    sendJson(req, res, status, { ok: false, code, message }, extra);

  const withDb = (fn) => {
    const db = openDb({ env });
    if (!db) {
      throw new ApiError(503, "telemetry_unavailable", "No readable telemetry database was found.");
    }
    try {
      return fn(db);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        500,
        "telemetry_read_failed",
        redactText(`Telemetry could not be read: ${error?.message ?? "unknown error"}`),
      );
    } finally {
      db.close();
    }
  };

  const api = (path, params) => {
    if (path === "status") {
      const file = databasePath(env);
      if (!existsSync(file)) return { ok: true, database: "missing", path: file };
      const db = openDb({ env });
      if (!db) return { ok: true, database: "unreadable", path: file };
      db.close();
      return { ok: true, database: "available", path: file };
    }
    if (path === "sessions") {
      const limit = intParam(params, "limit", { fallback: DEFAULT_SESSION_LIMIT, max: MAX_SESSION_LIMIT });
      const offset = intParam(params, "offset", { fallback: 0 });
      return withDb((db) => {
        const current = resolveSession(db, { requested: "current", projectPath: cwd, env });
        return {
          ok: true,
          current: current.session
            ? { id: current.session.id, source: current.source }
            : { id: null, source: null, reason: current.error ?? null },
          sessions: listSessions(db, { limit, offset }),
          page: { limit, offset, total: countSessions(db) },
        };
      });
    }
    const match = /^sessions\/([^/]+)\/(summary|actors|routes|usage)$/.exec(path);
    if (!match) throw new ApiError(404, "not_found", "Unknown API endpoint.");
    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      throw new ApiError(400, "invalid_parameter", "session id is not valid");
    }
    const view = match[2];
    const limit = view === "routes"
      ? intParam(params, "limit", { fallback: DEFAULT_ROUTE_LIMIT, max: MAX_ROUTE_LIMIT })
      : null;
    const offset = view === "routes" ? intParam(params, "offset", { fallback: 0 }) : null;
    return withDb((db) => {
      const session = findSession(db, id);
      if (!session) throw new ApiError(404, "not_found", "Session not found.");
      const filter = { sessionId: session.id };
      const scope = {
        type: "session",
        id: session.id,
        projectPath: session.projectPath,
        selectionSource: "explicit",
      };
      if (view === "summary") {
        return buildStatsReport(sessionSummary(db, session.id), { selectionSource: "explicit" });
      }
      if (view === "actors") return buildActorsReport(actorBreakdown(db, filter), scope);
      if (view === "usage") {
        return buildUsageReport(usageTotals(db, filter), usageByProfile(db, filter), scope);
      }
      return {
        ...buildRoutesReport(routeHistory(db, { ...filter, limit, offset, newestFirst: true }), scope),
        page: { limit, offset, total: countRoutes(db, filter) },
      };
    });
  };

  const handle = (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendError(req, res, 405, "method_not_allowed", "The dashboard is read-only.", {
        Allow: "GET, HEAD",
      });
    }
    if (!isLoopbackHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
      return sendError(req, res, 403, "forbidden", "Only loopback requests are accepted.");
    }
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      return sendError(req, res, 400, "invalid_parameter", "Malformed request URL.");
    }
    const asset = ASSETS.has(url.pathname) ? assets.get(url.pathname) : null;
    if (asset) return send(req, res, 200, asset.type, asset.body);
    const prefix = `/api/${API_VERSION}/`;
    if (!url.pathname.startsWith(prefix)) {
      return sendError(req, res, 404, "not_found", "Not found.");
    }
    try {
      return sendJson(req, res, 200, api(url.pathname.slice(prefix.length), url.searchParams));
    } catch (error) {
      if (error instanceof ApiError) return sendError(req, res, error.status, error.code, error.message);
      return sendError(req, res, 500, "telemetry_read_failed", "Telemetry could not be read.");
    }
  };

  const server = createServer(handle);
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const bound = server.address().port;
  const shownHost = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${shownHost}:${bound}/`,
    port: bound,
    close: () =>
      new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeAllConnections?.();
      }),
  };
}

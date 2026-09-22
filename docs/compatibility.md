# Compatibility and release notes

What this router supports, what it records, how it behaves when something fails, and how to
back it out. Everything below describes `jev-router` 0.3.0.

## Supported runtimes

| Component | Supported | Notes |
|---|---|---|
| Node.js | >= 20.12 | Continuous integration runs the full suite on 20.12 and on the current 22.x release. |
| Claude Code CLI | Any version whose `/v1/messages` requests match the adapter below | The router forwards anything it cannot classify, so an unrecognised version loses routing, not function. |
| Claude Code in the VS Code extension | **Experimental** | See [VS Code status](#vs-code-status). |
| Codex CLI | Any version accepting a `model_provider` from `--config` | Codex support shares the routing core but has its own proxy and status surface. |
| Persistent daemon | Loopback-only, lifecycle-managed | Uses the same Claude routing engine; VS Code configuration remains a separate experimental layer. |
| `better-sqlite3` | ~12.9, optional | Only telemetry needs it. Without it the router runs normally and records nothing. |

## Versioned interfaces

These identifiers appear in stored decisions and telemetry rows, so an old record can always
be read back against the rules that produced it.

| Interface | Version | Bump when |
|---|---|---|
| Claude request adapter | `messages-v2/2026-09-22` | Claude Code's request shape changes in a way the current parser reads wrongly. |
| Model capability matrix | `2026-09-22` | Anthropic changes which models accept which effort levels or thinking modes. |
| Telemetry database schema | `1` (`PRAGMA user_version`) | A migration is added. Migrations are append-only; upgrading never requires deleting existing telemetry. |
| `jev stats` / `jev routes` JSON | `schemaVersion: 1` | A field changes meaning or disappears. |

A database written by a newer router is refused rather than rewritten, and the failure
disables telemetry instead of blocking inference.

### Claude models

The routing tiers resolve against the signed-in account's own catalog. The built-in defaults
are `claude-haiku-4-5-20251001`, `claude-sonnet-5`, `claude-opus-5`, and — behind
`JEV_ALLOW_LONG_TIER` — `claude-fable-5-1`. A tier whose model the account cannot use steps
up to an equal-or-stronger one; it never silently lands on something weaker. Override an
exact model per tier with `JEV_CLAUDE_FAST_MODEL`, `JEV_CLAUDE_BALANCED_MODEL`,
`JEV_CLAUDE_STRONG_MODEL`, or `JEV_CLAUDE_LONG_MODEL`.

## Setup

```bash
npm install -g jev-router
# routing provider: either of these is enough
export OPENROUTER_API_KEY=...        # preferred when both are set
export JEV_API_KEY=...               # direct TypeSafe; TYPESAFE_API_KEY also works
jev-claude                           # then pick "Jev Router" in /model
```

Keys may also live in `./.env` or `~/.jev-router.env`. Claude inference itself keeps using
the Claude Code sign-in; no `ANTHROPIC_API_KEY` is needed or read for it, and the routing key
is never sent to Anthropic.

With no provider key, `jev-claude` still starts Claude Code — unrouted, and it says so.

The persistent proxy is managed explicitly and is never installed as a startup service:

```bash
jev daemon start
jev daemon status
jev daemon stop
```

It binds only to `127.0.0.1`, records owner-only runtime metadata under `JEV_DATA_DIR`, and
keeps credentials in process memory/environment. `JEV_PROXY_PORT` requests an exact port and
fails if that port is occupied. Without it, a clean restart reuses the last available port.
The standalone `jev-claude` path remains independent and does not fail if the daemon is down.

## Configuration migration

Nothing needs migrating to reach 0.3.0 from an earlier install; every new knob is additive
and off or at its documented default until set. Two names changed meaning or gained a
replacement:

| Old | Current | Behaviour |
|---|---|---|
| `JEV_ALLOW_FABLE` | `JEV_ALLOW_LONG_TIER` | Both still work; the old name is a documented alias. |
| `jevDeadlineMs` (internal, no env var) | `JEV_TIMEOUT_MS` | One configurable total deadline for a decision, request plus retries. Default `1500` ms. |

Raw Jev request/response persistence was removed. A decision now stores a SHA-256 hash of the
prompt. Prompt text is stored only if you set `JEV_STORE_PROMPTS=1`, or a scrubbed truncation
with `JEV_STORE_PROMPT_PREVIEW=1`. An older status file written with prompt text still reads.

Telemetry is **off by default** in this release (`JEV_ENABLE_TELEMETRY=1` to enable), so an
upgrade does not begin writing a local database without being asked. This is a deliberate
departure from the specification's recommended defaults, which suggest enabling it: a record
of what you asked a coding assistant to do, and when, is not something that should start being
written because you upgraded. `jev stats` and `jev routes` report no data until you opt in,
and say so rather than showing zeroes.

## Privacy

- Only the fresh task text of a turn is sent to the routing provider — never tool output,
  file contents, or repository data. `jev-claude` prints this at startup.
- The routing key and the Claude credential never cross: each goes only to its own upstream.
- Secrets are redacted from every log, dump, and stored decision.
- The telemetry database, its WAL, and its sidecars are created owner-only, under
  `~/.jev-router` (or `JEV_DATA_DIR`), and hold no prompt text by default. Ended sessions are
  pruned after `JEV_TELEMETRY_RETENTION_DAYS` (default 90).
- `jev stats` and `jev routes` read that local database and contact nothing.

## Failure behaviour

Routing is advisory infrastructure; Claude Code must keep working when it breaks. Every case
below is covered by automated tests.

| Failure | What happens |
|---|---|
| Routing provider offline, unresolvable, or slow | The turn is forwarded on the current route. The delay is bounded by `JEV_TIMEOUT_MS`. |
| Routing answer is malformed, or names a model the account does not have | Refused; the turn is forwarded on the current route. |
| Effort or thinking mode unsupported by the chosen model | Normalised to the nearest supported setting, and the normalisation is recorded. |
| Claude rejects the rewritten request | The upstream status and body are forwarded verbatim. Possibly executed inference is never automatically replayed. |
| The response stream ends early | Forwarded as far as it got; usage is recorded as incomplete rather than guessed. |
| Telemetry database missing, locked, unwritable, or full | Telemetry drops the write. Routing and forwarding are unaffected. |
| The router restarts mid-session | In-flight pins are gone, so continuations fall back to a safe model and the next fresh boundary is decided again. Stored telemetry survives. |
| The request shape is unrecognised | Forwarded unrouted, with the `jev-router` sentinel resolved to a real model. |
| Daemon runtime PID is stale or reused | Status reports stale state; stop signals nothing. A later start replaces metadata only after health/instance validation. |
| Requested daemon port is occupied | Explicit `JEV_PROXY_PORT` startup fails; an implicit remembered port falls back to a new loopback port. |

## Rollback

Each feature landed as one squashed commit on `master`, so a single feature can be withdrawn
without unwinding the rest:

```bash
git revert <merge-commit>      # e.g. the session-statistics merge
npm test
```

To stop routing without changing any code, unset the provider keys, or pick a concrete model
in `/model` — the router then passes every request through untouched. To stop telemetry, unset
`JEV_ENABLE_TELEMETRY`; existing data stays on disk until retention or manual deletion removes
it. `jev daemon stop` performs a bounded drain and removes only runtime state belonging to the
verified instance.

## VS Code status

**Experimental.** The Claude Code VS Code extension is not a supported configuration for this
release. No extension version has been tested end to end against the router, and the launcher
sets its environment for a child process, which the extension does not necessarily inherit.

**Supported:** running `jev-claude` in VS Code's integrated terminal, which is an ordinary
CLI session.

## The Jev model on OpenRouter

OpenRouter publishes **no floating alias** for Jev. Verified live on 2026-09-22:
`typesafe/jev-latest`, `typesafe/jev` and `typesafe/jev-1` all return HTTP 400 "Model ...
does not exist". Because routing fails open, naming a model that does not exist produces no
error a user would notice — only silently unrouted turns.

The default is therefore `typesafe/jev-1.13`, the form used by the Decisions API reference
itself. OpenRouter resolves it server-side to a dated build (`typesafe/jev-1.13-20260917` at
the time of writing) and reports both in every decision, so `jev routes` shows the configured
and the resolved model separately.

Set `JEV_OPENROUTER_MODEL` to pin a dated build exactly, or to move to a newer minor line
when one is published. If routing appears to do nothing, check `~/.jev-claude.log` with
`JEV_DEBUG=1`: a non-existent model shows up there as `provider_error`.

## Verification status

The automated suite runs against mocked upstreams and mocked routing on every pull request.
The following require credentials or a signed-in subscription and are **not** run in CI; until
they are executed and their sanitized evidence recorded, the corresponding claims are pending,
not passed:

```bash
JEV_LIVE=1 OPENROUTER_API_KEY=... npm run test:live:jev-openrouter   # real routing decisions
JEV_LIVE=1 OPENROUTER_API_KEY=... npm run test:live:claude           # real Claude turn, subscription auth
JEV_LIVE=1 OPENROUTER_API_KEY=... npm run test:live:subagents        # real subagent actors
npm run test:pack                                                     # install the real tarball and run every CLI
```

Each live command refuses to run without `JEV_LIVE=1`, prints what it is about to spend
before spending it, and writes a redacted record to `~/.jev-router/live-evidence/`.

Specifically still unverified at the time of writing:

- Real Claude Code actor correlation. Every automated assertion about main-versus-subagent
  identity uses synthetic correlation metadata, because no captured Claude Code request is
  known to carry actor fields. The classifier fails open when they are absent.
- A real account's Claude model catalog and capability behaviour.
- Any VS Code extension version.

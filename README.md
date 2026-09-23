# jev-router

Automatic per-turn model routing for Claude Code and OpenAI Codex. Jev sends simple work to
the fast tier and difficult work to the strong tier, while preserving each CLI's native
interface, tools, sessions, permissions, and authentication.

| Command | Interface | Authentication | Routing decision |
| --- | --- | --- | --- |
| `jev-claude` | Claude Code | Existing `claude login` | Status line |
| `jev-codex` | OpenAI Codex | Existing `codex login` | Commentary line |
| `jev stats` / `jev routes` | Local telemetry | None | Read-only reports |
| `jev daemon` | Persistent Claude proxy | Forwarded per request | `/health` and status files |
| `jev dashboard` | Local browser view of telemetry | None | Read-only loopback page |

Both launcher commands run the real upstream CLI. Jev only chooses the model for a fresh user turn.

## Quick start

Requires Node.js 20.12+ and at least one supported CLI:
[Claude Code](https://code.claude.com/docs/en/setup) or
[OpenAI Codex](https://developers.openai.com/codex/cli).

### 1. npm package

```bash
npm install -g jev-router
echo "JEV_API_KEY=..." > ~/.jev-router.env
```

### 2. Local repository

```bash
git clone https://github.com/gargpratyush/jev-router.git
cd jev-router
npm install
npm link
echo "JEV_API_KEY=..." > ~/.jev-router.env
```

On Windows PowerShell:

```powershell
Set-Content "$HOME\.jev-router.env" "JEV_API_KEY=..."
```

Get a key from [TypeSafe](https://docs.typesafe.ai). Then launch either interface from any
repository:

```bash
jev-claude
jev-codex
```

No Anthropic or OpenAI API key is required when the corresponding CLI is already logged in
with a subscription. Every CLI argument is forwarded:

```bash
jev-claude --resume
jev-claude -p "fix the failing test"
jev-codex resume --last
jev-codex exec "fix the failing test"
```

The persistent proxy has an explicit lifecycle:

```bash
jev daemon start
jev daemon status
jev daemon stop
```

It is infrastructure for clients that cannot be launched as a child process. `jev-claude`
continues to start and stop its own independent proxy; it never depends on daemon availability.

For a local checkout, `npm link` installs both launchers and the `jev` report command. Without
it, run `node bin/jev-claude.mjs`, `node bin/jev-codex.mjs`, or `node bin/jev.mjs`.

## Claude Code interface

![Jev Router in the Claude Code model picker](docs/model-picker.png)

`jev-claude` launches Claude Code with **Jev Router** selected in `/model`. Selecting another
model pauses routing; selecting **Jev Router** resumes it.

The injected status line shows the active actor, effective model/effort, confidence, unusual
fallbacks, and a compact distribution of recent fresh decisions:

```text
main claude-opus-5/high (p=0.93) · H 61%/S 28%/O 11% · my-project · 8% context
subagent:Explore claude-haiku-4-5/default (p=0.97) · H 67%/O 33% · my-project · 55% context
⏸ manual Opus 4.6 · my-project · 21% context
```

Claude Code otherwise remains unchanged, including its keybindings, tools, permission prompts,
`/compact`, `/resume`, and session handling. An existing custom `statusLine` is preserved;
set `JEV_NO_STATUSLINE=1` to disable Jev's status line.

The explanation skill is bundled with the npm package and loaded automatically: run
`/jev-explain` in `jev-claude`, or `$jev-explain` in `jev-codex`, to see the factors behind
the last routing decision:

```text
Jev Router
Actor
  Type: subagent
  Name: Explore
Request
  Classification: subagent_fresh
Jev
  Provider: openrouter
  Confidence: 94%
Recommendation
  Profile: haiku-default
Effective route
  Selected model: CLAUDE-HAIKU-4-5
  Effective effort: DEFAULT
Upstream outcome
  Status: succeeded
```

The report is rendered locally from the normalized fields saved when routing occurred. It
separates the actor and request classification, Jev recommendation, effective enforced route,
and observed upstream outcome. Missing confidence or outcome data is shown as unavailable,
including for status files written by older releases. By default only a hash of the prompt is
saved. Recent decisions are retained per CLI session; invoking the explanation skill does not
ask Jev to score the prompt again.

### Explanation data location

Both `jev-claude` and `jev-codex` keep up to 20 recent routing decisions in one JSON file per
CLI session under Node.js's operating-system temporary directory:

| Platform | Default location |
| --- | --- |
| Windows | `%TEMP%\jev-claude\<session-id>.json` |
| macOS | `$TMPDIR/jev-claude/<session-id>.json` (normally under `/var/folders/.../T`) |
| Ubuntu/Linux | `${TMPDIR:-/tmp}/jev-claude/<session-id>.json` |

Print the exact directory selected on the current machine with:

```bash
node -e "console.log(require('node:path').join(require('node:os').tmpdir(), 'jev-claude'))"
```

Claude filenames use Claude Code's session UUID. Codex filenames use
`codex-<jev-codex-process-id>.json`. These files hold the routing tier, confidence, per-request
metrics, and a SHA-256 hash of the prompt; they never hold the raw Jev request/response, and
prompt text is included only if you opt in (see below). They are readable only by you (the
directory is created with mode 700 and each file with 600). Files not updated for 7 days are
deleted automatically, and the operating system may also remove them during normal
temporary-file cleanup.

### Prompt and diagnostic privacy

By default, a routing decision stores a SHA-256 hash of the prompt, never the prompt text
itself, and never the raw Jev request/response (which would otherwise embed the prompt again).
Two opt-ins loosen this, in order of precedence:

| Variable | Effect |
| --- | --- |
| `JEV_STORE_PROMPTS=1` | Stores the exact prompt text in the decision. |
| `JEV_STORE_PROMPT_PREVIEW=1` | Stores a truncated, secret-scrubbed preview instead (ignored if `JEV_STORE_PROMPTS` is also set). |

`JEV_DUMP` and `JEV_DUMP_CONTENT` (below) changed behavior in this version: `JEV_DUMP` used to
be a path prefix you supplied yourself, with the full unredacted request body written next to
it (`$JEV_DUMP.<timestamp>.json`). It is now a boolean flag. Dumps land under a fixed private
directory, message/system/instructions text is omitted by default (structure only, for
diagnosing wire-format changes), and every dump has secret-shaped fields (authorization,
API keys, cookies, tokens) redacted regardless of the content flag.

> Choosing a model with `Enter` can save it as Claude Code's default. `jev-claude` restores
> the previous default on exit so `jev-router` cannot break plain `claude`.

## OpenAI Codex interface

![Jev Router in the OpenAI Codex model picker](docs/codex-model-picker.png)

`jev-codex` launches Codex with a temporary **Jev Router** provider and selects `jev-router`.
The native `/model` picker still contains the models available to the account. Selecting a
concrete model pauses routing; selecting **Jev Router** resumes it.

Each fresh decision appears as Codex commentary:

```text
[Jev] routed this turn to gpt-5.6-sol (jev, confidence 0.91).
```

`jev-codex` installs or refreshes the packaged `$jev-explain` skill when it starts, so it is
available from any repository without separate setup.

Codex's footer shows `jev-router` because it displays the selected picker entry,
not the model chosen behind that provider. If Jev is unavailable, the commentary names the
fallback model and explains how to set `JEV_API_KEY`.

## How it works

Each command starts a loopback proxy, launches the real CLI, and forwards the CLI's existing
authorization headers without reading, storing, or modifying them.

```text
you -> Claude Code -> jev-claude proxy -> Anthropic
                         |
                         +-> Jev: choose a tier

you -> OpenAI Codex -> jev-codex proxy -> OpenAI
                         |
                         +-> Jev: choose a tier
```

Claude Code uses `ANTHROPIC_BASE_URL`; Codex uses a temporary custom provider with
`requires_openai_auth=true`. Claude and Codex both use `jev-router` as the
routing sentinel.
Any concrete model selected by the user passes through unchanged.

### Persistent loopback daemon

`jev daemon start` runs the same Claude routing engine on `127.0.0.1`, reusing its last port
when available. `JEV_PROXY_PORT=<port>` requests an exact port; if it is occupied, startup
fails instead of silently moving. The command does not install a startup service or persist
credentials. Provider keys remain in the daemon's environment, while each Claude authorization
header is forwarded only with the request that supplied it.

Runtime metadata is stored under `JEV_DATA_DIR` (default `~/.jev-router`) in private files:

```text
runtime.json       live pid, port, start time, router version, instance id
daemon-port.json   last successful port for stable restart
```

`runtime.json` exists only for the owning live instance. Concurrent starts converge on that
instance; stale state and crashed starts recover without using a PID file as permission to
signal a process. `jev daemon stop` first verifies the loopback health response, PID, and
instance id, then asks the verified daemon to drain in-flight requests and flush telemetry.

`GET /health` returns only operational fields: router version, instance identity, PID,
provider name, whether a provider key is available, telemetry status, and counts of
forwarded message requests. No credentials or
prompt content are returned. Shared daemon state requires a Claude session id; a client that
does not provide reliable session identity is forwarded conservatively without creating a
reusable route pin. This keeps simultaneous clients and projects from sharing routing state.

### VS Code

The Claude Code VS Code extension can use the daemon, but this is **experimental**; see
[docs/vscode-compatibility.md](docs/vscode-compatibility.md). The reliable option is
`jev-claude` in the integrated terminal.

```bash
jev daemon start
jev vscode doctor          # checks VS Code, the extension, the daemon, and your settings
jev-code .                 # or: open VS Code pointed at the daemon
```

`jev vscode doctor` never writes settings. It prints the entries to add to
`claudeCode.environmentVariables` (at least `ANTHROPIC_BASE_URL` and the **Jev Router** picker
row), names any other entries you already have without showing their values, and reports
`Routing: observed` only once the daemon has actually forwarded a request. `jev-code` starts
or reuses the daemon and opens `code` with the same environment; a VS Code process that is
already running keeps its old environment. Set `JEV_PROXY_PORT` so settings keep naming the
right port, `JEV_VSCODE_BIN` to use another `code` command, and `JEV_VSCODE_SETTINGS` to check
a different settings file.

## Jev provider

Jev itself can be reached two ways, behind one internal `JevProvider` interface
(`src/providers/`) so the rest of the router does not know which one is active:

| Provider | Transport | Enable with |
| --- | --- | --- |
| Direct TypeSafe | `@typesafe-ai/sdk`, `POST /v1/systemone` | `JEV_API_KEY` (or `TYPESAFE_API_KEY`) |
| OpenRouter | Native `fetch`, `POST /api/alpha/decisions` (the [OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request), alpha) | `OPENROUTER_API_KEY` |

Selection order, checked once per launch:

1. `JEV_PROVIDER=openrouter` or `JEV_PROVIDER=typesafe`, if set, always wins. An unknown value,
   or a provider selected without its key, is a visible startup message and unrouted operation
   -- never a silent fall-through to whichever other key happens to be set.
2. Otherwise `OPENROUTER_API_KEY`, if present, prefers OpenRouter.
3. Otherwise `JEV_API_KEY`/`TYPESAFE_API_KEY`, if present, uses direct TypeSafe.
4. Otherwise routing is unavailable and both launchers run the real CLI unrouted.

Both adapters normalize their response into the same shape (chosen model, confidence,
probabilities, task-complexity metrics, decision id, configured/resolved model, token usage,
cost when the provider reports it) and sort every failure into one of `auth_error`,
`rate_limited`, `timeout`, `network_error`, `invalid_response`, `provider_error`, or
`unknown_error`. Any failure returns `null` to the policy layer -- routing fails open, never
blocking the turn it was supposed to speed up (see Limitations).

At startup, `jev-claude` runs a bounded, unpaid `healthCheck()` against the selected
provider (OpenRouter's `GET /api/v1/key`, or TypeSafe's `GET /v1/models`) and prints a warning
if it fails, without delaying or blocking the session.

## Routing policy

One Jev call per fresh user turn selects a route. Claude uses capability-validated
model/effort profiles by default; Codex continues to map the same tier vocabulary to its
native model and reasoning controls:

| Tier | Claude Code default | Codex default |
| --- | --- | --- |
| Fast | Haiku | `gpt-5.6-luna` |
| Balanced | Sonnet | `gpt-5.6-terra` |
| Strong | Opus | `gpt-5.6-sol` |
| Long | Fable | `gpt-6-astra` |

The local policy then applies these rules:

- explicit requests such as `use opus`, `use luna`, or `use strong` win;
- failure, timeout, or an unrecognised Jev answer keeps the current model;
- confidence below `0.45` never downgrades and caps upgrades at the balanced tier;
- large conversations refuse downgrades that would waste more prompt-cache work than they save;
- unavailable tiers step upward rather than silently choosing a weaker model;
- the long tier is disabled unless `JEV_ALLOW_LONG_TIER=1` (legacy `JEV_ALLOW_FABLE=1` also works);
- Fable bills extra usage credit. If the account refuses a routed Fable request (no credit, or
  the model is not enabled), the Claude proxy retries that request once on Opus, pins the turn
  there, and stops offering Fable for the rest of the session.

For Claude, the signed-in account catalog is resolved into profiles such as `sonnet-low`,
`sonnet-medium`, and `opus-high`. The versioned capability matrix validates the selected
model before the proxy merges `output_config.effort` and normalizes incompatible thinking
fields. Unknown model capabilities are not guessed: existing controls are preserved and the
route fails open. Set `JEV_DECISION_MODE=signals` to retain the original exact-model choice
plus normalized 0–9 reasoning-score mapping.

The bundled matrix was verified on 2026-09-22 against Anthropic's
[Models API](https://platform.claude.com/docs/en/api/models/list),
[effort](https://platform.claude.com/docs/en/build-with-claude/effort), and
[thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
documentation. Runtime effort capabilities returned by the signed-in account take precedence;
validated exact-model overrides cover private or newer catalog entries.

Tool-loop continuations keep the tier chosen at the start of the turn. Routing is fail-open:
Jev failure never blocks the CLI.

### Actors, subagents, and auxiliary calls

Each request is classified as one of `main_fresh`, `main_continuation`, `subagent_fresh`,
`subagent_continuation`, `auxiliary`, `manual_passthrough`, or `unknown`. A route is chosen
once per main fresh turn and once per newly spawned subagent task, then pinned -- model,
effort, and thinking policy together -- to that actor and turn. Concurrent requests for the
same boundary share one decision; unrelated actors never wait on each other. A subagent's
route never replaces the main agent's pin, and the main pin survives subagent returns,
retries, and interleaved tool results.

Identity comes from explicit correlation fields on the request when they are present. When
they are not, the router is deliberately conservative: the first inference root in a session
establishes the main actor, its own continuations are recognised by their transcript root,
and any other uncorrelated root is treated as `unknown` and passed through unrouted rather
than guessed at from task text. Two identical subagent tasks are otherwise indistinguishable
on the wire, and a wrong guess would overwrite another actor's pin. After a restart the
router does not reconstruct identity from saved decisions; it falls back safely until the
next confirmed boundary.

Subagent handling is set with `JEV_SUBAGENT_MODEL_POLICY`:

| Value | Behavior |
| --- | --- |
| `route` (default) | Routes confidently identified subagents. A model the user locked (`model_source` of `user`/`hard-lock`) always wins, and unknown lock provenance preserves the requested model. |
| `respect-explicit` | Routes only requests carrying the `jev-router` sentinel; any concrete requested model is left alone. |
| `inherit` | Skips Jev entirely and reuses the parent's pinned route. A subagent whose parent is not safely known falls back to an ordinary routed decision. |

Claude Code's own auxiliary calls (titles, summaries, suggestions -- requests with no tools)
make no Jev call and change no pin or manual-selection state. `JEV_AUXILIARY_POLICY` selects
`passthrough` (default), `inherit` (reuse the actor's or parent's pinned route), or `fast`
(always the fast profile). Because the `jev-router` sentinel is not a real model, an auxiliary
request carrying it is still resolved to a safe real model before it is forwarded.

## Usage telemetry

Telemetry is **off by default**. With `JEV_ENABLE_TELEMETRY=1`, the router records what it
routed and what those requests cost in tokens, into a local SQLite database:

```text
~/.jev-router/telemetry.sqlite3      (directory 0700, database and sidecars 0600)
```

Nothing is sent anywhere. The database answers, per session: how many routes went to each
model and effort, how many were main-agent versus subagent, how many were fresh decisions
versus tool-loop continuations, what the routing decisions cost through the provider, and what
Claude reported for input, output, and cache tokens.

**Writes never touch the response path.** Events are queued in memory and written by a worker
thread in batched transactions. The response itself is piped through untouched; usage is read
from a copy of the bytes. If the database is missing, locked, corrupt, or full, telemetry
disables itself for that run with a diagnostic and inference continues unaffected. A saturated
queue drops events and counts them rather than growing.

**Counts are honest about what is missing.** A response whose usage was never observed -- a
stream cut short, an unreadable encoding -- leaves that request's tokens `NULL`, and every
total reports how many requests were unaccounted for. Unknown is never rendered as zero.

**No Claude cost is computed.** `jev-claude` runs against a Claude subscription, so an "API
cost" would be fiction. Only the routing provider's own reported cost is stored, and only when
the provider reports it.

The database schema is versioned with `PRAGMA user_version` and migrated forward; a normal
upgrade never asks you to delete telemetry, and a database written by a newer router is left
untouched rather than rewritten. Sessions that ended more than `JEV_TELEMETRY_RETENTION_DAYS`
ago (default 90) are removed at launch, in one transaction, with their actors, routes,
requests, and usage. A session with no recorded end is active and is never removed.

Prompt text is not stored: routes carry a SHA-256 request hash, and `prompt_preview` is `NULL`
unless `JEV_STORE_PROMPT_PREVIEW=1` or `JEV_STORE_PROMPTS=1` is set. Credentials are never
persisted.

Telemetry needs the optional native dependency `better-sqlite3`. If it is not installed (or
cannot build on your platform), the router runs normally and telemetry stays off.

### Local statistics and route history

The `jev` command reads the SQLite database locally and never contacts Jev, Anthropic, or
OpenAI:

```bash
jev stats
jev stats --session current
jev stats --session <id>
jev stats --project .
jev stats --json
jev routes --session current
jev routes --session <id> --json
```

`current` first uses an available caller session identity. Otherwise it selects the sole active
session for the current project, or the most recent ended session. If several sessions are
active, the command lists their IDs and requires `--session` instead of guessing. `--project`
aggregates exact recorded project paths.

Stats count fresh routing decisions separately from continuation and auxiliary requests. Token
totals are labeled partial when any request lacks usage, and provider cost means actual Jev
routing cost only. Claude token counts are subscription usage; they are not an API-price or
subscription-billing estimate.

JSON output is stdout-only and uses report `schemaVersion: 1`. A stats document has the stable
top-level keys `schemaVersion`, `kind`, `scope`, `period`, `routes`, `models`, `efforts`,
`actors`, `usage`, `jev`, `fallbacks`, and `rewrites`; a routes document has `schemaVersion`, `kind`, `scope`, and `routes`. Unknown
numeric data is `null`, not zero. Errors are JSON objects with `ok: false`, `code`, and
`message`; human-readable errors go to stderr.

### Local dashboard

`jev dashboard` serves a read-only browser view of the same telemetry and prints its URL:

```bash
jev dashboard              # http://127.0.0.1:<random port>/
jev dashboard --port 7788
```

It shows a session picker, fresh-route summary, model/effort/profile distributions, Claude
token usage with cache read/creation split and completeness, the actor tree (subagents whose
parent was not recorded, or whose parent is missing, are listed separately rather than guessed),
paginated recent routing decisions, fallbacks, and compatibility rewrites. Every chart has a
table with the exact numbers. The page refreshes every 5 seconds while its tab is visible and
keeps the last good render, marked stale, when a refresh fails.

The server binds to `127.0.0.1` only, accepts only `GET`/`HEAD`, rejects requests whose `Host`
or `Origin` is not loopback, sends no CORS headers, and opens the database read-only per
request. It serves no prompt text or credentials, and it runs independently of the daemon and
of routing. Its JSON is versioned under `/api/v1` (`status`, `sessions`, and
`sessions/<id>/summary|actors|routes|usage`); `summary` is the same document as
`jev stats --session <id> --json`. Telemetry is off by default, so the page explains how to
enable it (`JEV_ENABLE_TELEMETRY=1`) when no database exists. Stop it with Ctrl+C.

## Configuration

| Variable | Interface | Effect |
| --- | --- | --- |
| `JEV_API_KEY` | Both | Enables direct-TypeSafe routing. `TYPESAFE_API_KEY` also works. |
| `OPENROUTER_API_KEY` | Both | Enables OpenRouter routing (preferred over a TypeSafe key when both are set and `JEV_PROVIDER` is unset). |
| `JEV_PROVIDER` | Both | Forces `openrouter` or `typesafe`, instead of the automatic key-based preference. An unknown value or a missing key for the forced provider disables routing visibly rather than falling back to another key. |
| `JEV_OPENROUTER_MODEL` | Both | Jev model requested from OpenRouter; defaults to `typesafe/jev-1.13`, which OpenRouter resolves to a dated build. There is no floating `-latest` alias for Jev; naming one that does not exist disables routing silently. |
| `JEV_TIMEOUT_MS` | Both | Total wall-clock deadline for one Jev decision (request plus any retry); defaults to `1500`. A routing outage never stalls the turn longer than this. |
| `JEV_DECISION_MODE` | Claude | `profiles` (default) lets Jev choose a validated model/effort profile; `signals` maps the original model and normalized reasoning signals locally. |
| `JEV_CONFIDENCE_LOW` / `JEV_CONFIDENCE_HIGH` | Claude | Confidence boundaries; default to `0.45` / `0.80`. |
| `JEV_SUBAGENT_MIN_TIER` | Claude | Lowest tier a routed subagent may land on: `haiku`/`fast`, `sonnet`/`balanced`, `opus`/`strong`. Unset by default. Manual prompt overrides still win; the main agent is unaffected. |
| `JEV_ENABLE_EFFORT_ROUTING` | Claude | Enables effort profiles by default; set `0`/`false` for model-only profiles. |
| `JEV_CLAUDE_FAST_MODEL` / `JEV_CLAUDE_BALANCED_MODEL` / `JEV_CLAUDE_STRONG_MODEL` / `JEV_CLAUDE_LONG_MODEL` | Claude | Select an exact model from the signed-in account catalog for a tier. An unavailable override disables that tier rather than inventing availability. |
| `JEV_ALLOW_LONG_TIER` | Both | Enables the opt-in long tier. |
| `JEV_ALLOW_FABLE` | Both | Legacy alias for `JEV_ALLOW_LONG_TIER`. |
| `JEV_CAPABILITY_OVERRIDES` | Claude | Advanced JSON object keyed by an exact catalog model id. Each entry must declare `supportedEfforts` and all four thinking booleans; malformed entries are rejected. |
| `JEV_DEBUG` | Both | Logs decisions and rewrites to `~/.jev-claude.log` in interactive sessions. Accepts only `1`/`true`; `0` is off. |
| `JEV_DUMP` | Both | Dumps sanitized, content-omitted wire shapes to `~/.jev-router/dumps/<session>/<id>.json` for debugging format changes. Accepts only `1`/`true`. |
| `JEV_DUMP_CONTENT` | Both | Includes message/system/instructions text in a `JEV_DUMP` dump (still redacted for secrets). |
| `JEV_STORE_PROMPTS` | Both | Stores the exact prompt text on a routing decision; off by default (a SHA-256 hash is stored instead). |
| `JEV_STORE_PROMPT_PREVIEW` | Both | Stores a truncated, secret-scrubbed prompt preview instead of the full prompt. |
| `JEV_SUBAGENT_MODEL_POLICY` | Claude | `route` (default), `respect-explicit`, or `inherit`; see Actors, subagents, and auxiliary calls. |
| `JEV_AUXILIARY_POLICY` | Claude | `passthrough` (default), `inherit`, or `fast` for Claude Code's own tool-less auxiliary calls. |
| `JEV_ENABLE_TELEMETRY` | Claude | Records routes and usage to a local SQLite database. Off by default. |
| `JEV_DATA_DIR` | Claude | Directory for the telemetry database; defaults to `~/.jev-router`. |
| `JEV_PROXY_PORT` | Claude daemon | Exact loopback port for `jev daemon start`. An occupied or invalid explicit port fails startup. Unset uses the last successful port when available, then an OS-assigned port. |
| `JEV_VSCODE_BIN` | VS Code | `code` command used by `jev-code` and `jev vscode doctor` (default `code`). |
| `JEV_VSCODE_SETTINGS` | VS Code | Settings file `jev vscode doctor` reads (default: VS Code's user settings). |
| `JEV_TELEMETRY_RETENTION_DAYS` | Claude | Days of ended sessions to keep; defaults to `90`. An invalid value falls back to the default rather than keeping data forever. |
| `JEV_NO_STATUSLINE` | Claude | Disables the injected Claude status line. |
| `JEV_CODEX_FAST_MODEL` | Codex | Fast model; defaults to `gpt-5.6-luna`. |
| `JEV_CODEX_BALANCED_MODEL` | Codex | Balanced model; defaults to `gpt-5.6-terra`. |
| `JEV_CODEX_STRONG_MODEL` | Codex | Strong model; defaults to `gpt-5.6-sol`. |
| `JEV_CODEX_LONG_MODEL` | Codex | Long model; defaults to `gpt-6-astra`. |

Existing environment variables have highest precedence, followed by `.env` in the launch
directory, `~/.jev-router.env`, and the legacy `~/.jev-claude.env`.

Tier definitions, Jev's question, confidence thresholds, and timeouts live in `src/config.mjs`;
versioned Claude capabilities and profiles live under `src/routing/`. Both launchers use the
signed-in account's native catalog, so model versions such as `claude-opus-4-8` and
`claude-opus-5-5` remain separate choices. Static model ids are used only until the CLI fetches
its catalog.

## Compatibility notes

- Claude Code needs schema normalisation for older MCP JSON Schema fields when a custom base
  URL is active.
- Claude request transformation preserves messages, tools, metadata, beta headers, and
  unrelated `output_config` fields. Only unsupported effort/thinking fields are normalized.
- Codex's current request format stores tool definitions inside its Responses API input.
- Codex's ChatGPT backend may stream SSE without a `Content-Type` header; the proxy detects
  the event stream from its first frame.
- Codex workspace-specific enterprise origins are internal to its built-in provider and
  cannot be reproduced by a custom provider.

## Development

```bash
npm install
echo "JEV_API_KEY=..." > .env

npm test
node bin/jev-claude.mjs -p "what is 2+2?"
node bin/jev-codex.mjs exec "what is 2+2?"
```

`npm test` mocks both the upstream API and Jev, so it needs no credentials and no network. The
checks below are separate, explicitly invoked operations. Each live command refuses to run
unless you authorize it with `JEV_LIVE=1`, prints what it is about to spend before spending
it, and writes a redacted record to `~/.jev-router/live-evidence/`. `test:pack` costs nothing
but reaches the npm registry to install dependencies.

```bash
JEV_LIVE=1 OPENROUTER_API_KEY=... npm run test:live:jev-openrouter   # real routing decisions
JEV_LIVE=1 OPENROUTER_API_KEY=... npm run test:live:claude           # real Claude turn on subscription auth
JEV_LIVE=1 OPENROUTER_API_KEY=... npm run test:live:subagents        # real subagent actors
npm run test:pack                                                     # install the real tarball, run every CLI
```

The test suite covers shared policy, both request formats, model rewriting, capability
handling, settings restoration, Codex authentication forwarding, native model-picker
injection, and decision display.

See [docs/compatibility.md](docs/compatibility.md) for supported versions, configuration
migration, failure behaviour, rollback, and what remains unverified.

## Limitations

- The user's fresh task text is sent to whichever Jev provider is active (TypeSafe directly,
  or OpenRouter) for the routing decision. Full tool output and repository contents are not
  sent by default; `jev-claude` prints this when routing starts.
- The OpenRouter Decisions API is an alpha endpoint; its shape and the `typesafe/jev-1.13`
  alias have not been verified against a live account in this codebase, only against current
  published documentation. Treat OpenRouter routing as unverified until exercised with a real
  key.
- Jev adds latency only to the first request of a turn; tool-loop continuations add none.
- Telemetry's streaming usage parser is verified against synthetic Anthropic SSE fixtures
  covering chunk splits, multi-byte splits, compression, duplicate and cumulative usage
  fields, malformed events, and early closure. It has not been validated against a live
  Claude response, so a future change to Anthropic's usage fields would show up as missing
  counts rather than wrong ones (`raw_usage_json` keeps whatever was seen).
- Independent subagent routing is only as reliable as the request's actor correlation.
  Claude Code is not documented to send actor identifiers, and no captured request in this
  codebase carries them. The behavior above is covered by synthetic tests; without real
  correlation the router falls back to the conservative main-actor rule described there,
  which routes the main agent and passes unidentified actors through unrouted.
- Claude Code and Codex request formats are not public contracts. Set `JEV_DUMP=1` to diagnose
  upstream changes from sanitized wire dumps under `~/.jev-router/dumps`.
- Developed and tested on Windows against Claude Code v2.1.101 and OpenAI Codex v0.154.0.

## Contributing

Issues and pull requests are welcome. Use [Issues](https://github.com/gargpratyush/jev-router/issues)
to report bugs, request improvements, or ask questions. Include the relevant Claude Code or
Codex version, reproduction steps, expected behavior, and useful logs with secrets removed.

For a pull request:

1. Open an issue first - all PRs by contributors should be linked with an approved issue. Explain the problem and validation in the issue description.
2. Fork the repository and create a focused branch from `master`.
3. Make the smallest change that solves the problem.
4. Run `npm test` and include tests for non-trivial behavior changes.
5. Claude/Copilot/Codex shall not be the contributors. 

Please do not commit API keys or other secrets. All contributions require review, and only the
repository owner can merge pull requests.

## License

MIT

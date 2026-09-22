# `jev-claude` architecture

```mermaid
flowchart TB
  user([User]) --> command["`jev-claude`\nCLI wrapper"]

  subgraph launcher["Launcher — bin/jev-claude.mjs"]
    direction TB
    command --> env["Load environment\nprecedence: process env → .env → ~/.jev-router.env → ~/.jev-claude.env"]
    env --> find["Find `claude` executable on PATH"]
    env --> saved["Read existing ~/.claude/settings.json model\nfor later restoration"]
    find --> key{"JEV_API_KEY or\nTYPESAFE_API_KEY?"}

    key -- No --> direct["Spawn real Claude Code\nwithout routing"]
    key -- Yes --> proxyStart["Start ephemeral loopback proxy\n127.0.0.1:random-port"]
    proxyStart --> launchEnv["Set ANTHROPIC_BASE_URL to proxy\nExpose `jev-router` as Jev Router in /model\nDefault to `jev-router` unless user set ANTHROPIC_MODEL"]
    launchEnv --> statusCfg{"Status line allowed?"}
    statusCfg -- "No: JEV_NO_STATUSLINE or user statusLine" --> spawn
    statusCfg -- Yes --> statusCfgFile["Write temporary Claude status-line settings"] --> spawn
    direct --> spawn["Spawn real Claude Code\nwith original CLI arguments"]
  end

  spawn --> claude["Claude Code\n(native UI, login, tools, sessions, permissions)"]
  claude --> picker{"/model selection"}
  picker -- "Jev Router" --> auto["model: `jev-router`\n(routing sentinel)"]
  picker -- "Concrete model" --> manual["model: user-selected model"]
  auto --> loopback
  manual --> loopback

  subgraph proxy["Loopback proxy — src/proxy.mjs"]
    direction TB
    loopback["Receive HEAD or /v1/messages request"]
    loopback --> head{"HEAD probe?"}
    head -- Yes --> headOK["Return 200"]
    head -- No --> parse["Parse request body\nOptionally dump body with JEV_DUMP\nNormalize legacy MCP JSON schemas"]
    parse --> classify["Classify request — src/claude/adapter.mjs + classify.mjs\nshape: fresh / continuation / auxiliary / unknown\nread explicit actor correlation only"]
    classify --> detect["Detect actor — src/routing/actors.mjs\nexplicit actor id, else first session root as main\nelse unknown; sessions namespace all identities"]
    detect --> mode{"Classification"}

    mode -- "manual_passthrough" --> pass["Leave model unchanged\nFor identified actors, publish manual status"]
    mode -- "auxiliary" --> aux["JEV_AUXILIARY_POLICY\npassthrough / inherit / fast\nno Jev call, no pin or manual-state change"]
    mode -- "unknown" --> unknownPath["Resolve the sentinel only\nNever touch another actor's state"]
    mode -- "main_* / subagent_*" --> fresh{"Fresh boundary for this actor?"}
    fresh -- No --> pinned["Reuse the route pinned to this actor's turn\nmodel, effort, and thinking policy together"]
    fresh -- Yes --> prompt["Remove system-reminder blocks\nEstimate context tokens\nDeduplicate concurrent decisions per boundary\nJEV_SUBAGENT_MODEL_POLICY may inherit or defer"]
    prompt --> jev
    jev --> policy
    policy --> saveTier["Pin the effective route to this actor and turn"]
    saveTier --> pinned
    aux --> rewrite
    unknownPath --> forward
    pinned --> rewrite["Rewrite `jev-router` to Claude tier model ID\nStrip unsupported thinking / effort fields"]
    rewrite --> publish["Write latest tier, confidence, and reason\nto per-session temp status file"]
    publish --> telemetry["Queue route/request events\n(JEV_ENABLE_TELEMETRY=1 only)"]
    pass --> forward
    publish --> forward["Forward request to api.anthropic.com\nPreserve Claude Code authorization headers\nstream upstream response unchanged"]
  end

  subgraph routing["Routing — src/router.mjs + src/policy.mjs"]
    direction TB
    jev["TypeSafe / Jev systemOne call\nSends only fresh user prompt plus:\ncurrent tier, approximate context, available tiers"]
    policy["Policy resolves final tier\n• prompt override wins\n• failure / malformed answer: keep current\n• low confidence: no downgrade; upgrades capped at sonnet\n• large context: no downgrade that rebuilds cache\n• unavailable tier: choose nearest stronger available\n• fable requires JEV_ALLOW_FABLE=1"]
  end

  forward --> anthropic["Anthropic API"]
  anthropic --> tee

  subgraph response["Response path"]
    direction TB
    tee["Upstream response"]
    tee --> forwarded["Piped downstream unchanged\nbytes, headers, and status preserved\nearly upstream close is propagated"]
    tee --> observer["Usage observer (src/telemetry/usage.mjs)\nincremental SSE parse over a copy of the bytes\nseparate decoded path for compressed bodies\ncumulative counters are never summed"]
    observer --> writer
  end

  subgraph storage["Telemetry — src/telemetry/"]
    direction TB
    writer["Bounded queue -> worker thread\nbatched SQLite transactions\nnever on the response path"]
    writer --> sqlite["~/.jev-router/telemetry.sqlite3\nPRAGMA user_version migrations, WAL\n0700 directory / 0600 files\nretention by ended session"]
  end

  telemetry --> writer
  forwarded --> claude

  subgraph visibility["Routing visibility — status.mjs + jev-statusline.mjs"]
    direction TB
    statusFile["Temp file: $TMPDIR/jev-claude/<session>.json"]
    statusLine["Claude Code status-line command\nReads session file and renders:\n⚡ tier + confidence, or ⏸ manual"]
    statusFile --> statusLine
  end
  publish --> statusFile
  pass --> statusFile
  statusLine --> claude

  spawn --> exit["On process exit: close proxy\nand restore saved model only if it is still `jev-router`"]
```

The routing call happens only at a confirmed boundary: the first request of a main user turn, or
a newly spawned subagent task. Tool-loop continuations reuse the route pinned to their own actor,
avoiding repeated routing latency and model changes mid-task, and a subagent's route never
replaces the main agent's pin. A concrete model chosen in Claude Code bypasses routing until the
user selects **Jev Router** again.

Telemetry is off unless `JEV_ENABLE_TELEMETRY=1`. When it is on, no SQLite call happens on the
thread that forwards inference, and a telemetry failure disables telemetry rather than the
router. See the README's *Usage telemetry*.

Actor identity is only as good as the correlation the request carries. Claude Code is not
documented to send actor identifiers; when none are present the proxy establishes the session's
first inference root as the main actor and treats any other uncorrelated root as unknown rather
than splitting actors by task text. See the README's *Actors, subagents, and auxiliary calls*.

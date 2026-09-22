# VS Code compatibility

The Claude Code VS Code extension (`anthropic.claude-code`) can send its API traffic through
the Jev daemon. **That path is experimental.** A VS Code / extension combination is listed as
supported only after every step of the protocol below has passed on it, with sanitized
evidence. Until then, the reliable way to use Jev in VS Code is to run `jev-claude` in the
integrated terminal.

## Tested combinations

| Router | Claude Code CLI | VS Code | Extension | Platform | Date | Status | Routing evidence |
|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | No combination has been tested live yet. |

Status values:

- **supported**: every protocol step passed for exactly this combination.
- **experimental**: not tested, or partly tested. Routing may work, but nothing is guaranteed.
- **incompatible**: tested and found to fail, or excluded by a documented requirement (the
  extension needs VS Code 1.94.0 or later).

`jev vscode doctor` reads the same classification from `src/vscode/compatibility.mjs` and
reports it for the versions it finds.

## Two ways to point the extension at the daemon

1. **Extension settings.** Run `jev daemon start`, then `jev vscode doctor`. The doctor
   prints the entries to add to `claudeCode.environmentVariables`, an array of
   `{ "name": ..., "value": ... }` pairs. It never writes your settings and never adds an
   API key: the extension keeps using your subscription sign-in. Set `JEV_PROXY_PORT` so the
   daemon always comes back on the port your settings name. Reload the window afterwards.
2. **`jev-code`.** Starts or reuses the daemon, then opens `code` with `ANTHROPIC_BASE_URL`
   in its environment. Your arguments (folders, `--new-window`, ...) are passed through.
   **If VS Code is already running**, `code` hands the request to the existing process, and
   that process keeps the environment it started with. Close every window first, or use the
   settings instead.

Either way, a correct configuration and a healthy daemon **do not prove** that requests are
routed. The doctor reports `Routing: observed` only after the daemon has actually forwarded a
message request. That count covers the whole daemon, including terminal sessions, so check it
right after sending a message from the extension.

## Live protocol

Run this on one machine, for one VS Code / extension version pair, with a signed-in
subscription and no Anthropic API key configured. Record each step as pass, fail, or not run,
and keep the evidence free of prompts, keys, and account identifiers.

1. **Setup.** Record `jev vscode doctor --json` output: versions, daemon URL, and
   compatibility.
2. **New session.** Open a new conversation in the extension, pick the **Jev Router** model
   row, and send a small prompt. Pass when the doctor's traffic count rises and `jev routes`
   shows a decision for the new session.
3. **Independent subagents.** Ask for a task that starts a subagent. Pass when `jev routes`
   shows a separate subagent decision that does not replace the main conversation's route.
4. **Model and effort.** Change the effort level, and switch to an explicit model and back.
   Pass when explicit models pass through unrouted and the routed request keeps a valid effort.
5. **Subscription auth.** Pass when requests succeed with no `ANTHROPIC_API_KEY` set anywhere,
   and the daemon logs no authorization header.
6. **Resume and history.** Reopen an earlier conversation from history and continue it. Pass
   when continuations reuse the turn's route instead of asking Jev again.
7. **Extension restart.** Run **Developer: Reload Window**. Pass when the reloaded extension
   still uses the daemon (the traffic count rises again) and nothing points at a dead port.

A combination is **supported** only when steps 2–7 all pass. Record the result as a new row in
the table above and in `TESTED` in `src/vscode/compatibility.mjs`.

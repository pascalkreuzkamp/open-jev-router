# Wire fixture convention

Sanitized Claude Code / Codex request bodies used as regression fixtures, per the request
classification requirement (FR-013) and golden-fixture requirement. Each file is one JSON
object with this shape:

```jsonc
{
  "category": "main-fresh",       // see Categories below
  "origin": "synthetic",          // "synthetic" | "real"
  "claudeVersion": null,          // Claude Code / Codex version string; required when origin is "real"
  "captureMethod": "...",         // how this body was produced; required, always
  "expectedBehavior": { ... },    // asserted against the real functions in test/fixtures.test.mjs
  "notes": "...",                 // caveats, e.g. unverified fields, pending later-phase behavior
  "body": { ... }                 // the (sanitized) request body itself
}
```

## Rules

- `origin: "synthetic"` means hand-authored from documented API shape, README examples, or
  existing inline test literals — never presented as an observed capture.
- `origin: "real"` requires `claudeVersion`/`codexVersion` and a `captureMethod` describing
  how the body was obtained (e.g. `JEV_DUMP=1 JEV_DUMP_CONTENT=1`, redacted by hand before
  committing). A missing real capture stays a recorded evidence gap (see the overview's
  blocker B-002); nothing here is fabricated to fill that gap.
- A fixture's `body` has already been sanitized: no real prompt content, no credentials, no
  identifying repository data.

## Categories (spec §12.3)

| Category | Status this phase |
| --- | --- |
| `main-fresh` | Covered: exercised against `newTurnPrompt`. |
| `main-continuation` | Covered: exercised against `newTurnPrompt`. |
| `auxiliary` | Covered: exercised against `newTurnPrompt`. |
| `unknown-shape` | Covered: exercised against `newTurnPrompt`/`applyTier` fail-open behavior. |
| `subagent-fresh` (Explore/general) | Structural only. This codebase has no actor
  classifier yet (planned for the actor-classification phase); the fixture only documents
  that a subagent's fresh request is wire-identical to a main fresh request at this layer, so
  the future classifier cannot rely on the request shape alone. |
| `subagent-continuation` | Structural only, same caveat as above. |
| `concurrent-actors` | Structural only: two fixtures with distinct `conversationKey` inputs, used to confirm independent pinning at the `conversationKey` layer today (actor-level pinning is a later phase). |
| `subagent-return` | Covered: a `tool_result` continuation for a `Task` tool call is an
  ordinary continuation at this layer, exercised against `newTurnPrompt`. |

Live captures for the subagent categories remain pending (blocker B-002 in the overview); this
convention exists so the actor-classification phase can drop real fixtures in without
inventing a new format.

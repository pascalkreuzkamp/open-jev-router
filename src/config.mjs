// Every routing decision knob lives here, so the whole policy is reviewable in one file.
import { choice, score } from "@typesafe-ai/sdk";

/**
 * Model tiers, cheapest first. `id` is what goes into the API request body; `family` is the
 * substring used to recognise whatever model Claude Code asked for, which may be an older
 * version within the same tier such as `claude-sonnet-4-6`. The capability flags come from
 * the Agent SDK's model catalogue: Haiku supports neither adaptive thinking nor effort, so
 * those fields have to be stripped when routing down to it.
 */
export const TIERS = [
  { name: "haiku", id: "claude-haiku-4-5-20251001", family: "haiku", thinking: false, effort: false },
  { name: "sonnet", id: "claude-sonnet-5", family: "sonnet", thinking: true, effort: true },
  { name: "opus", id: "claude-opus-5-5", family: "opus", thinking: true, effort: true },
  { name: "fable", id: "claude-fable-5-1", family: "fable", thinking: true, effort: true },
];

export const TIER_NAMES = TIERS.map((t) => t.name);

export const rankOf = (name) => TIER_NAMES.indexOf(name);

export const idOf = (name) => TIERS.find((t) => t.name === name)?.id;

export const tierSpec = (name) => TIERS.find((t) => t.name === name);

/**
 * Sentinel model id offered as an extra row in Claude Code's /model picker. Claude Code
 * sends it verbatim because it does not validate model names behind a custom base URL, so
 * its presence in a request is an exact signal that the user wants this turn routed. Any
 * other model means the user picked one themselves and it must be passed straight through.
 */
export const AUTO_MODEL = "jev-router";

/** Whether a request should be routed, or passed through as the user's own choice. */
export const isAuto = (model) => model === AUTO_MODEL;

/** Tier name for a model string Claude Code sent, or null if we don't recognise it. */
export const tierOf = (model) =>
  TIERS.find((t) => typeof model === "string" && model.includes(t.family))?.name ?? null;

/**
 * Fable bills extra usage credits, so it is opt-in. Everything else is covered by a normal
 * subscription.
 */
export const availableTiers = (env = process.env) =>
  TIER_NAMES.filter(
    (n) => n !== "fable" || env.JEV_ALLOW_LONG_TIER === "1" || env.JEV_ALLOW_FABLE === "1",
  );

export const THRESHOLDS = {
  /** Below this Jev confidence we refuse to downgrade and cap upgrades at `uncertainCeiling`. */
  minConfidence: 0.45,
  highConfidence: 0.8,
  /** Safest tier to land on when Jev is unsure. */
  uncertainCeiling: "sonnet",
  /**
   * Switching models invalidates the prompt cache; the next turn re-sends the whole
   * conversation. Measured at ~23.6k cache-creation tokens switching into Opus, so a
   * downgrade only pays off while the conversation is still small.
   */
  downgradeMaxContextTokens: 20000,
  /**
   * Default total wall-clock deadline for one Jev decision (request plus any retry),
   * overridable per call via `JEV_TIMEOUT_MS`. Measured against the direct TypeSafe API:
   * ~300-350ms warm, ~900-1000ms on the first call (TLS handshake), so the default leaves
   * room for one retry after a cold-start failure without making a routing outage stall
   * the turn it was supposed to speed up.
   */
  jevTimeoutMs: 1500,
  jevMaxRetries: 1,
};

/**
 * Live `JEV_TIMEOUT_MS` override (read at call time, like `availableTiers`, so tests can set
 * it per-case) or the default above. Providers pass this as both their outer deadline and
 * their own per-attempt timeout, so a single slow attempt cannot itself exceed the deadline.
 */
export const jevTimeoutMs = (env = process.env) => {
  const configured = Number(env.JEV_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : THRESHOLDS.jevTimeoutMs;
};

/**
 * Default Jev model requested from OpenRouter; overridable via `JEV_OPENROUTER_MODEL`.
 *
 * This must name a version that exists. OpenRouter publishes no floating alias for Jev:
 * verified live on 2026-09-22, `typesafe/jev-latest`, `typesafe/jev` and `typesafe/jev-1`
 * all return HTTP 400 "Model ... does not exist", which fails open to no routing at all.
 * `typesafe/jev-1.13` is the form the Decisions API reference itself uses, and it resolves
 * server-side to a dated build (`typesafe/jev-1.13-20260917` at time of writing), so it
 * tracks fixes within the 1.13 line without being frozen to one day's snapshot.
 */
export const DEFAULT_OPENROUTER_MODEL = "typesafe/jev-1.13";

/**
 * Categories a provider adapter must sort any failure into (FR-002). `askJev` logs the
 * category and message but always returns `null` on failure — routing must fail open.
 */
export const PROVIDER_ERROR_CATEGORIES = [
  "auth_error",
  "rate_limited",
  "timeout",
  "network_error",
  "invalid_response",
  "provider_error",
  "unknown_error",
];

export const CONTEXT_WINDOW_TOKENS = 200000;

const COMPLEXITY_SCALE = [
  "None",
  "Very low",
  "Low",
  "Some",
  "Moderate",
  "Moderate to high",
  "High",
  "Very high",
  "Severe",
  "Extreme",
];

export const COMPLEXITY_MAX_SCORE = COMPLEXITY_SCALE.length - 1;

/** Phrases that mean "the human already decided", checked against the raw prompt. */
export const OVERRIDE_PATTERNS = TIERS.map((t) => ({
  tier: t.name,
  re: new RegExp(
    `\\b(?:use|switch to|with|on)\\s+(?:${{
      haiku: "haiku|fast|luna",
      sonnet: "sonnet|balanced|terra",
      opus: "opus|strong|sol",
      fable: "fable|long|astra",
    }[t.name]})\\b`,
    "i",
  ),
}));

export const QUESTIONS = {
  task_complexity: score(
    "How complex is the coding task overall, including ambiguity, scope, and blast radius?",
    COMPLEXITY_SCALE,
  ),
  reasoning_required: score(
    "How much reasoning is required to complete the request correctly in one pass?",
    COMPLEXITY_SCALE,
  ),
  tool_complexity: score(
    "How complex is the tool use required, from no tools to many coordinated or stateful operations?",
    COMPLEXITY_SCALE,
  ),
};

const GUIDANCE = {
  haiku: {
    what: "Trivial, mechanical, or purely factual work.",
    signals: ["Rename, reformat, comment, or run one obvious command"],
    not_for: "Design judgement or multi-file reasoning.",
  },
  sonnet: {
    what: "Ordinary day-to-day engineering with a clear, bounded shape.",
    signals: ["Implement a specified function, test existing behaviour, or fix an understood local bug"],
    not_for: "Open-ended architecture, subtle concurrency, or unknown-cause debugging.",
  },
  opus: {
    what: "Hard reasoning, ambiguity, or high blast radius.",
    signals: ["Unknown-cause debugging, cross-module design, security, auth, concurrency, or migrations"],
    not_for: "Routine work with a clear implementation.",
  },
  fable: {
    what: "Very large or long-running work beyond a normal focused session.",
    signals: ["Whole-repo migration, unusually large context, or multi-hour autonomous execution"],
    not_for: "Anything a strong model can finish in one focused session.",
  },
};

/** Build a Jev choice from the exact models available to this account and CLI. */
export const questionForModels = (models) =>
  choice(
    [
      "Pick the cheapest exact model that can fully complete this coding request in one pass, without retrying on a stronger model.",
      "Treat different model versions as separate choices. Judge required reasoning, not requested reply length.",
    ],
    Object.fromEntries(
      models.map(({ id, tier, description }) => [
        id,
        { model: description ?? id, ...GUIDANCE[tier] },
      ]),
    ),
  );

/** Build the preferred profile-choice question from capability-valid runtime profiles. */
export const questionForProfiles = (profiles) =>
  choice(
    [
      "Pick the cheapest model and effort profile that can fully complete this coding request in one pass.",
      "Use higher effort within a model before escalating model tier when that is sufficient.",
    ],
    Object.fromEntries(
      profiles.map((profile) => [
        profile.id,
        {
          model: profile.model,
          tier: profile.tier,
          effort: profile.effort ?? "default",
        },
      ]),
    ),
  );

/** Whether policy accepted Jev's exact model, including a version change within one tier. */
export const shouldUseExactModel = (reason, chosenTier, finalTier) =>
  (reason === "jev" || reason === "jev/no-change") && chosenTier === finalTier;

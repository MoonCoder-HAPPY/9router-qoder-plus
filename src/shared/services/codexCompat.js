/**
 * Codex compatibility settings — the single source of truth for the thresholds
 * and switches that make Codex behave well against non-OpenAI upstreams.
 *
 * Codex derives its auto-compaction trigger from the model metadata it reads
 * from `GET /v1/models` (`auto_compact_token_limit`), and it estimates the
 * prompt size with its own tokenizer, which under-counts CJK-heavy contexts.
 * We therefore keep the window truthful but pull the compaction threshold
 * below it, so Codex compacts losslessly before the upstream rejects the call.
 *
 * Qoder's per-model `max_input_tokens` is not trustworthy: it reports 180k for
 * models that serve a 1M window, and the values drift between catalog fetches.
 * Every Qoder model is therefore described with one window
 * (`QODER_CONTEXT_WINDOW`) and one compaction threshold (90% of it), so the
 * client and this router always agree on where compaction starts. The upstream
 * value is still forwarded verbatim inside the provider request — it only stops
 * being used for planning.
 *
 * Nothing else in the codebase may hardcode these numbers (spec.md §15.1).
 */

/**
 * Unified context window for every Qoder model. See the note above for why the
 * upstream per-model `max_input_tokens` is deliberately not used here.
 */
export const QODER_CONTEXT_WINDOW = 1_000_000;

export const FIRST_TOKEN_TIMEOUT_FALLBACK = Object.freeze({
  ACCOUNT_THEN_BUDGET: "account-then-budget",
  BUDGET_ONLY: "budget-only",
  OFF: "off",
});

export const CODEX_COMPAT_DEFAULTS = Object.freeze({
  // 90% of QODER_CONTEXT_WINDOW (1M) => a 900K compaction line. Codex validates
  // the advertised limit and compacts there, so the client and this router share
  // one threshold instead of disagreeing by hundreds of thousands of tokens.
  autoCompactRatio: 0.9,
  autoCompactMin: 120000,
  // Must stay at or above the largest window we advertise, otherwise the bound
  // would silently pull the 900K line back down (the old 500K value did exactly
  // that and compacted 1M models at half their usable window).
  autoCompactMax: 1_000_000,
  proactiveContextGuard: true,
  autoContinueMax: 1,
  firstTokenTimeoutFallback: FIRST_TOKEN_TIMEOUT_FALLBACK.ACCOUNT_THEN_BUDGET,
  rateLimitRetryAfterCapMs: 120000,
});

const FALLBACK_VALUES = new Set(Object.values(FIRST_TOKEN_TIMEOUT_FALLBACK));

function clampNumber(value, fallback, { min, max }) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/**
 * Validate and normalize user-provided settings. Unknown fields are dropped so
 * a stale dashboard payload cannot smuggle values into other settings.
 */
export function normalizeCodexCompatSettings(input = {}) {
  const raw = input?.codexCompat && typeof input.codexCompat === "object" ? input.codexCompat : input;
  const source = raw && typeof raw === "object" ? raw : {};

  const ratio = clampNumber(source.autoCompactRatio, CODEX_COMPAT_DEFAULTS.autoCompactRatio, { min: 0.05, max: 1 });
  const min = Math.round(clampNumber(source.autoCompactMin, CODEX_COMPAT_DEFAULTS.autoCompactMin, { min: 1000, max: 10_000_000 }));
  const max = Math.round(clampNumber(source.autoCompactMax, CODEX_COMPAT_DEFAULTS.autoCompactMax, { min, max: 10_000_000 }));
  const autoContinueMax = Math.round(clampNumber(source.autoContinueMax, CODEX_COMPAT_DEFAULTS.autoContinueMax, { min: 0, max: 5 }));
  const rateLimitRetryAfterCapMs = Math.round(
    clampNumber(source.rateLimitRetryAfterCapMs, CODEX_COMPAT_DEFAULTS.rateLimitRetryAfterCapMs, { min: 1000, max: 600000 }),
  );
  const fallbackRaw = typeof source.firstTokenTimeoutFallback === "string" ? source.firstTokenTimeoutFallback.trim() : "";
  const firstTokenTimeoutFallback = FALLBACK_VALUES.has(fallbackRaw)
    ? fallbackRaw
    : CODEX_COMPAT_DEFAULTS.firstTokenTimeoutFallback;

  return {
    autoCompactRatio: ratio,
    autoCompactMin: min,
    autoCompactMax: max,
    proactiveContextGuard: source.proactiveContextGuard !== false,
    autoContinueMax,
    firstTokenTimeoutFallback,
    rateLimitRetryAfterCapMs,
  };
}

/**
 * Auto-compaction threshold advertised to Codex for one model.
 * Never exceeds the given window, even when the configured minimum is larger
 * than a small context model.
 *
 * Callers describing a Qoder model pass `QODER_CONTEXT_WINDOW` rather than the
 * upstream's own `max_input_tokens`, so every Qoder model advertises the same
 * 900K line and Codex compacts there instead of at a stale per-model number.
 */
export function computeAutoCompactLimit(contextWindow, settings = CODEX_COMPAT_DEFAULTS) {
  const window = Number(contextWindow);
  if (!Number.isFinite(window) || window <= 0) return null;
  const cfg = normalizeCodexCompatSettings(settings);
  const ratioLimit = window * cfg.autoCompactRatio;
  const bounded = Math.min(cfg.autoCompactMax, Math.max(cfg.autoCompactMin, ratioLimit));
  return Math.round(Math.min(window, bounded));
}

/** Read the persisted settings (dashboard-editable) with defaults applied. */
export async function getCodexCompatSettings() {
  try {
    const { getSettings } = await import("@/lib/localDb");
    const settings = await getSettings();
    return normalizeCodexCompatSettings(settings?.codexCompat ?? {});
  } catch {
    return normalizeCodexCompatSettings({});
  }
}
/**
 * Codex compatibility policy — the single source of truth for the thresholds
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
 * The Qoder window and threshold are fixed rather than user-configurable. This
 * prevents persisted dashboard values from making the client and router plan
 * against different limits.
 */

import {
  CODEX_COMPAT_DEFAULTS,
  FIRST_TOKEN_TIMEOUT_FALLBACK,
  QODER_AUTO_COMPACT_TOKEN_LIMIT,
  QODER_CONTEXT_WINDOW,
} from "../constants/codexCompat.js";

export {
  CODEX_COMPAT_DEFAULTS,
  FIRST_TOKEN_TIMEOUT_FALLBACK,
  QODER_AUTO_COMPACT_TOKEN_LIMIT,
  QODER_CONTEXT_WINDOW,
};

const FALLBACK_VALUES = new Set(Object.values(FIRST_TOKEN_TIMEOUT_FALLBACK));

function clampNumber(value, fallback, { min, max }) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/**
 * Normalize persisted settings. Context-policy fields always resolve to the
 * fixed Qoder values; unrelated retry controls remain configurable.
 */
export function normalizeCodexCompatSettings(input = {}) {
  const raw = input?.codexCompat && typeof input.codexCompat === "object" ? input.codexCompat : input;
  const source = raw && typeof raw === "object" ? raw : {};

  const autoContinueMax = Math.round(clampNumber(source.autoContinueMax, CODEX_COMPAT_DEFAULTS.autoContinueMax, { min: 0, max: 5 }));
  const rateLimitRetryAfterCapMs = Math.round(
    clampNumber(source.rateLimitRetryAfterCapMs, CODEX_COMPAT_DEFAULTS.rateLimitRetryAfterCapMs, { min: 1000, max: 600000 }),
  );
  const fallbackRaw = typeof source.firstTokenTimeoutFallback === "string" ? source.firstTokenTimeoutFallback.trim() : "";
  const firstTokenTimeoutFallback = FALLBACK_VALUES.has(fallbackRaw)
    ? fallbackRaw
    : CODEX_COMPAT_DEFAULTS.firstTokenTimeoutFallback;

  return {
    autoCompactRatio: CODEX_COMPAT_DEFAULTS.autoCompactRatio,
    autoCompactMin: CODEX_COMPAT_DEFAULTS.autoCompactMin,
    autoCompactMax: CODEX_COMPAT_DEFAULTS.autoCompactMax,
    proactiveContextGuard: true,
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

/** Fixed context policy shared by Qoder routing, Codex metadata, and UI. */
export const QODER_CONTEXT_WINDOW = 1_000_000;
export const QODER_AUTO_COMPACT_TOKEN_LIMIT = 900_000;

export const FIRST_TOKEN_TIMEOUT_FALLBACK = Object.freeze({
  ACCOUNT_THEN_BUDGET: "account-then-budget",
  BUDGET_ONLY: "budget-only",
  OFF: "off",
});

export const CODEX_COMPAT_DEFAULTS = Object.freeze({
  autoCompactRatio: QODER_AUTO_COMPACT_TOKEN_LIMIT / QODER_CONTEXT_WINDOW,
  autoCompactMin: 120_000,
  autoCompactMax: QODER_CONTEXT_WINDOW,
  proactiveContextGuard: true,
  autoContinueMax: 1,
  firstTokenTimeoutFallback: FIRST_TOKEN_TIMEOUT_FALLBACK.ACCOUNT_THEN_BUDGET,
  rateLimitRetryAfterCapMs: 120_000,
});

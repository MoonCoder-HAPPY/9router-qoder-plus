// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  // 9router-fix: Qoder "queued" 403s that escape the executor-level retry
  // (queue longer than maxAttempts) are transient — short exponential
  // backoff instead of the generic 2-minute 403 lockout. Text rules are
  // matched before status rules, so this wins over { status: 403 }.
  { text: "isqueued",               backoff: true },
  // 9router-fix: payload-level rejections are NOT account faults. Retrying the
  // same oversized/invalid body against the next account only walks (and locks)
  // the whole pool, so these short-circuit the fallback loop. Matched before the
  // status rules below and before the generic transient default.
  { text: "maximum context length",  noFallback: true },
  { text: "range of input length",   noFallback: true },
  { text: "context_length_exceeded", noFallback: true },
  { text: "prompt is too long",      noFallback: true },
  { text: "input is too long",       noFallback: true },
  { text: "reduce the length",       noFallback: true },
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  // 400 = the request body itself was rejected (bad history, over-context,
  // moderation). Another account would reject it identically, so don't rotate.
  { status: 400, noFallback: true },
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};

// ── Codex-facing error semantics ────────────────────────────────────────────
// Codex only reacts to a small set of `error.code` values (codex-api/src/sse/
// responses.rs): it auto-compacts on context_length_exceeded, backs off on
// rate_limit_exceeded (parsing "try again in <n> seconds" out of the message),
// and treats everything else as a generic retryable stream error. Emitting the
// right code is therefore the difference between "self-healing" and "the user
// sees a raw upstream error".
export const CODEX_ERROR_CODES = Object.freeze({
  CONTEXT_LENGTH_EXCEEDED: "context_length_exceeded",
  INSUFFICIENT_QUOTA: "insufficient_quota",
  RATE_LIMIT_EXCEEDED: "rate_limit_exceeded",
  SERVER_IS_OVERLOADED: "server_is_overloaded",
  INVALID_PROMPT: "invalid_prompt",
});

/** Upper bound applied to any retry hint we hand to a client (spec §11.4). */
export const RATE_LIMIT_RETRY_AFTER_CAP_MS = 120000;

export function clampRetryAfterMs(value, cap = RATE_LIMIT_RETRY_AFTER_CAP_MS) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(Math.round(ms), cap);
}

const CONTEXT_PATTERNS = /context length|context window|context_length_exceeded|maximum context|range of input length|input is too long|prompt is too long|too many tokens|reduce the length/i;
const QUOTA_PATTERNS = /quota exhausted|quota exceeded|insufficient_quota|allocation exhausted|insufficient credits|no remaining credits|out of credits/i;
const RATE_LIMIT_PATTERNS = /rate limit|isqueued|10605|too many requests|slow down|429/i;
const OVERLOAD_PATTERNS = /overloaded|over capacity|first token timeout|upstream model timeout|upstream timeout|service unavailable|503|504/i;
const INVALID_PATTERNS = /invalid_request|improperly formed|bad request|unprocessable|missing field|400/i;

/**
 * Map an upstream/HTTP failure onto the code Codex understands.
 * Order matters: the most actionable classification wins.
 * Returns "" when nothing matches, so callers keep their own default code.
 */
export function resolveCodexErrorCode({ status = null, message = "", fallbackCode = "" } = {}) {
  const text = String(message || "");
  if (CONTEXT_PATTERNS.test(text)) return CODEX_ERROR_CODES.CONTEXT_LENGTH_EXCEEDED;
  if (QUOTA_PATTERNS.test(text)) return CODEX_ERROR_CODES.INSUFFICIENT_QUOTA;
  if (RATE_LIMIT_PATTERNS.test(text)) return CODEX_ERROR_CODES.RATE_LIMIT_EXCEEDED;
  if (OVERLOAD_PATTERNS.test(text)) return CODEX_ERROR_CODES.SERVER_IS_OVERLOADED;
  if (INVALID_PATTERNS.test(text)) return CODEX_ERROR_CODES.INVALID_PROMPT;

  const statusCode = Number(status);
  if (statusCode === 429 || statusCode === 402) return CODEX_ERROR_CODES.RATE_LIMIT_EXCEEDED;
  if (statusCode === 400 || statusCode === 422) return CODEX_ERROR_CODES.INVALID_PROMPT;
  if (statusCode === 503 || statusCode === 504) return CODEX_ERROR_CODES.SERVER_IS_OVERLOADED;
  return fallbackCode;
}

/** Codex parses the delay out of the message text, not out of a header. */
export function withRetryAfterHint(message, retryAfterMs) {
  const ms = clampRetryAfterMs(retryAfterMs);
  if (!ms) return message;
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${String(message || "").replace(/\s+$/, "")} Please try again in ${seconds} seconds.`;
}
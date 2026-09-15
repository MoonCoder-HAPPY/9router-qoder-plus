/**
 * Proactive context admission.
 *
 * Codex estimates the prompt with its own tokenizer, which under-counts
 * CJK-heavy conversations, so a session can reach the upstream ceiling while
 * Codex still believes it has room. The result observed in production was a
 * hard "maximum context length" 400 after tens of seconds of upstream work.
 *
 * This module estimates the prompt locally and, when it is already past the
 * model's auto-compaction threshold, lets the router answer immediately with
 * `context_length_exceeded` so Codex compacts losslessly and retries. No
 * upstream call is made and no tokens are billed for the rejected attempt.
 *
 * The estimator is deliberately pessimistic (spec: "宁可早压，不可晚压").
 */

const CJK_PATTERN = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

const REJECTION_WINDOW_MS = 60000;
const MAX_CONSECUTIVE_REJECTIONS = 3;
const SAFETY_FACTOR = 1.1;

/** Conservative token estimate for a string (or JSON-serialisable value). */
export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (!text) return 0;
  const cjk = (text.match(CJK_PATTERN) || []).length;
  const rest = Math.max(0, text.length - cjk);
  return Math.ceil(cjk * 1.7 + rest * 0.4) + 8;
}

/** Estimate a full chat request, including tool schemas and the answer budget. */
export function estimateRequestTokens(body) {
  if (!body || typeof body !== "object") return 0;
  let total = estimateTokens(body.system || "");
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    total += estimateTokens(message?.content) + 6;
    if (message?.tool_calls) total += estimateTokens(message.tool_calls) + 6;
  }
  if (body.tools) total += estimateTokens(body.tools);
  if (Number.isFinite(Number(body.max_tokens))) total += Number(body.max_tokens);
  return Math.ceil(total * SAFETY_FACTOR);
}

/**
 * Decide whether the request may go upstream.
 * Returns { allowed, reason, limit, estimatedTokens }.
 */
export function evaluateContextAdmission({
  estimatedTokens,
  contextWindow,
  settings = {},
  recentRejections = 0,
  maxConsecutiveRejections = MAX_CONSECUTIVE_REJECTIONS,
  autoCompactLimit = null,
} = {}) {
  const estimated = Math.max(0, Number(estimatedTokens) || 0);
  if (settings.proactiveContextGuard !== true) {
    return { allowed: true, reason: "guard-disabled", estimatedTokens: estimated, limit: null };
  }
  const window = Number(contextWindow);
  if (!Number.isFinite(window) || window <= 0) {
    return { allowed: true, reason: "no-window", estimatedTokens: estimated, limit: null };
  }
  const limit = Number.isFinite(Number(autoCompactLimit)) && Number(autoCompactLimit) > 0
    ? Math.min(Number(autoCompactLimit), window)
    : window;
  // A client that keeps retrying the same oversized prompt must not be trapped in a
  // reject loop; after the cap we let the upstream decide (and report honestly).
  if (recentRejections >= maxConsecutiveRejections) {
    return { allowed: true, reason: "rejection-cap", estimatedTokens: estimated, limit };
  }
  if (estimated > limit) {
    return { allowed: false, reason: "context-window", estimatedTokens: estimated, limit };
  }
  return { allowed: true, reason: "within-limit", estimatedTokens: estimated, limit };
}

const rejections = globalThis.__qoderContextRejections ??= new Map();

function prune(now) {
  for (const [key, entry] of rejections) {
    if (now - entry.lastAt > REJECTION_WINDOW_MS) rejections.delete(key);
  }
}

/** Count recent proactive rejections for one client/account+model pair. */
export function recentContextRejections(key, now = Date.now()) {
  if (!key) return 0;
  prune(now);
  return rejections.get(key)?.count ?? 0;
}

export function noteContextRejection(key, now = Date.now()) {
  if (!key) return;
  prune(now);
  const entry = rejections.get(key);
  if (entry) {
    entry.count += 1;
    entry.lastAt = now;
  } else {
    rejections.set(key, { count: 1, lastAt: now });
  }
}

export function clearContextRejections(key) {
  if (key) rejections.delete(key);
}

export const CONTEXT_REJECTION_WINDOW_MS = REJECTION_WINDOW_MS;
export const MAX_CONTEXT_REJECTIONS = MAX_CONSECUTIVE_REJECTIONS;
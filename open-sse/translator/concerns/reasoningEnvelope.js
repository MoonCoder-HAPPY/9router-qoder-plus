/**
 * Reasoning envelope for Codex (`encrypted_content`).
 *
 * Codex asks for `include: ["reasoning.encrypted_content"]` and echoes the
 * opaque blob back on the next turn, which is how reasoning continuity works
 * for `store: false` sessions. We cannot mint OpenAI's ciphertext, so we emit a
 * self-describing envelope instead: it carries no chain-of-thought text and no
 * credentials, only enough metadata to validate what we are given back.
 *
 * Shape: base64url(JSON { v, model, ts, coh, len })
 *   v    envelope version
 *   coh  sha256(summary text) truncated to 16 hex chars — integrity, not secrecy
 *   len  summary length, so a truncated/forged blob is detectable
 */

import { createHash } from "crypto";

export const REASONING_ENVELOPE_VERSION = 1;

export function reasoningSummaryHash(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex").slice(0, 16);
}

export function buildReasoningEncryptedContent({ model = null, text = "", now = Date.now() } = {}) {
  const summary = String(text ?? "");
  const payload = {
    v: REASONING_ENVELOPE_VERSION,
    model: model ? String(model) : null,
    ts: Number(now),
    coh: reasoningSummaryHash(summary),
    len: summary.length,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Parse our own envelope. Anything that is not ours (OpenAI ciphertext, a
 * truncated blob, plain junk) returns null so callers can degrade safely.
 */
export function parseReasoningEncryptedContent(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.v !== REASONING_ENVELOPE_VERSION) return null;
    if (typeof parsed.coh !== "string" || parsed.coh.length !== 16) return null;
    if (!Number.isFinite(Number(parsed.ts))) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** True when the (untruncated) summary matches the hash carried in the blob. */
export function reasoningEnvelopeMatches(value, text) {
  const parsed = parseReasoningEncryptedContent(value);
  if (!parsed) return false;
  if (Number(parsed.len) !== String(text ?? "").length) return false;
  return parsed.coh === reasoningSummaryHash(text);
}
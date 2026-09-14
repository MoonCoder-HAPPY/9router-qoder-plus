import { describe, expect, it } from "vitest";

import {
  CODEX_ERROR_CODES,
  RATE_LIMIT_RETRY_AFTER_CAP_MS,
  clampRetryAfterMs,
  resolveCodexErrorCode,
  withRetryAfterHint,
} from "../../open-sse/config/errorConfig.js";
import { buildErrorBody } from "../../open-sse/utils/error.js";

describe("Codex error code mapping", () => {
  it("classifies every failure family Codex reacts to", () => {
    expect(resolveCodexErrorCode({ status: 400, message: "This model's maximum context length is 1048576 tokens" }))
      .toBe(CODEX_ERROR_CODES.CONTEXT_LENGTH_EXCEEDED);
    expect(resolveCodexErrorCode({ status: 429, message: "API key quota exhausted for qoder" }))
      .toBe(CODEX_ERROR_CODES.INSUFFICIENT_QUOTA);
    expect(resolveCodexErrorCode({ status: 403, message: "isQueued true 10605" }))
      .toBe(CODEX_ERROR_CODES.RATE_LIMIT_EXCEEDED);
    expect(resolveCodexErrorCode({ status: 504, message: "First Token Timeout or Upstream Timeout" }))
      .toBe(CODEX_ERROR_CODES.SERVER_IS_OVERLOADED);
    expect(resolveCodexErrorCode({ status: 400, message: "improperly formed request" }))
      .toBe(CODEX_ERROR_CODES.INVALID_PROMPT);
  });

  it("falls back to status, then to the caller's default, never inventing a code", () => {
    expect(resolveCodexErrorCode({ status: 400, message: "something odd" })).toBe(CODEX_ERROR_CODES.INVALID_PROMPT);
    expect(resolveCodexErrorCode({ status: 500, message: "something odd", fallbackCode: "upstream_error" })).toBe("upstream_error");
    expect(resolveCodexErrorCode({ status: 200, message: "" })).toBe("");
  });

  it("clamps retry hints so an upstream cannot lock a client for hours", () => {
    expect(clampRetryAfterMs(500000)).toBe(RATE_LIMIT_RETRY_AFTER_CAP_MS);
    expect(clampRetryAfterMs(3000)).toBe(3000);
    expect(clampRetryAfterMs(0)).toBeNull();
    expect(withRetryAfterHint("rate limited", 500000)).toMatch(/try again in 120 seconds/);
    // Codex parses this phrasing; the cap must survive it.
    expect(withRetryAfterHint("", 60000)).toMatch(/try again in 60 seconds/);
  });
});

describe("buildErrorBody carries Codex-visible codes", () => {
  it("reports context overflow so Codex compacts instead of looping", () => {
    const body = buildErrorBody(400, "[400]: qoder/dfmodel: maximum context length exceeded (reduce the length)");
    expect(body.error.code).toBe("context_length_exceeded");
  });

  it("reports quota exhaustion distinctly from rate limiting", () => {
    expect(buildErrorBody(429, "API key quota exhausted for qoder").error.code).toBe("insufficient_quota");
    expect(buildErrorBody(429, "too many requests, slow down").error.code).toBe("rate_limit_exceeded");
  });

  it("appends a clamped retry hint only for rate limiting", () => {
    const limited = buildErrorBody(429, "upstream rate limit", { retryAfterMs: 900000 });
    expect(limited.error.message).toMatch(/try again in 120 seconds/);
    const overloaded = buildErrorBody(504, "first token timeout", { retryAfterMs: 900000 });
    expect(overloaded.error.message).not.toMatch(/try again in/);
    expect(overloaded.error.code).toBe("server_is_overloaded");
  });

  it("keeps the legacy code when nothing matches (other clients unchanged)", () => {
    const body = buildErrorBody(500, "unexpected kaboom");
    expect(body.error.code).toBe("internal_server_error");
    expect(body.error.type).toBe("server_error");
  });
});
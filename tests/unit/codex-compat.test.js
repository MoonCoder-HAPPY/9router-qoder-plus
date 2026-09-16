import { describe, expect, it } from "vitest";

import {
  CODEX_COMPAT_DEFAULTS,
  QODER_CONTEXT_WINDOW,
  computeAutoCompactLimit,
  normalizeCodexCompatSettings,
} from "../../src/shared/services/codexCompat.js";

describe("codexCompat settings", () => {
  it("applies documented defaults when nothing is configured", () => {
    const cfg = normalizeCodexCompatSettings({});
    expect(cfg).toEqual({
      autoCompactRatio: 0.9,
      autoCompactMin: 120000,
      autoCompactMax: 1000000,
      proactiveContextGuard: true,
      autoContinueMax: 1,
      firstTokenTimeoutFallback: "account-then-budget",
      rateLimitRetryAfterCapMs: 120000,
    });
    expect(CODEX_COMPAT_DEFAULTS.proactiveContextGuard).toBe(true);
  });

  it("accepts a settings payload wrapped in codexCompat and rejects bad values", () => {
    const cfg = normalizeCodexCompatSettings({
      codexCompat: {
        autoCompactRatio: 5,
        autoCompactMin: -10,
        autoCompactMax: "nope",
        autoContinueMax: 99,
        firstTokenTimeoutFallback: "something-else",
        rateLimitRetryAfterCapMs: 10 ** 9,
        proactiveContextGuard: false,
      },
    });
    expect(cfg.autoCompactRatio).toBe(0.9);
    expect(cfg.autoCompactMin).toBe(120000);
    expect(cfg.autoCompactMax).toBe(CODEX_COMPAT_DEFAULTS.autoCompactMax);
    expect(cfg.autoContinueMax).toBe(5);
    expect(cfg.firstTokenTimeoutFallback).toBe("account-then-budget");
    expect(cfg.rateLimitRetryAfterCapMs).toBe(600000);
    expect(cfg.proactiveContextGuard).toBe(true);
  });

  it("computes a threshold below the real window for large contexts", () => {
    // 90% of the unified Qoder window: compact at 900K, not at half the window.
    expect(computeAutoCompactLimit(QODER_CONTEXT_WINDOW)).toBe(900000);
    expect(computeAutoCompactLimit(1000000)).toBe(900000);
    expect(computeAutoCompactLimit(180000)).toBe(162000);
  });

  it("never bounds the unified window below its own ratio", () => {
    // autoCompactMax must not pull the 900K line down, which is exactly what the
    // old 500000 bound did to a 1M window.
    expect(CODEX_COMPAT_DEFAULTS.autoCompactMax).toBeGreaterThanOrEqual(QODER_CONTEXT_WINDOW);
    expect(computeAutoCompactLimit(QODER_CONTEXT_WINDOW)).toBeGreaterThan(500000);
  });

  it("never exceeds the model's own window for small models", () => {
    expect(computeAutoCompactLimit(32000)).toBe(32000);
    expect(computeAutoCompactLimit(0)).toBeNull();
    expect(computeAutoCompactLimit(null)).toBeNull();
  });

  it("keeps the Qoder policy fixed even when persisted settings request another window policy", () => {
    const requested = normalizeCodexCompatSettings({
      autoCompactRatio: 0.2,
      autoCompactMin: 10_000,
      autoCompactMax: 200_000,
      proactiveContextGuard: false,
    });
    expect(requested.autoCompactRatio).toBe(0.9);
    expect(requested.autoCompactMax).toBe(1_000_000);
    expect(requested.proactiveContextGuard).toBe(true);
    expect(computeAutoCompactLimit(QODER_CONTEXT_WINDOW, requested)).toBe(900_000);
  });
});

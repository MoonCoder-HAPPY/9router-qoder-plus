import { describe, expect, it } from "vitest";

import {
  CODEX_COMPAT_DEFAULTS,
  computeAutoCompactLimit,
  normalizeCodexCompatSettings,
} from "../../src/shared/services/codexCompat.js";

describe("codexCompat settings", () => {
  it("applies documented defaults when nothing is configured", () => {
    const cfg = normalizeCodexCompatSettings({});
    expect(cfg).toEqual({
      autoCompactRatio: 0.5,
      autoCompactMin: 120000,
      autoCompactMax: 500000,
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
    expect(cfg.autoCompactRatio).toBe(1);
    expect(cfg.autoCompactMin).toBe(1000);
    expect(cfg.autoCompactMax).toBe(CODEX_COMPAT_DEFAULTS.autoCompactMax);
    expect(cfg.autoContinueMax).toBe(5);
    expect(cfg.firstTokenTimeoutFallback).toBe("account-then-budget");
    expect(cfg.rateLimitRetryAfterCapMs).toBe(600000);
    expect(cfg.proactiveContextGuard).toBe(false);
  });

  it("computes a threshold below the real window for large contexts", () => {
    expect(computeAutoCompactLimit(1000000)).toBe(500000);
    expect(computeAutoCompactLimit(180000)).toBe(120000);
  });

  it("never exceeds the model's own window for small models", () => {
    expect(computeAutoCompactLimit(32000)).toBe(32000);
    expect(computeAutoCompactLimit(0)).toBeNull();
    expect(computeAutoCompactLimit(null)).toBeNull();
  });

  it("honours overrides for ratio and bounds", () => {
    expect(computeAutoCompactLimit(1000000, { autoCompactRatio: 0.6, autoCompactMin: 150000, autoCompactMax: 600000 })).toBe(600000);
    expect(computeAutoCompactLimit(400000, { autoCompactRatio: 0.6, autoCompactMin: 150000, autoCompactMax: 600000 })).toBe(240000);
  });
});
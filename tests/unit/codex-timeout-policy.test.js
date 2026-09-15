import { describe, expect, it } from "vitest";

import { resolveTimeoutPolicy, __test__ } from "../../open-sse/executors/qoder.js";
import { unsupportedPreviousResponseIdError } from "../../open-sse/utils/unsupportedFeatures.js";

describe("first-token 504 policy", () => {
  it("defaults to account-then-budget: one quick retry, then the extended budget", () => {
    const policy = resolveTimeoutPolicy({});
    expect(policy.strategy).toBe("account-then-budget");
    expect(policy.timeoutOptions.maxAttempts).toBe(4); // 1 quick + 3 extended
    expect(policy.timeoutOptions.delayFor(1)).toBe(3000);
    expect(policy.timeoutOptions.delayFor(2)).toBe(6000);
    expect(policy.timeoutOptions.delayFor(3)).toBe(12000);
  });

  it("budget-only skips the quick retry and waits longer per attempt", () => {
    const policy = resolveTimeoutPolicy({ firstTokenTimeoutFallback: "budget-only" });
    expect(policy.strategy).toBe("budget-only");
    expect(policy.timeoutOptions.delayFor(1)).toBe(6000);
    expect(policy.timeoutOptions.delayFor(2)).toBe(12000);
  });

  it("off keeps the legacy env-driven ladder untouched", () => {
    const policy = resolveTimeoutPolicy({ firstTokenTimeoutFallback: "off" });
    expect(policy.strategy).toBe("off");
    expect(policy.timeoutOptions.delayFor).toBeUndefined();
    expect(policy.timeoutOptions.maxAttempts).toBeGreaterThan(0);
  });

  it("never downgrades the model: the policy only changes waiting, not the request", () => {
    const policy = resolveTimeoutPolicy({ firstTokenTimeoutFallback: "account-then-budget" });
    expect(Object.keys(policy.timeoutOptions)).not.toContain("model");
    expect(Object.keys(policy.timeoutOptions)).not.toContain("forceModel");
  });
});

describe("unsupported previous_response_id", () => {
  it("rejects with invalid_prompt for providers we do not implement resumption for", () => {
    const error = unsupportedPreviousResponseIdError({ previous_response_id: "resp_123" }, "qoder");
    expect(error).toMatchObject({ status: 400, code: "invalid_prompt" });
    expect(error.message).toContain("previous_response_id is not supported");
  });

  it("stays out of the way for providers that own the semantics", () => {
    expect(unsupportedPreviousResponseIdError({ previous_response_id: "resp_123" }, "openai")).toBeNull();
    expect(unsupportedPreviousResponseIdError({ previous_response_id: "resp_123" }, "codex")).toBeNull();
  });

  it("ignores empty or absent ids", () => {
    expect(unsupportedPreviousResponseIdError({}, "qoder")).toBeNull();
    expect(unsupportedPreviousResponseIdError({ previous_response_id: "   " }, "qoder")).toBeNull();
    expect(unsupportedPreviousResponseIdError(null, "qoder")).toBeNull();
  });
});
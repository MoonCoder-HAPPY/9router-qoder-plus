import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: vi.fn(async () => null),
  appendRequestLog: vi.fn(async () => null),
  saveRequestDetail: vi.fn(async () => null),
  recordApiKeyQoderCreditUsage: vi.fn(async () => null),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: {
    reset: "",
    green: "",
  },
}));

import {
  normalizeUsage,
  canonicalizeUsage,
  mergeUsage,
  extractUsage,
} from "../../open-sse/utils/usageTracking.js";
import { extractUsageFromResponse, saveUsageStats } from "../../open-sse/handlers/chatCore/requestDetail.js";

describe("Qoder usage credits", () => {
  it("keeps credits through normalization and canonicalization", () => {
    const normalized = normalizeUsage({
      prompt_tokens: 10,
      completion_tokens: 20,
      credits: 0.125,
      original_credits: 0.25,
    });

    expect(normalized.credits).toBe(0.125);
    expect(canonicalizeUsage(normalized)).toMatchObject({
      credits: 0.125,
      original_credits: 0.25,
    });
  });

  it("merges and extracts credits from an OpenAI usage frame", () => {
    const usage = extractUsage({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        credits: 0.125,
        original_credits: 0.25,
      },
    });

    expect(usage).toMatchObject({ credits: 0.125, original_credits: 0.25 });
    expect(mergeUsage(usage, { credits: 0.2 })).toMatchObject({ credits: 0.2 });
  });

  it("keeps credits in non-stream response extraction", () => {
    expect(extractUsageFromResponse({
      usage: {
        prompt_tokens: 1,
        completion_tokens: 2,
        credits: 0.01,
        original_credits: 0.02,
      },
    })).toMatchObject({ credits: 0.01, original_credits: 0.02 });
  });

  it("records exact credits against the API key and connection", async () => {
    const db = await import("@/lib/usageDb.js");
    saveUsageStats({
      provider: "qoder",
      model: "auto",
      tokens: {
        prompt_tokens: 10,
        completion_tokens: 20,
        credits: 1.25,
        original_credits: 2,
      },
      connectionId: "conn-a",
      apiKey: "sk-test",
      silent: true,
    });

    expect(db.recordApiKeyQoderCreditUsage).toHaveBeenCalledWith(
      "sk-test",
      "conn-a",
      1.25,
    );
  });
});

import { describe, expect, it } from "vitest";
import { resolveRequestModalityCapabilities } from "../../open-sse/handlers/chatCore/routing.js";
import { __test__ as qoderInternals } from "../../open-sse/executors/qoder.js";

describe("Qoder multimodal routing", () => {
  it("allows images for Qoder without changing other modality flags", () => {
    expect(resolveRequestModalityCapabilities("qoder", {
      vision: false,
      audioInput: true,
      pdf: false,
    })).toEqual({
      vision: true,
      audioInput: true,
      pdf: false,
    });
  });

  it("leaves non-Qoder capabilities unchanged", () => {
    const caps = { vision: false, audioInput: true, pdf: false };
    expect(resolveRequestModalityCapabilities("ollama", caps)).toBe(caps);
  });

  it("normalizes translated image input for a Qoder vision model", () => {
    const result = qoderInternals.normalizeMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ]);
    const modelConfig = qoderInternals.validateQoderImageSupport({
      modelConfig: { key: "vision-model", is_vl: true },
      imageCount: result.imageCount,
    });

    expect(result.imageCount).toBe(1);
    expect(result.messages[0].contents[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAA" },
    });
    expect(modelConfig.is_vl).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { supportsQoderImageInput } from "../../open-sse/shared/qoder/vision.js";

describe("Qoder image input policy", () => {
  it("follows live catalog metadata for DeepSeek models", () => {
    expect(supportsQoderImageInput({ key: "dmodel", is_vl: true })).toBe(true);
    expect(supportsQoderImageInput({ key: "dfmodel", is_vl: true })).toBe(true);
    expect(supportsQoderImageInput({ key: "dfmodel", is_vl: false })).toBe(false);
  });

  it("follows live catalog metadata for tier aliases", () => {
    for (const key of ["auto", "ultimate", "performance", "efficient"]) {
      expect(supportsQoderImageInput({ key, is_vl: true })).toBe(true);
      expect(supportsQoderImageInput({ key, is_vl: false })).toBe(false);
    }
  });

  it("rejects unknown models and missing metadata", () => {
    expect(supportsQoderImageInput({})).toBe(false);
    expect(supportsQoderImageInput({ key: "lite" })).toBe(false);
  });

  it("keeps verified non-DeepSeek models eligible", () => {
    expect(supportsQoderImageInput({ key: "qmodel_38max", is_vl: true })).toBe(true);
    expect(supportsQoderImageInput({ key: "kmodel_latest", is_vl: true })).toBe(true);
    expect(supportsQoderImageInput({ key: "gmodel", is_vl: true })).toBe(true);
  });
});

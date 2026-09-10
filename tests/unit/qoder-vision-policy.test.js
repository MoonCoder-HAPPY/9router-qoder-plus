import { describe, expect, it } from "vitest";
import { supportsQoderImageInput } from "../../open-sse/shared/qoder/vision.js";

describe("Qoder image input policy", () => {
  it("rejects DeepSeek models even when Qoder incorrectly marks is_vl true", () => {
    expect(supportsQoderImageInput({ key: "dmodel", is_vl: true })).toBe(false);
    expect(supportsQoderImageInput({ key: "dfmodel", is_vl: true })).toBe(false);
  });

  it("treats routing aliases as non-native image models", () => {
    for (const key of ["auto", "ultimate", "performance", "efficient"]) {
      expect(supportsQoderImageInput({ key, is_vl: true })).toBe(false);
    }
  });

  it("keeps verified non-DeepSeek models eligible", () => {
    expect(supportsQoderImageInput({ key: "qmodel_38max", is_vl: true })).toBe(true);
    expect(supportsQoderImageInput({ key: "kmodel_latest", is_vl: true })).toBe(true);
    expect(supportsQoderImageInput({ key: "gmodel", is_vl: true })).toBe(true);
  });
});

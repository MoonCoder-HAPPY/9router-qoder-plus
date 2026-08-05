import { describe, expect, it } from "vitest";
import qoder from "../../open-sse/providers/registry/qoder.js";
import { QODER_MODEL_MAP } from "../../open-sse/shared/qoder/constants.js";

describe("Qoder model display-name fallbacks", () => {
  it("keeps Qoder's enabled live chat keys available with display names", () => {
    const expectedDisplayNames = {
      auto: "Auto",
      ultimate: "Ultimate",
      performance: "Performance",
      efficient: "Efficient",
      lite: "Lite",
      qmodel_preview: "Qwen3.8-Max-Preview",
      qmodel_latest: "Qwen3.7-Max",
      qmodel: "Qwen3.7-Plus",
      kmodel_latest: "Kimi-K3",
      kmodel: "Kimi-K2.7-Code",
      gm51model: "GLM-5.2",
      dmodel: "DeepSeek-V4-Pro",
      dfmodel: "DeepSeek-V4-Flash",
      mmodel: "MiniMax-M3",
    };

    for (const [id, name] of Object.entries(expectedDisplayNames)) {
      expect(QODER_MODEL_MAP[id]).toBe(id);
      expect(qoder.models.find((item) => item.id === id)).toEqual({ id, name });
    }
  });
});

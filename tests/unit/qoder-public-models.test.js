import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Qoder public model ids", () => {
  let tempDir;
  const originalDataDir = process.env.DATA_DIR;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-qoder-public-models-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    const db = await import("@/lib/db/index.js");
    await db.initDb();
  });

  afterEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    vi.resetModules();
  });

  it("defaults public ids from display names and resolves them to internal ids", async () => {
    const {
      decorateQoderModelsForPublic,
      resolveQoderPublicModelId,
    } = await import("@/lib/qoder/publicModels.js");

    const decorated = await decorateQoderModelsForPublic([
      { id: "gm51model", name: "GLM-5.2" },
      { id: "qmodel", name: "Qwen3.7-Plus" },
    ]);

    expect(decorated).toEqual([
      expect.objectContaining({ id: "GLM-5.2", name: "GLM-5.2", internalId: "gm51model" }),
      expect.objectContaining({ id: "Qwen3.7-Plus", name: "Qwen3.7-Plus", internalId: "qmodel" }),
    ]);
    await expect(resolveQoderPublicModelId("GLM-5.2")).resolves.toBe("gm51model");
  });

  it("uses saved overrides and rejects duplicate public ids", async () => {
    const {
      decorateQoderModelsForPublic,
      resolveQoderPublicModelId,
      setQoderPublicModelMapping,
    } = await import("@/lib/qoder/publicModels.js");

    await setQoderPublicModelMapping("gm51model", "my-glm");
    await expect(setQoderPublicModelMapping("qmodel", "my-glm")).rejects.toThrow(/already used/i);

    const decorated = await decorateQoderModelsForPublic([
      { id: "gm51model", name: "GLM-5.2" },
      { id: "qmodel", name: "Qwen3.7-Plus" },
    ]);

    expect(decorated.find((m) => m.internalId === "gm51model")).toMatchObject({
      id: "my-glm",
      name: "my-glm",
      internalId: "gm51model",
    });
    await expect(resolveQoderPublicModelId("my-glm")).resolves.toBe("gm51model");
  });

  it("resolves display names learned from the live qoder catalog", async () => {
    const {
      decorateQoderModelsForPublic,
      resolveQoderPublicModelId,
    } = await import("@/lib/qoder/publicModels.js");

    await decorateQoderModelsForPublic([
      { id: "futuremodel", name: "Future Model" },
    ]);

    await expect(resolveQoderPublicModelId("Future Model")).resolves.toBe("futuremodel");
  });

  it("rejects overrides that duplicate a learned default public id", async () => {
    const {
      decorateQoderModelsForPublic,
      setQoderPublicModelMapping,
    } = await import("@/lib/qoder/publicModels.js");

    await decorateQoderModelsForPublic([
      { id: "futuremodel", name: "Future Model" },
      { id: "othermodel", name: "Other Model" },
    ]);

    await expect(setQoderPublicModelMapping("othermodel", "Future Model")).rejects.toThrow(/already used/i);
  });

  it("rejects overrides that duplicate a static default public id before live catalog is learned", async () => {
    const { setQoderPublicModelMapping } = await import("@/lib/qoder/publicModels.js");

    await expect(setQoderPublicModelMapping("qmodel", "GLM-5.2")).rejects.toThrow(/already used/i);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Qoder public model routing", () => {
  let tempDir;
  const originalDataDir = process.env.DATA_DIR;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-qoder-public-routing-"));
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

  it("routes a display-name model to qoder internal id", async () => {
    const { getModelInfo } = await import("@/sse/services/model.js");

    await expect(getModelInfo("GLM-5.2")).resolves.toEqual({
      provider: "qoder",
      model: "gm51model",
    });
  });

  it("keeps explicit legacy qoder ids working", async () => {
    const { getModelInfo } = await import("@/sse/services/model.js");

    await expect(getModelInfo("qd/gm51model")).resolves.toEqual({
      provider: "qoder",
      model: "gm51model",
    });
    await expect(getModelInfo("qoder/gm51model")).resolves.toEqual({
      provider: "qoder",
      model: "gm51model",
    });
  });

  it("keeps bare legacy qoder internal ids working after aliases", async () => {
    const { getModelInfo } = await import("@/sse/services/model.js");

    await expect(getModelInfo("gm51model")).resolves.toEqual({
      provider: "qoder",
      model: "gm51model",
    });
  });

  it("lets explicit model aliases win over qoder public ids", async () => {
    const db = await import("@/lib/db/index.js");
    await db.setModelAlias("GLM-5.2", "openai/gpt-4o");
    const { getModelInfo } = await import("@/sse/services/model.js");

    await expect(getModelInfo("GLM-5.2")).resolves.toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("lets explicit model aliases win over bare qoder internal ids", async () => {
    const db = await import("@/lib/db/index.js");
    await db.setModelAlias("gm51model", "openai/gpt-4o");
    const { getModelInfo } = await import("@/sse/services/model.js");

    await expect(getModelInfo("gm51model")).resolves.toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("routes public ids learned from qoder live catalog", async () => {
    const { decorateQoderModelsForPublic } = await import("@/lib/qoder/publicModels.js");
    await decorateQoderModelsForPublic([{ id: "futuremodel", name: "Future Model" }]);
    const { getModelInfo } = await import("@/sse/services/model.js");

    await expect(getModelInfo("Future Model")).resolves.toEqual({
      provider: "qoder",
      model: "futuremodel",
    });
  });
});

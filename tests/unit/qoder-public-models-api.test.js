import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("/v1/models qoder public ids", () => {
  let tempDir;
  const originalDataDir = process.env.DATA_DIR;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-qoder-public-api-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    vi.doMock("open-sse/services/qoderModels.js", () => ({
      resolveQoderModels: vi.fn(async () => ({
        models: [
          { id: "gm51model", name: "GLM-5.2", priceFactor: 0.6, originalPriceFactor: 0.8 },
          { id: "qmodel", name: "Qwen3.7-Plus" },
        ],
      })),
    }));
    const db = await import("@/lib/db/index.js");
    await db.initDb();
    await db.createProviderConnection({
      provider: "qoder",
      authType: "oauth",
      name: "qoder-a",
      accessToken: "token",
      refreshToken: "refresh",
      providerSpecificData: { userId: "user-a" },
      isActive: true,
    });
  });

  afterEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    vi.doUnmock("open-sse/services/qoderModels.js");
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    vi.resetModules();
  });

  it("returns qoder display names as public model ids", async () => {
    const db = await import("@/lib/db/index.js");
    await db.addCustomModel({ providerAlias: "qd", id: "qmodel_preview", type: "llm", name: "Removed Qoder Model" });
    const { buildModelsList } = await import("@/app/api/v1/models/route.js");

    const models = await buildModelsList(["llm"]);
    expect(models.find((m) => m.id === "GLM-5.2")).toMatchObject({
      id: "GLM-5.2",
      object: "model",
      owned_by: "qoder",
      name: "GLM-5.2",
      price_factor: 0.6,
      original_price_factor: 0.8,
    });
    expect(models.some((m) => m.id === "qd/gm51model")).toBe(false);
    expect(models.some((m) => m.id === "qd/qmodel_preview")).toBe(false);
  });

  it("returns saved qoder public model overrides", async () => {
    const { setQoderPublicModelMapping } = await import("@/lib/qoder/publicModels.js");
    await setQoderPublicModelMapping("gm51model", "my-glm");
    const { buildModelsList } = await import("@/app/api/v1/models/route.js");

    const models = await buildModelsList(["llm"]);
    expect(models.find((m) => m.id === "my-glm")).toMatchObject({
      id: "my-glm",
      object: "model",
      owned_by: "qoder",
      name: "my-glm",
    });
  });

  it("uses qoder display names for static fallback models without active connections", async () => {
    const db = await import("@/lib/db/index.js");
    const connections = await db.getProviderConnections();
    for (const connection of connections) {
      await db.deleteProviderConnection(connection.id);
    }
    const { buildModelsList } = await import("@/app/api/v1/models/route.js");

    const models = await buildModelsList(["llm"]);
    expect(models.find((m) => m.id === "GLM-5.2")).toMatchObject({
      id: "GLM-5.2",
      object: "model",
      owned_by: "qoder",
      name: "GLM-5.2",
    });
    expect(models.some((m) => m.id === "qd/gm51model")).toBe(false);
  });
});

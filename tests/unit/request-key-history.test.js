import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";

let db, adapter, tempDir;
const originalDataDir = process.env.DATA_DIR;
beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-history-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ enableObservability2: true, observabilityBatchSize: 1 });
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});
afterAll(() => {
  adapter?.close();
  delete global._dbAdapter;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function save(id, identity, timestamp, provider = "openai") {
  const { buildRequestDetail } = await import("../../open-sse/handlers/chatCore/requestDetail.js");
  await db.saveRequestDetail(buildRequestDetail({
    provider, model: "test", apiKeyIdentity: identity,
    request: { headers: { authorization: "Bearer secret-value", "x-api-key": "secret-value" } },
  }, { id, timestamp }));
  await vi.waitFor(async () => expect(await db.getRequestDetailById(id)).toBeTruthy());
}

describe("request Key history", () => {
  it("persists snapshots through the builder and buffer without credentials", async () => {
    await save("old", { apiKeyId: "key-a", apiKeyName: "Before", key: "secret-value" }, "2026-01-01T00:00:00Z");
    await save("new", { apiKeyId: "key-a", apiKeyName: "Shared" }, "2026-01-03T00:00:00Z");
    await save("other", { apiKeyId: "key-b", apiKeyName: "Shared" }, "2026-01-02T00:00:00Z", "anthropic");
    expect(await db.getRequestDetailById("old")).toMatchObject({ apiKeyId: "key-a", apiKeyName: "Before" });
    expect(JSON.stringify(await db.getRequestDetails())).not.toContain("secret-value");
  });
  it("filters by stable ID before pagination and keeps global historical candidates", async () => {
    const result = await db.getRequestDetails({ apiKeyId: "key-a", provider: "openai", pageSize: 1, page: 2 });
    expect(result.details.map(d => d.id)).toEqual(["old"]);
    expect(result.pagination).toMatchObject({ totalItems: 2, totalPages: 2 });
    expect(result.apiKeys).toEqual([{ id: "key-a", name: "Shared" }, { id: "key-b", name: "Shared" }]);
    expect((await db.getRequestDetails({ apiKeyId: "' OR 1=1 --" })).details).toEqual([]);
  });
  it("distinguishes unknown history and explicit no-Key, tolerating corrupt JSON", async () => {
    await save("unknown", undefined, "2026-01-04T00:00:00Z");
    await save("none", { apiKeyId: null, apiKeyName: null }, "2026-01-05T00:00:00Z");
    adapter.run("INSERT INTO requestDetails(id, timestamp, data) VALUES (?, ?, ?)", ["corrupt", "2026-01-06", "{broken"]);
    expect(await db.getRequestDetailById("unknown")).not.toHaveProperty("apiKeyId");
    expect(await db.getRequestDetailById("none")).toMatchObject({ apiKeyId: null, apiKeyName: null });
    expect((await db.getRequestDetails({ apiKeyId: "key-a" })).pagination.totalItems).toBe(2);
    expect((await db.getRequestDetails()).apiKeys).toHaveLength(2);
  });
  it("API forwards ID and returns historical candidates on empty pages", async () => {
    const { GET } = await import("@/app/api/usage/request-details/route.js");
    const response = await GET(new Request("http://localhost/api/usage/request-details?apiKeyId=key-b&page=9&pageSize=1"));
    const result = await response.json();
    expect(result.details).toEqual([]);
    expect(result.pagination.totalItems).toBe(1);
    expect(result.apiKeys).toHaveLength(2);
  });
  it("empty ID means all and candidates disappear only when their retained history is removed", async () => {
    expect((await db.getRequestDetails({ apiKeyId: "" })).pagination.totalItems).toBe(6);
    adapter.run("DELETE FROM requestDetails WHERE id = ?", ["other"]);
    expect((await db.getRequestDetails()).apiKeys).toEqual([{ id: "key-a", name: "Shared" }]);
  });
});

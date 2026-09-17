import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
let db, route, update, upstream, directory;
const originalDirectory = process.env.DATA_DIR;
const policy = (ids) => ({ enabled: true, providers: { qoder: {
  connectionIds: ids, priorityOrder: ids, accountAllocations: Object.fromEntries(ids.map(id => [id, 10])),
} } });
const response = () => new Response(JSON.stringify({ userQuota: { total: 100, remaining: 90, used: 10 } }));
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "incremental-quota-"));
  process.env.DATA_DIR = directory;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  route = await import("@/app/api/keys/quota-options/route.js");
  update = await import("@/app/api/keys/[id]/route.js");
  upstream = (await import("../../open-sse/utils/proxyFetch.js")).proxyAwareFetch;
  upstream.mockReset().mockImplementation(async () => response());
});
afterEach(() => {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  fs.rmSync(directory, { recursive: true, force: true });
  if (originalDirectory === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDirectory;
});
async function account(name) {
  return db.createProviderConnection({ provider: "qoder", name, accessToken: name, isActive: true });
}
async function put(key, body) {
  return update.PUT(new Request(`http://localhost/api/keys/${key.id}`, {
    method: "PUT", body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: key.id }) });
}
it("streams identities and fast results before a blocked upstream finishes", async () => {
  await account("slow");
  const fast = await account("fast");
  let release;
  upstream.mockImplementation((_url, options) => options.headers.Authorization === "Bearer slow"
    ? new Promise(resolve => { release = () => resolve(response()); }) : Promise.resolve(response()));
  const result = await route.GET(new Request("http://localhost/api/keys/quota-options?stream=1"));
  expect(result.headers.get("content-type")).toContain("text/event-stream");
  const reader = result.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain('"type":"snapshot"');
  expect(first).toContain('"remainingQuota":null');
  const second = new TextDecoder().decode((await reader.read()).value);
  expect(second).toContain('"type":"account"');
  expect(second).toContain(fast.id);
  release();
  let tail = "";
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); }
  expect(tail).toContain('"type":"complete"');
  expect(first + second + tail).not.toContain("accessToken");
});
it("PUT queries only selected accounts and persists their allocation", async () => {
  const selected = await account("selected");
  await account("unselected");
  const key = await db.createApiKey("tenant", "machine");
  expect((await put(key, { policy: policy([selected.id]) })).status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(upstream.mock.calls[0][1].headers.Authorization).toBe("Bearer selected");
  expect((await db.getApiKeyById(key.id)).policy.providers.qoder.connectionIds).toEqual([selected.id]);
});
it("rejects unavailable and missing selections without altering stored policy", async () => {
  const selected = await account("selected");
  const key = await db.createApiKey("tenant", "machine");
  upstream.mockRejectedValue(new Error("offline"));
  expect((await put(key, { policy: policy([selected.id]) })).status).toBe(400);
  expect((await put(key, { policy: policy(["missing"]) })).status).toBe(400);
  expect((await db.getApiKeyById(key.id)).policy.enabled).toBe(false);
  const zeroAllocation = policy(["missing"]);
  zeroAllocation.providers.qoder.accountAllocations = {};
  expect((await put(key, { policy: zeroAllocation })).status).toBe(400);
  zeroAllocation.providers.qoder.connectionIds = [selected.id];
  expect((await put(key, { policy: zeroAllocation })).status).toBe(400);
});
it("prioritizes selected accounts and abort stops further stream work", async () => {
  for (let index = 0; index < 4; index++) await account(`unused-${index}`);
  const selected = await account("selected-last");
  const key = await db.createApiKey("tenant", "machine");
  await db.updateApiKey(key.id, { policy: policy([selected.id]) });
  upstream.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const result = await route.GET(new Request(`http://localhost/api/keys/quota-options?stream=1&excludeKeyId=${key.id}`, { signal: controller.signal }));
  const reader = result.body.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"snapshot"');
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(3));
  expect(upstream.mock.calls[0][1].headers.Authorization).toBe("Bearer selected-last");
  controller.abort();
  expect((await reader.read()).done).toBe(true);
  expect(upstream).toHaveBeenCalledTimes(3);
});
it("keeps 404 for absent keys and rejects allocations conflicting with another key", async () => {
  expect((await put({ id: "absent" }, { policy: policy([]) })).status).toBe(404);
  const selected = await account("selected");
  const other = await db.createApiKey("other", "machine");
  const otherPolicy = policy([selected.id]);
  otherPolicy.providers.qoder.accountAllocations[selected.id] = 85;
  await db.updateApiKey(other.id, { policy: otherPolicy });
  const key = await db.createApiKey("tenant", "machine");
  expect((await put(key, { policy: policy([selected.id]) })).status).toBe(400);
  expect((await db.getApiKeyById(other.id)).policy.providers.qoder.accountAllocations[selected.id]).toBe(85);
});
it("keeps legacy JSON and skips quota lookup when disabling or only toggling activity", async () => {
  const selected = await account("selected");
  const result = await route.GET(new Request("http://localhost/api/keys/quota-options"));
  expect((await result.json()).providers.qoder.accounts[0]).toMatchObject({ id: selected.id, remainingQuota: 90 });
  upstream.mockClear();
  const key = await db.createApiKey("tenant", "machine");
  expect((await put(key, { policy: { enabled: false } })).status).toBe(200);
  expect((await put(key, { isActive: false })).status).toBe(200);
  expect(upstream).not.toHaveBeenCalled();
});
it("rejects an enabled empty selection before upstream lookup", async () => {
  await account("unused");
  const key = await db.createApiKey("tenant", "machine");
  const result = await put(key, { policy: policy([]) });
  expect(result.status).toBe(400);
  expect((await result.json()).error).toContain("Select at least one");
  expect(upstream).not.toHaveBeenCalled();
  expect((await db.getApiKeyById(key.id)).policy.enabled).toBe(false);
});
it("removal preserves retained baselines and ledger without deleting connections", async () => {
  const retained = await account("retained");
  const removed = await account("removed");
  const key = await db.createApiKey("tenant", "machine");
  const existing = policy([retained.id, removed.id]);
  existing.providers.qoder.quotaBaseline = {
    [retained.id]: { initialRemainingQuota: 100, capturedAt: "2026-01-01T00:00:00.000Z" },
    [removed.id]: { initialRemainingQuota: 100 },
  };
  existing.providers.qoder.creditUsageLedger = { [retained.id]: { used: 4, precise: true } };
  await db.updateApiKey(key.id, { policy: existing });
  const before = (await db.getApiKeyById(key.id)).policy.providers.qoder;
  const result = await put(key, { policy: policy([retained.id]) });
  expect(result.status).toBe(200);
  const after = (await db.getApiKeyById(key.id)).policy.providers.qoder;
  expect(after.quotaBaseline[retained.id]).toEqual(before.quotaBaseline[retained.id]);
  expect(after.creditUsageLedger[retained.id]).toEqual(before.creditUsageLedger[retained.id]);
  expect(await db.getProviderConnections({ provider: "qoder" })).toHaveLength(2);
});

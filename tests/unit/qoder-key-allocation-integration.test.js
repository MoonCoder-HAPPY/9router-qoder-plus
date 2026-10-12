import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
const originalDataDir = process.env.DATA_DIR;
let directory, db, update, quota, balance, usage, upstream, connection, remaining;
const policy = (id, amount) => ({ enabled: true, providers: { qoder: {
  connectionIds: [id], priorityOrder: [id], accountAllocations: { [id]: amount },
} } });
async function put(key, amount) {
  return update.PUT(new Request(`http://localhost/api/keys/${key.id}`, {
    method: "PUT", body: JSON.stringify({ policy: policy(connection.id, amount) }),
  }), { params: Promise.resolve({ id: key.id }) });
}
async function readBalances(key) {
  const headers = { authorization: `Bearer ${key.key}` };
  const a = await balance.GET(new Request("http://localhost/user/balance", { headers }));
  const b = await usage.POST(new Request("http://localhost/api/usage", { method: "POST", headers }));
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  const alias = await a.json(), primary = await b.json();
  const { is_active, ...body } = alias;
  expect(is_active).toBe(true);
  expect(body).toEqual(primary);
  const platform = await quota.buildQoderQuotaOptions();
  expect(platform.providers.qoder.keyUsageByKeyId[key.id]).toMatchObject({
    used: body.used, limit: body.total, remaining: body.remaining,
  });
  return body;
}
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-allocation-contract-"));
  process.env.DATA_DIR = directory;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  update = await import("@/app/api/keys/[id]/route.js");
  quota = await import("@/app/api/keys/quota-options/route.js");
  balance = await import("@/app/user/balance/route.js");
  usage = await import("@/app/api/usage/route.js");
  upstream = (await import("../../open-sse/utils/proxyFetch.js")).proxyAwareFetch;
  remaining = 10000;
  upstream.mockReset().mockImplementation(async () => Response.json({ userQuota: { total: 10000, remaining, used: 10000 - remaining } }));
  connection = await db.createProviderConnection({ provider: "qoder", name: "Account A", accessToken: "test-account-token", isActive: true });
});
afterEach(() => {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  fs.rmSync(directory, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  vi.resetModules();
});

describe("allocation edits through real Key and CC-SWITCH APIs", () => {
  it("follows the approved 3000 → 2000 → 1200 → 4000 → 6000 example", async () => {
    const key = await db.createApiKey("KEY_A", "test-machine");
    expect((await put(key, 3000)).status).toBe(200);
    expect(await readBalances(key)).toMatchObject({ used: 0, total: 3000, remaining: 3000 });
    await db.recordApiKeyQoderCreditUsage(key.key, connection.id, 1200);
    remaining = 8100; // 700 credits were spent outside this Key.
    expect(await readBalances(key)).toMatchObject({ used: 1200, total: 3000, remaining: 1800 });
    expect((await put(key, 2000)).status).toBe(200);
    expect(await readBalances(key)).toMatchObject({ used: 1200, total: 2000, remaining: 800 });
    const rejected = await put(key, 1000);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ belowUsageAccounts: [{ used: 1200, requested: 1000 }] });
    expect(await readBalances(key)).toMatchObject({ used: 1200, total: 2000, remaining: 800 });
    expect((await put(key, 1200)).status).toBe(200);
    expect(await readBalances(key)).toMatchObject({ used: 1200, total: 1200, remaining: 0 });
    expect((await put(key, 4000)).status).toBe(200);
    await db.recordApiKeyQoderCreditUsage(key.key, connection.id, 500);
    remaining = 7600;
    expect(await readBalances(key)).toMatchObject({ used: 1700, total: 4000, remaining: 2300 });
    remaining = 15000;
    expect(await readBalances(key)).toMatchObject({ used: 1700, total: 4000, remaining: 2300 });
    expect((await put(key, 6000)).status).toBe(200);
    expect(await readBalances(key)).toMatchObject({ used: 1700, total: 6000, remaining: 4300 });
  });

  it("shares a 5000 pool without attributing one Key's spending to the other", async () => {
    remaining = 5000;
    const a = await db.createApiKey("A", "test-machine"), b = await db.createApiKey("B", "test-machine");
    expect((await put(a, 3000)).status).toBe(200);
    expect((await put(b, 2000)).status).toBe(200);
    await db.recordApiKeyQoderCreditUsage(a.key, connection.id, 1200);
    await db.recordApiKeyQoderCreditUsage(b.key, connection.id, 700);
    remaining = 3100;
    expect((await put(a, 3000)).status).toBe(200);
    expect((await put(b, 2000)).status).toBe(200);
    expect(await readBalances(a)).toMatchObject({ used: 1200, total: 3000, remaining: 1800 });
    expect(await readBalances(b)).toMatchObject({ used: 700, total: 2000, remaining: 1300 });
    expect((await put(a, 4000)).status).toBe(400);
    remaining = 4100;
    expect((await put(a, 4000)).status).toBe(200);
    expect(await readBalances(a)).toMatchObject({ used: 1200, total: 4000, remaining: 2800 });
  });

  it("revalidates new usage in the save transaction and preserves it on success", async () => {
    const key = await db.createApiKey("A", "test-machine");
    expect((await put(key, 3000)).status).toBe(200);
    let release;
    upstream.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(Response.json({ userQuota: { total: 10000, used: 1200, remaining: 8800 } })); }));
    const save = put(key, 1000);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await db.recordApiKeyQoderCreditUsage(key.key, connection.id, 1200);
    release();
    expect((await save).status).toBe(400);
    expect(await readBalances(key)).toMatchObject({ used: 1200, total: 3000, remaining: 1800 });
    upstream.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(Response.json({ userQuota: { total: 10000, used: 1250, remaining: 8750 } })); }));
    release = null;
    const accepted = put(key, 2000);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await db.recordApiKeyQoderCreditUsage(key.key, connection.id, 50);
    release();
    expect((await accepted).status).toBe(200);
    expect(await readBalances(key)).toMatchObject({ used: 1250, total: 2000, remaining: 750 });
  });

  it("rejects concurrent over-allocation to different Keys", async () => {
    remaining = 5000;
    const a = await db.createApiKey("A", "test-machine"), b = await db.createApiKey("B", "test-machine");
    const replies = await Promise.all([put(a, 3000), put(b, 3000)]);
    expect(replies.map(reply => reply.status).sort()).toEqual([200, 400]);
  });

  it("returns Key accounting without upstream calls when account tokens fail or accounts are disabled", async () => {
    const key = await db.createApiKey("A", "test-machine");
    expect((await put(key, 3000)).status).toBe(200);
    await db.recordApiKeyQoderCreditUsage(key.key, connection.id, 1200);
    upstream.mockReset().mockRejectedValue(new Error("expired account token"));
    const headers = { authorization: `Bearer ${key.key}` };
    let res = await balance.GET(new Request("http://localhost/user/balance", { headers }));
    expect(await res.json()).toMatchObject({ used: 1200, total: 3000, balance: 1800 });
    expect(upstream).not.toHaveBeenCalled();
    await db.updateProviderConnection(connection.id, { isActive: false });
    res = await balance.GET(new Request("http://localhost/user/balance", { headers }));
    expect(await res.json()).toMatchObject({ used: 1200, total: 3000, balance: 1800 });
  });

  it("retains history across disabling, re-enabling and removing an account", async () => {
    const key = await db.createApiKey("A", "test-machine");
    expect((await put(key, 3000)).status).toBe(200);
    await db.recordApiKeyQoderCreditUsage(key.key, connection.id, 1200);
    const disabled = await update.PUT(new Request(`http://localhost/api/keys/${key.id}`, { method: "PUT", body: JSON.stringify({ policy: { enabled: false, providers: {} } }) }), { params: Promise.resolve({ id: key.id }) });
    expect(disabled.status).toBe(200);
    await db.recordApiKeyQoderCreditUsage(key.key, connection.id, 100);
    expect((await put(key, 2000)).status).toBe(200);
    expect(await readBalances(key)).toMatchObject({ used: 1300, total: 2000, remaining: 700 });
    const second = await db.createProviderConnection({ provider: "qoder", name: "B", accessToken: "test-b", isActive: true });
    const switchAccount = await update.PUT(new Request(`http://localhost/api/keys/${key.id}`, { method: "PUT", body: JSON.stringify({ policy: policy(second.id, 1000) }) }), { params: Promise.resolve({ id: key.id }) });
    expect(switchAccount.status).toBe(200);
    expect((await db.getApiKeyById(key.id)).policy.providers.qoder.creditUsageLedger[connection.id].used).toBe(1300);
    expect((await put(key, 2000)).status).toBe(200);
    expect(await readBalances(key)).toMatchObject({ used: 1300, total: 2000, remaining: 700 });
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("api key policy db integration", () => {
  let tempDir;
  let db;
  const originalDataDir = process.env.DATA_DIR;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-policy-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
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

  it("creates keys with disabled policy and updates policy JSON", async () => {
    const key = await db.createApiKey("tenant-a", "machine-a");
    expect(key.policy).toEqual({ enabled: false, providers: {} });

    const updated = await db.updateApiKey(key.id, {
      policy: {
        enabled: true,
        providers: { qoder: { connectionIds: ["conn-a"], priorityOrder: ["conn-a"], allocationLimit: 1000 } },
      },
    });

    expect(updated.policy.providers.qoder).toMatchObject({
      connectionIds: ["conn-a"],
      priorityOrder: ["conn-a"],
      allocationLimit: 1000,
      unit: "credits",
      metric: "credits",
      quotaBaseline: {},
    });

    const byValue = await db.getApiKeyByValue(key.key);
    expect(byValue.id).toBe(key.id);
    expect(byValue.policy.providers.qoder.connectionIds).toEqual(["conn-a"]);
  });

  it("keeps validateApiKey boolean behavior", async () => {
    const key = await db.createApiKey("tenant-a", "machine-a");
    expect(await db.validateApiKey(key.key)).toBe(true);
    await db.updateApiKey(key.id, { isActive: false });
    expect(await db.validateApiKey(key.key)).toBe(false);
  });

  it("sums usage by key provider and selected accounts", async () => {
    const key = await db.createApiKey("tenant-a", "machine-a");
    await db.saveRequestUsage({
      provider: "qoder",
      model: "auto",
      connectionId: "conn-a",
      apiKey: key.key,
      tokens: { prompt_tokens: 100, completion_tokens: 50 },
    });
    await db.saveRequestUsage({
      provider: "qoder",
      model: "auto",
      connectionId: "conn-b",
      apiKey: key.key,
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
    });
    await db.saveRequestUsage({
      provider: "qoder",
      model: "auto",
      connectionId: "conn-a",
      apiKey: "other",
      tokens: { prompt_tokens: 1000, completion_tokens: 1000 },
    });

    expect(await db.getApiKeyPolicyUsedTokens({
      apiKey: key.key,
      provider: "qoder",
      connectionIds: ["conn-a"],
    })).toBe(150);

    expect(await db.getApiKeyPolicyUsedTokens({
      apiKey: key.key,
      provider: "qoder",
      connectionIds: ["conn-a", "conn-b"],
    })).toBe(165);
  });

  it("sums policy token usage from the policy start date when provided", async () => {
    const key = await db.createApiKey("tenant-a", "machine-a");
    await db.saveRequestUsage({
      timestamp: "2026-07-28T02:00:00.000Z",
      provider: "qoder",
      model: "auto",
      connectionId: "conn-a",
      apiKey: key.key,
      tokens: { prompt_tokens: 1000, completion_tokens: 1000 },
    });
    await db.saveRequestUsage({
      timestamp: "2026-07-28T04:00:00.000Z",
      provider: "qoder",
      model: "auto",
      connectionId: "conn-a",
      apiKey: key.key,
      tokens: { prompt_tokens: 100, completion_tokens: 50 },
    });

    expect(await db.getApiKeyPolicyUsedTokens({
      apiKey: key.key,
      provider: "qoder",
      connectionIds: ["conn-a"],
      startDate: "2026-07-28T03:00:00.000Z",
    })).toBe(150);
  });

  it("persists Qoder credit usage ledger on the selected API key policy", async () => {
    const key = await db.createApiKey("tenant-a", "machine-a");
    await db.updateApiKey(key.id, {
      policy: {
        enabled: true,
        providers: {
          qoder: {
            connectionIds: ["conn-a"],
            priorityOrder: ["conn-a"],
            accountAllocations: { "conn-a": 6000 },
            quotaBaseline: {
              "conn-a": { initialRemainingQuota: 6200, capturedAt: "2026-08-11T03:24:01.885Z" },
            },
          },
        },
      },
    });

    const saved = await db.getApiKeyByValue(key.key);
    await db.updateApiKey(key.id, {
      policy: {
        ...saved.policy,
        providers: {
          qoder: {
            ...saved.policy.providers.qoder,
            creditUsageLedger: {
              "conn-a": { used: 5000, lastRemainingQuota: 1200, updatedAt: "2026-08-13T15:00:00.000Z" },
            },
          },
        },
      },
    });

    await db.updateApiKeyQoderCreditUsageLedger(key.id, {
      "conn-a": 6100,
    }, "2026-08-14T01:00:00.000Z");

    const updated = await db.getApiKeyByValue(key.key);
    expect(updated.policy.providers.qoder.creditUsageLedger).toEqual({
      "conn-a": { used: 5000, lastRemainingQuota: 6100, updatedAt: "2026-08-14T01:00:00.000Z" },
    });
  });

  it("resets Qoder credit usage only through the explicit reset helper", async () => {
    const key = await db.createApiKey("tenant-a", "machine-a");
    await db.updateApiKey(key.id, {
      policy: {
        enabled: true,
        providers: {
          qoder: {
            connectionIds: ["conn-a"],
            priorityOrder: ["conn-a"],
            accountAllocations: { "conn-a": 5000 },
            quotaBaseline: {
              "conn-a": { initialRemainingQuota: 8000, capturedAt: "2026-08-11T03:24:01.885Z" },
            },
            creditUsageLedger: {
              "conn-a": { used: 3200, lastRemainingQuota: 4800, updatedAt: "2026-08-14T01:00:00.000Z" },
            },
          },
        },
      },
    });

    await db.resetApiKeyQoderCreditUsage(key.id, {
      "conn-a": { initialRemainingQuota: 6000, capturedAt: "2026-08-14T02:00:00.000Z" },
    }, "2026-08-14T02:00:00.000Z");

    const reset = await db.getApiKeyByValue(key.key);
    expect(reset.policy.providers.qoder.startedAt).toBe("2026-08-14T02:00:00.000Z");
    expect(reset.policy.providers.qoder.quotaBaseline).toEqual({
      "conn-a": { initialRemainingQuota: 6000, capturedAt: "2026-08-14T02:00:00.000Z", quotaRows: [] },
    });
    expect(reset.policy.providers.qoder.creditUsageLedger).toEqual({});
  });

  it("lists other key policies for allocation validation", async () => {
    const first = await db.createApiKey("first", "machine-a");
    const second = await db.createApiKey("second", "machine-a");
    await db.updateApiKey(first.id, {
      policy: { enabled: true, providers: { qoder: { connectionIds: ["conn-a"], allocationLimit: 1000 } } },
    });
    await db.updateApiKey(second.id, {
      policy: { enabled: true, providers: { qoder: { connectionIds: ["conn-b"], allocationLimit: 2000 } } },
    });

    const policies = await db.getOtherApiKeyPolicies(second.id);
    expect(policies).toHaveLength(1);
    expect(policies[0].providers.qoder.connectionIds).toEqual(["conn-a"]);
  });
});

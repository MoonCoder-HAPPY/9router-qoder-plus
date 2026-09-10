import { beforeEach, describe, expect, it, vi } from "vitest";

const localDb = {
  getApiKeyByValue: vi.fn(),
  getProviderConnections: vi.fn(),
};

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => localDb);
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    vercelRelayUrl: "",
    proxyPoolId: null,
  })),
}));
vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: vi.fn(),
}));

import { buildCcSwitchUsage } from "../../src/shared/services/ccSwitchUsage.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CC-Switch usage builder", () => {
  it("returns allocation totals for an allocated key", () => {
    const result = buildCcSwitchUsage({
      keyName: "home",
      providerPolicy: {
        allocationLimit: 1000,
        accountAllocations: { a: 1000 },
        connectionIds: ["a"],
        priorityOrder: ["a"],
        quotaBaseline: {
          a: { initialRemainingQuota: 1000, capturedAt: "2026-09-10T00:00:00.000Z" },
        },
        creditUsageLedger: {
          a: { used: 250, precise: true, lastRemainingQuota: 750 },
        },
      },
      accounts: [
        {
          id: "a",
          name: "Account A",
          quotaStatus: "ok",
          remainingQuota: 750,
          quotaRows: [],
        },
      ],
    });

    expect(result).toMatchObject({
      isValid: true,
      total: 1000,
      used: 250,
      remaining: 750,
      balance: 750,
      unit: "credits",
    });
  });

  it("sums all accounts for an unallocated key", () => {
    const result = buildCcSwitchUsage({
      keyName: "unallocated",
      providerPolicy: null,
      accounts: [
        {
          id: "a",
          name: "A",
          quotaStatus: "ok",
          remainingQuota: 700,
          quotaRows: [
            { name: "Personal", total: 1000, used: 300, remaining: 700 },
          ],
        },
        {
          id: "b",
          name: "B",
          quotaStatus: "ok",
          remainingQuota: 1200,
          quotaRows: [
            { name: "Resource Package", total: -1, used: 800, remaining: 1200 },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      isValid: true,
      total: 3000,
      used: 1100,
      remaining: 1900,
      balance: 1900,
    });
  });

  it("reports unavailable accounts without treating them as zero", () => {
    const result = buildCcSwitchUsage({
      keyName: "unallocated",
      providerPolicy: null,
      accounts: [
        {
          id: "a",
          name: "A",
          quotaStatus: "ok",
          remainingQuota: 700,
          quotaRows: [
            { name: "Personal", total: 1000, used: 300, remaining: 700 },
          ],
        },
        {
          id: "b",
          name: "B",
          quotaStatus: "unavailable",
          remainingQuota: null,
          quotaRows: [],
        },
      ],
    });

    expect(result).toMatchObject({
      total: 1000,
      used: 300,
      remaining: 700,
    });
    expect(result.extra).toContain("1 account unavailable");
  });
});

describe("CC-Switch usage route", () => {
  it("returns 401 for an invalid API key", async () => {
    localDb.getApiKeyByValue.mockResolvedValueOnce(null);
    const { POST } = await import("../../src/app/api/usage/route.js");
    const response = await POST(new Request("http://localhost/api/usage", {
      method: "POST",
      headers: { Authorization: "Bearer invalid" },
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      isValid: false,
      error: "Invalid API key",
    });
  });

  it("returns the unallocated Qoder pool for a valid key", async () => {
    localDb.getApiKeyByValue.mockResolvedValueOnce({
      id: "key-1",
      name: "desktop",
      isActive: true,
      policy: { enabled: false, providers: {} },
    });
    localDb.getProviderConnections.mockResolvedValueOnce([
      {
        id: "conn-a",
        provider: "qoder",
        name: "Account A",
        accessToken: "token",
        providerSpecificData: {},
      },
    ]);
    const usage = await import("open-sse/services/usage.js");
    usage.getUsageForProvider.mockResolvedValueOnce({
      quotas: {
        user: { total: 1000, used: 300, remaining: 700, unit: "credits" },
        organization: { total: 8000, used: 1000, remaining: 7000, unit: "credits" },
      },
    });

    const { POST } = await import("../../src/app/api/usage/route.js");
    const response = await POST(new Request("http://localhost/api/usage", {
      method: "POST",
      headers: { Authorization: "Bearer valid" },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      isValid: true,
      total: 9000,
      used: 1300,
      remaining: 7700,
      balance: 7700,
      unit: "credits",
    });
  });

  it("returns 401 for an invalid key on /user/balance", async () => {
    localDb.getApiKeyByValue.mockResolvedValueOnce(null);
    const { GET } = await import("../../src/app/user/balance/route.js");
    const response = await GET(new Request("http://localhost/user/balance", {
      headers: { Authorization: "Bearer invalid" },
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      isValid: false,
      is_active: false,
      error: "Invalid API key",
    });
  });

  it("returns is_active on the valid /user/balance alias", async () => {
    localDb.getApiKeyByValue.mockResolvedValueOnce({
      id: "key-1",
      name: "desktop",
      isActive: true,
      policy: { enabled: false, providers: {} },
    });
    localDb.getProviderConnections.mockResolvedValueOnce([
      {
        id: "conn-a",
        provider: "qoder",
        name: "Account A",
        accessToken: "token",
        providerSpecificData: {},
      },
    ]);
    const usage = await import("open-sse/services/usage.js");
    usage.getUsageForProvider.mockResolvedValueOnce({
      quotas: {
        user: { total: 1000, used: 300, remaining: 700, unit: "credits" },
        organization: { total: 0, used: 0, remaining: 0, unit: "credits" },
      },
    });

    const { GET } = await import("../../src/app/user/balance/route.js");
    const response = await GET(new Request("http://localhost/user/balance", {
      headers: { Authorization: "Bearer valid" },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      isValid: true,
      is_active: true,
      balance: 700,
      remaining: 700,
      unit: "credits",
    });
  });
});

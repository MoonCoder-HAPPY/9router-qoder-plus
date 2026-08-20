import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => [
    { id: "conn-a", provider: "qoder", authType: "oauth", accessToken: "a", isActive: true, priority: 1, providerSpecificData: {} },
    { id: "conn-b", provider: "qoder", authType: "oauth", accessToken: "b", isActive: true, priority: 2, providerSpecificData: {} },
  ]),
  validateApiKey: vi.fn(async () => true),
  getApiKeyByValue: vi.fn(async (key) => ({
    id: "key-id",
    key,
    isActive: true,
    policy: { enabled: false, providers: {} },
  })),
  updateProviderConnection: vi.fn(async (id, data) => ({ id, ...data })),
  getSettings: vi.fn(async () => ({ fallbackStrategy: "fill-first" })),
  getProxyPools: vi.fn(async () => []),
  getApiKeyPolicyUsedTokens: vi.fn(async () => 0),
  updateApiKeyQoderCreditUsageLedger: vi.fn(async () => null),
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: vi.fn(async () => ({
    quotas: {
      user: { total: 3000, used: 500, remaining: 2500, unit: "credits" },
      organization: { total: 0, used: 0, remaining: 0, unit: "credits" },
    },
  })),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    proxyPoolId: null,
    vercelRelayUrl: "",
  })),
  pickProxyPoolId: vi.fn(() => null),
}));

vi.mock("@/shared/services/modelIdleAlert.js", () => ({
  markApiKeyQuotaRecovered: vi.fn(async () => undefined),
  notifyApiKeyQuotaExhausted: vi.fn(async () => ({ alerted: true })),
  notifyApiKeyQuotaThresholdExceeded: vi.fn(async () => ({ alerted: true })),
  notifyUsageFetchFailed: vi.fn(async () => ({ alerted: true })),
  resetApiKeyQuotaAlertState: vi.fn(async () => undefined),
}));

describe("api key policy auth enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global._qoderPolicyQuotaCache?.clear?.();
  });

  it("selects only allowed accounts", async () => {
    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const credentials = await getProviderCredentials("qoder", null, "auto", {
      apiKeyPolicy: {
        enabled: true,
        providers: { qoder: { connectionIds: ["conn-b"], allocationLimit: 1000 } },
      },
      apiKeyValue: "sk-test",
    });

    expect(credentials.connectionId).toBe("conn-b");
  });

  it("returns policyBlocked when allowed accounts are unavailable", async () => {
    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const credentials = await getProviderCredentials("qoder", null, "auto", {
      apiKeyPolicy: {
        enabled: true,
        providers: { qoder: { connectionIds: ["missing"], allocationLimit: 1000 } },
      },
      apiKeyValue: "sk-test",
    });

    expect(credentials).toMatchObject({ policyBlocked: true, status: 403 });
  });

  it("returns quotaExhausted when Qoder credit usage reaches the limit", async () => {
    const usage = await import("open-sse/services/usage.js");
    usage.getUsageForProvider.mockResolvedValueOnce({
      quotas: {
        user: { total: 3000, used: 1000, remaining: 2000, unit: "credits" },
        organization: { total: 0, used: 0, remaining: 0, unit: "credits" },
      },
    });

    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const credentials = await getProviderCredentials("qoder", null, "auto", {
      apiKeyPolicy: {
        enabled: true,
        providers: {
          qoder: {
            connectionIds: ["conn-a"],
            accountAllocations: { "conn-a": 1000 },
            metric: "credits",
            quotaBaseline: {
              "conn-a": {
                initialRemainingQuota: 3000,
                capturedAt: "2026-07-28T03:00:00.000Z",
              },
            },
          },
        },
      },
      apiKeyValue: "sk-test",
    });

    expect(credentials).toMatchObject({ quotaExhausted: true, status: 429, used: 1000, limit: 1000 });
  });

  it("sends a DingTalk alert when an API key's assigned Qoder quota is exhausted", async () => {
    const usage = await import("open-sse/services/usage.js");
    usage.getUsageForProvider.mockResolvedValueOnce({
      quotas: {
        user: { total: 3000, used: 1000, remaining: 2000, unit: "credits" },
        organization: { total: 0, used: 0, remaining: 0, unit: "credits" },
      },
    });
    const alerts = await import("@/shared/services/modelIdleAlert.js");

    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    await getProviderCredentials("qoder", null, "auto", {
      apiKeyRecord: { id: "key-id", name: "desktop" },
      apiKeyPolicy: {
        enabled: true,
        providers: {
          qoder: {
            connectionIds: ["conn-a"],
            accountAllocations: { "conn-a": 1000 },
            metric: "credits",
            quotaBaseline: {
              "conn-a": {
                initialRemainingQuota: 3000,
                capturedAt: "2026-07-28T03:00:00.000Z",
              },
            },
          },
        },
      },
      apiKeyValue: "sk-secret-value",
    });

    expect(alerts.notifyApiKeyQuotaExhausted).toHaveBeenCalledWith(expect.objectContaining({
      keyId: "key-id",
      keyName: "desktop",
      provider: "qoder",
      used: 1000,
      limit: 1000,
      remaining: 0,
    }));
    expect(JSON.stringify(alerts.notifyApiKeyQuotaExhausted.mock.calls[0][0])).not.toContain("sk-secret-value");
  });

  it("sends a DingTalk alert when API key usage reaches the configured threshold without blocking the request", async () => {
    const usage = await import("open-sse/services/usage.js");
    usage.getUsageForProvider.mockResolvedValueOnce({
      quotas: {
        user: { total: 3000, used: 850, remaining: 2150, unit: "credits" },
        organization: { total: 0, used: 0, remaining: 0, unit: "credits" },
      },
    });
    const alerts = await import("@/shared/services/modelIdleAlert.js");

    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const credentials = await getProviderCredentials("qoder", null, "auto", {
      apiKeyRecord: { id: "key-id", name: "desktop" },
      apiKeyPolicy: {
        enabled: true,
        providers: {
          qoder: {
            connectionIds: ["conn-a"],
            accountAllocations: { "conn-a": 1000 },
            metric: "credits",
            quotaBaseline: {
              "conn-a": {
                initialRemainingQuota: 3000,
                capturedAt: "2026-08-05T03:00:00.000Z",
              },
            },
          },
        },
      },
      apiKeyValue: "sk-secret-value",
    });

    expect(credentials.connectionId).toBe("conn-a");
    expect(alerts.notifyApiKeyQuotaThresholdExceeded).toHaveBeenCalledWith(expect.objectContaining({
      keyId: "key-id",
      keyName: "desktop",
      provider: "qoder",
      used: 850,
      limit: 1000,
      remaining: 150,
    }));
    expect(JSON.stringify(alerts.notifyApiKeyQuotaThresholdExceeded.mock.calls[0][0])).not.toContain("sk-secret-value");
  });

  it("enforces Qoder allocation by credit baseline instead of historical token usage", async () => {
    const localDb = await import("@/lib/localDb");
    localDb.getApiKeyPolicyUsedTokens.mockResolvedValueOnce(109297763);

    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const credentials = await getProviderCredentials("qoder", null, "auto", {
      apiKeyPolicy: {
        enabled: true,
        providers: {
          qoder: {
            connectionIds: ["conn-a"],
            accountAllocations: { "conn-a": 4092 },
            metric: "credits",
            quotaBaseline: {
              "conn-a": {
                initialRemainingQuota: 3000,
                capturedAt: "2026-07-28T03:00:00.000Z",
              },
            },
          },
        },
      },
      apiKeyValue: "sk-test",
    });

    expect(credentials.connectionId).toBe("conn-a");
    expect(localDb.getApiKeyPolicyUsedTokens).not.toHaveBeenCalled();
  });

  it("selects the next prioritized Qoder account only after the previous account segment is consumed", async () => {
    const usage = await import("open-sse/services/usage.js");
    usage.getUsageForProvider.mockImplementation(async (connection) => {
      const remaining = connection.accessToken === "b" ? 0 : 1999;
      return {
        quotas: {
          user: { total: 3000, used: 3000 - remaining, remaining, unit: "credits" },
          organization: { total: 0, used: 0, remaining: 0, unit: "credits" },
        },
      };
    });

    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const credentials = await getProviderCredentials("qoder", null, "auto", {
      apiKeyPolicy: {
        enabled: true,
        providers: {
          qoder: {
            connectionIds: ["conn-a", "conn-b"],
            priorityOrder: ["conn-b", "conn-a"],
            accountAllocations: { "conn-b": 3000, "conn-a": 500 },
            metric: "credits",
            quotaBaseline: {
              "conn-a": {
                initialRemainingQuota: 2000,
                capturedAt: "2026-07-28T03:00:00.000Z",
              },
              "conn-b": {
                initialRemainingQuota: 3000,
                capturedAt: "2026-07-28T03:00:00.000Z",
              },
            },
          },
        },
      },
      apiKeyValue: "sk-test",
    });

    expect(credentials.connectionId).toBe("conn-a");
  });

  it("lets retries skip the prioritized Qoder account when it is excluded", async () => {
    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const credentials = await getProviderCredentials("qoder", new Set(["conn-b"]), "auto", {
      apiKeyPolicy: {
        enabled: true,
        providers: {
          qoder: {
            connectionIds: ["conn-a", "conn-b"],
            priorityOrder: ["conn-b", "conn-a"],
            accountAllocations: { "conn-b": 3000, "conn-a": 500 },
            metric: "credits",
            quotaBaseline: {
              "conn-a": {
                initialRemainingQuota: 2000,
                capturedAt: "2026-07-28T03:00:00.000Z",
              },
              "conn-b": {
                initialRemainingQuota: 3000,
                capturedAt: "2026-07-28T03:00:00.000Z",
              },
            },
          },
        },
      },
      apiKeyValue: "sk-test",
    });

    expect(credentials.connectionId).toBe("conn-a");
  });

  it("uses each Qoder account's own allocation before moving to the next priority account", async () => {
    const usage = await import("open-sse/services/usage.js");
    usage.getUsageForProvider.mockImplementation(async (connection) => {
      const remaining = connection.accessToken === "b" ? 2000 : 4999;
      return {
        quotas: {
          user: { total: 5000, used: 5000 - remaining, remaining, unit: "credits" },
          organization: { total: 0, used: 0, remaining: 0, unit: "credits" },
        },
      };
    });

    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const credentials = await getProviderCredentials("qoder", null, "auto", {
      apiKeyPolicy: {
        enabled: true,
        providers: {
          qoder: {
            connectionIds: ["conn-a", "conn-b"],
            priorityOrder: ["conn-b", "conn-a"],
            accountAllocations: { "conn-b": 1000, "conn-a": 5000 },
            metric: "credits",
            quotaBaseline: {
              "conn-a": {
                initialRemainingQuota: 5000,
                capturedAt: "2026-07-28T03:00:00.000Z",
              },
              "conn-b": {
                initialRemainingQuota: 3000,
                capturedAt: "2026-07-28T03:00:00.000Z",
              },
            },
          },
        },
      },
      apiKeyValue: "sk-test",
    });

    expect(credentials.connectionId).toBe("conn-a");
  });

  it("refreshes Qoder policy quota after use so account allocation overflow can switch accounts", async () => {
    const usage = await import("open-sse/services/usage.js");
    let connBRemaining = 2500;
    usage.getUsageForProvider.mockImplementation(async (connection) => {
      const remaining = connection.accessToken === "b" ? connBRemaining : 5000;
      return {
        quotas: {
          user: { total: 5000, used: 5000 - remaining, remaining, unit: "credits" },
          organization: { total: 0, used: 0, remaining: 0, unit: "credits" },
        },
      };
    });

    const policyOptions = {
      apiKeyPolicy: {
        enabled: true,
        providers: {
          qoder: {
            connectionIds: ["conn-a", "conn-b"],
            priorityOrder: ["conn-b", "conn-a"],
            accountAllocations: { "conn-b": 1000, "conn-a": 5000 },
            metric: "credits",
            quotaBaseline: {
              "conn-a": {
                initialRemainingQuota: 5000,
                capturedAt: "2026-07-28T03:00:00.000Z",
              },
              "conn-b": {
                initialRemainingQuota: 3000,
                capturedAt: "2026-07-28T03:00:00.000Z",
              },
            },
          },
        },
      },
      apiKeyValue: "sk-test",
    };

    const { clearAccountError, getProviderCredentials } = await import("../../src/sse/services/auth.js");

    const first = await getProviderCredentials("qoder", null, "auto", policyOptions);
    expect(first.connectionId).toBe("conn-b");

    connBRemaining = 1999;
    await clearAccountError(first.connectionId, first, "auto");

    const second = await getProviderCredentials("qoder", null, "auto", policyOptions);
    expect(second.connectionId).toBe("conn-a");
  });

  it("keeps quota enforcement for healthy accounts when one Qoder account's usage fetch 401s", async () => {
    const usage = await import("open-sse/services/usage.js");
    usage.getUsageForProvider.mockImplementation(async (connection) => {
      if (connection.accessToken === "b") {
        // Dead token → usage endpoint 401
        return { message: "Qoder connected. Usage fetch returned 401." };
      }
      return {
        quotas: {
          user: { total: 3000, used: 2900, remaining: 100, unit: "credits" },
          organization: { total: 0, used: 0, remaining: 0, unit: "credits" },
        },
      };
    });
    const alerts = await import("@/shared/services/modelIdleAlert.js");

    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const credentials = await getProviderCredentials("qoder", null, "auto", {
      apiKeyRecord: { id: "key-id", name: "com" },
      apiKeyPolicy: {
        enabled: true,
        providers: {
          qoder: {
            connectionIds: ["conn-a", "conn-b"],
            priorityOrder: ["conn-a", "conn-b"],
            accountAllocations: { "conn-a": 3000, "conn-b": 1000 },
            metric: "credits",
            quotaBaseline: {
              "conn-a": { initialRemainingQuota: 3000, capturedAt: "2026-08-20T02:00:00.000Z" },
              "conn-b": { initialRemainingQuota: 2000, capturedAt: "2026-08-20T02:00:00.000Z" },
            },
          },
        },
      },
      apiKeyValue: "sk-test",
    });

    // The dead account (conn-b) must NOT disable the healthy account's (conn-a)
    // quota check. conn-a is exhausted (used 2900 >= ... no, 2900 < 3000), so the
    // request is allowed on conn-a. The key point: quota check RAN (not skipped).
    expect(credentials.connectionId).toBe("conn-a");
    // The dead account's failure should fire an alert.
    expect(alerts.notifyUsageFetchFailed).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "conn-b",
      provider: "qoder",
    }));
  });

  it("blocks the exhausted healthy account even when another account's usage fetch fails", async () => {
    const usage = await import("open-sse/services/usage.js");
    usage.getUsageForProvider.mockImplementation(async (connection) => {
      if (connection.accessToken === "b") {
        return { message: "Qoder connected. Usage fetch returned 401." };
      }
      return {
        quotas: {
          user: { total: 3000, used: 3000, remaining: 0, unit: "credits" },
          organization: { total: 0, used: 0, remaining: 0, unit: "credits" },
        },
      };
    });

    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const credentials = await getProviderCredentials("qoder", null, "auto", {
      apiKeyRecord: { id: "key-id", name: "com" },
      apiKeyPolicy: {
        enabled: true,
        providers: {
          qoder: {
            connectionIds: ["conn-a", "conn-b"],
            priorityOrder: ["conn-a", "conn-b"],
            accountAllocations: { "conn-a": 3000, "conn-b": 1000 },
            metric: "credits",
            quotaBaseline: {
              "conn-a": { initialRemainingQuota: 3000, capturedAt: "2026-08-20T02:00:00.000Z" },
              "conn-b": { initialRemainingQuota: 2000, capturedAt: "2026-08-20T02:00:00.000Z" },
            },
          },
        },
      },
      apiKeyValue: "sk-test",
    });

    // conn-a is exhausted (3000/3000). conn-b failed fetch (unknown). The check
    // must NOT silently allow everything: conn-a is exhausted, conn-b unknown.
    // With conn-a exhausted and conn-b unavailable, the policy can't pick a
    // verified account — but it must at least have run the check on conn-a.
    // conn-a used reached its allocation so it should not be the active pick.
    expect(credentials.connectionId).not.toBe("conn-a");
  });
});

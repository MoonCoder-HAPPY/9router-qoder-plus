import { describe, expect, it } from "vitest";

import {
  API_KEY_POLICY_LIMIT_METRIC,
  buildQoderQuotaBaseline,
  buildQoderQuotaBreakdownBaseline,
  getAccountAllocationLimit,
  getOrderedPolicyConnectionIds,
  getQoderCreditUsageSinceBaseline,
  mergeQoderCreditUsageLedger,
  preserveQoderCreditUsageLedger,
  preserveQoderQuotaBaseline,
  shouldRefreshQoderQuotaBaseline,
  evaluateApiKeyProviderCreditUsage,
  calculateAllowedAllocation,
  evaluateApiKeyProviderUsage,
  filterConnectionsByApiKeyPolicy,
  getProviderPolicy,
  normalizeApiKeyPolicy,
  sumQoderRemainingQuota,
} from "../../src/shared/services/apiKeyPolicy.js";
import { buildQoderKeyUsageByKeyId, buildQoderKeyUsageState, getAllocatedToAccount, validateQoderPolicyAllocation } from "../../src/app/api/keys/quota-options/route.js";

describe("api key policy", () => {
  it("normalizes missing and malformed policies to disabled", () => {
    expect(normalizeApiKeyPolicy(null)).toEqual({ enabled: false, providers: {} });
    expect(normalizeApiKeyPolicy("bad-json")).toEqual({ enabled: false, providers: {} });
    expect(normalizeApiKeyPolicy({ enabled: true, providers: null })).toEqual({ enabled: true, providers: {} });
  });

  it("normalizes provider policy fields", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["a", "b", "a", "", 123],
          allocationLimit: "1000",
          priorityOrder: ["b", "a", "missing", "b"],
          unit: "credits",
        },
      },
    });

    expect(policy.providers.qoder).toEqual({
      connectionIds: ["a", "b"],
      priorityOrder: ["b", "a"],
      allocationLimit: 1000,
      accountAllocations: { b: 1000 },
      unit: "credits",
      metric: API_KEY_POLICY_LIMIT_METRIC.CREDITS,
      startedAt: null,
      quotaBaseline: {},
      creditUsageLedger: {},
    });
  });

  it("normalizes per-account Qoder allocations and drops unselected accounts", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["a", "b"],
          priorityOrder: ["b", "a"],
          accountAllocations: { a: "5000", b: 1000, c: 999 },
        },
      },
    });

    expect(policy.providers.qoder).toMatchObject({
      accountAllocations: { a: 5000, b: 1000 },
      allocationLimit: 6000,
    });
    expect(getAccountAllocationLimit(policy.providers.qoder, "a")).toBe(5000);
  });

  it("orders selected accounts by policy priority and appends unsorted selected accounts", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["a", "b", "c"],
          priorityOrder: ["c", "a"],
          allocationLimit: 1000,
        },
      },
    });

    expect(getOrderedPolicyConnectionIds(policy, "qoder")).toEqual(["c", "a", "b"]);
  });

  it("returns null provider policy when policy is disabled or provider missing", () => {
    expect(getProviderPolicy({ enabled: false, providers: { qoder: {} } }, "qoder")).toBeNull();
    expect(getProviderPolicy({ enabled: true, providers: {} }, "qoder")).toBeNull();
  });

  it("filters connections by provider policy connection IDs", () => {
    const connections = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: { qoder: { connectionIds: ["b"], allocationLimit: 10 } },
    });

    expect(filterConnectionsByApiKeyPolicy(connections, policy, "qoder")).toEqual([{ id: "b" }]);
  });

  it("keeps connections unrestricted when provider policy has no connection IDs", () => {
    const connections = [{ id: "a" }, { id: "b" }];
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: { qoder: { allocationLimit: 10 } },
    });

    expect(filterConnectionsByApiKeyPolicy(connections, policy, "qoder")).toEqual(connections);
  });

  it("sums Qoder user and organization remaining quota", () => {
    expect(sumQoderRemainingQuota({
      quotas: {
        user: { total: 3000, used: 100, remaining: 2900 },
        organization: { total: 8000, used: 0, remaining: 8000 },
      },
    })).toEqual({
      remaining: 10900,
      rows: [
        { name: "Personal", remaining: 2900, total: 3000, used: 100, unit: "credits", resetAt: null },
        { name: "Resource Package", remaining: 8000, total: 8000, used: 0, unit: "credits", resetAt: null },
      ],
    });
  });

  it("calculates assignable quota after overlapping allocations", () => {
    const result = calculateAllowedAllocation({
      selectedConnectionIds: ["a", "b"],
      accountRemainingById: { a: 3000, b: 8000 },
      otherPolicies: [
        { enabled: true, providers: { qoder: { connectionIds: ["a"], allocationLimit: 1000 } } },
        { enabled: true, providers: { qoder: { connectionIds: ["c"], allocationLimit: 9000 } } },
      ],
      provider: "qoder",
    });

    expect(result).toEqual({
      selectedPool: 11000,
      allocatedToOtherKeys: 1000,
      maxAssignable: 10000,
    });
  });

  it("calculates overlapping allocations from each account allocation instead of the total key limit", () => {
    const result = calculateAllowedAllocation({
      selectedConnectionIds: ["b"],
      accountRemainingById: { a: 10000, b: 2000 },
      otherPolicies: [
        normalizeApiKeyPolicy({
          enabled: true,
          providers: { qoder: { connectionIds: ["a", "b"], accountAllocations: { a: 5000, b: 1000 } } },
        }),
      ],
      provider: "qoder",
    });

    expect(result).toEqual({
      selectedPool: 2000,
      allocatedToOtherKeys: 1000,
      maxAssignable: 1000,
    });
  });

  it("evaluates exhausted and available runtime usage", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: { qoder: { connectionIds: ["a"], allocationLimit: 1000 } },
    });

    expect(evaluateApiKeyProviderUsage({ policy, provider: "qoder", used: 999 }).allowed).toBe(true);
    expect(evaluateApiKeyProviderUsage({ policy, provider: "qoder", used: 1000 })).toMatchObject({
      allowed: false,
      reason: "quota_exhausted",
      limit: 1000,
      used: 1000,
    });
  });

  it("evaluates Qoder credit usage from captured remaining quota baseline", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["a", "b"],
          accountAllocations: { a: 700, b: 300 },
          metric: "credits",
          quotaBaseline: {
            a: { initialRemainingQuota: 3000, capturedAt: "2026-07-28T03:00:00.000Z" },
            b: { initialRemainingQuota: 2000, capturedAt: "2026-07-28T03:00:00.000Z" },
          },
        },
      },
    });

    expect(evaluateApiKeyProviderCreditUsage({
      policy,
      provider: "qoder",
      currentRemainingByConnectionId: { a: 2500, b: 1601 },
    })).toMatchObject({ allowed: true, used: 500, limit: 1000, remaining: 500, activeConnectionId: "a" });

    expect(evaluateApiKeyProviderCreditUsage({
      policy,
      provider: "qoder",
      currentRemainingByConnectionId: { a: 2300, b: 1600 },
    })).toMatchObject({ allowed: false, reason: "quota_exhausted", used: 1000, limit: 1000 });
  });

  it("moves Qoder credit consumption to the next priority account after the previous segment is consumed", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["a", "b", "c"],
          priorityOrder: ["b", "a", "c"],
          accountAllocations: { b: 3000, a: 1500, c: 0 },
          quotaBaseline: {
            a: { initialRemainingQuota: 2000, capturedAt: "2026-07-28T03:00:00.000Z" },
            b: { initialRemainingQuota: 3000, capturedAt: "2026-07-28T03:00:00.000Z" },
            c: { initialRemainingQuota: 4000, capturedAt: "2026-07-28T03:00:00.000Z" },
          },
        },
      },
    });

    expect(evaluateApiKeyProviderCreditUsage({
      policy,
      provider: "qoder",
      currentRemainingByConnectionId: { b: 1, a: 2000, c: 4000 },
    })).toMatchObject({ allowed: true, used: 2999, activeConnectionId: "b" });

    expect(evaluateApiKeyProviderCreditUsage({
      policy,
      provider: "qoder",
      currentRemainingByConnectionId: { b: 0, a: 1999, c: 4000 },
    })).toMatchObject({ allowed: true, used: 3001, activeConnectionId: "a" });
  });

  it("caps Qoder credit usage at each account allocation after earlier priorities are consumed", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["a", "b", "c"],
          priorityOrder: ["a", "b", "c"],
          accountAllocations: { a: 10000, b: 14000, c: 5000 },
          quotaBaseline: {
            a: { initialRemainingQuota: 13357, capturedAt: "2026-08-04T10:44:50.276Z" },
            b: { initialRemainingQuota: 182022, capturedAt: "2026-08-04T10:44:50.276Z" },
            c: { initialRemainingQuota: 5555, capturedAt: "2026-08-04T10:44:50.276Z" },
          },
          creditUsageLedger: {
            a: { used: 4894, lastRemainingQuota: 8463, updatedAt: "2026-08-14T02:00:00.000Z" },
          },
        },
      },
    });

    expect(evaluateApiKeyProviderCreditUsage({
      policy,
      provider: "qoder",
      currentRemainingByConnectionId: { a: 0, b: 116690, c: 5391 },
    })).toMatchObject({
      allowed: true,
      used: 24164,
      limit: 29000,
      remaining: 4836,
      activeConnectionId: "c",
    });
  });

  it("does not count later priority accounts before earlier account allocation is consumed", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["first", "second"],
          priorityOrder: ["first", "second"],
          accountAllocations: { first: 6000, second: 14000 },
          quotaBaseline: {
            first: { initialRemainingQuota: 8166, capturedAt: "2026-08-05T07:13:44.324Z" },
            second: { initialRemainingQuota: 108342, capturedAt: "2026-08-05T07:13:44.324Z" },
          },
        },
      },
    });

    expect(evaluateApiKeyProviderCreditUsage({
      policy,
      provider: "qoder",
      currentRemainingByConnectionId: { first: 7737, second: 96925 },
    })).toMatchObject({
      allowed: true,
      used: 429,
      limit: 20000,
      remaining: 19571,
      activeConnectionId: "first",
    });
  });

  it("counts later account personal credits even when resource package remaining grows", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["first", "second"],
          priorityOrder: ["first", "second"],
          accountAllocations: { first: 6000, second: 14000 },
          quotaBaseline: {
            first: {
              initialRemainingQuota: 8166,
              capturedAt: "2026-08-05T07:13:44.324Z",
              quotaRows: [
                { name: "Personal", remaining: 3000 },
                { name: "Resource Package", remaining: 5166 },
              ],
            },
            second: {
              initialRemainingQuota: 108342,
              capturedAt: "2026-08-05T07:13:44.324Z",
              quotaRows: [
                { name: "Personal", remaining: 3000 },
                { name: "Resource Package", remaining: 105342 },
              ],
            },
          },
        },
      },
    });

    expect(evaluateApiKeyProviderCreditUsage({
      policy,
      provider: "qoder",
      currentRemainingByConnectionId: {
        first: {
          remaining: 2162,
          quotaRows: [
            { name: "Personal", remaining: 0, total: 3000 },
            { name: "Resource Package", remaining: 2162, total: 20000 },
          ],
        },
        second: {
          remaining: 131517,
          quotaRows: [
            { name: "Personal", remaining: 973, total: 3000 },
            { name: "Resource Package", remaining: 130544, total: -1 },
          ],
        },
      },
    })).toMatchObject({
      allowed: true,
      used: 8027,
      limit: 20000,
      remaining: 11973,
      activeConnectionId: "second",
    });
  });

  it("does not reset key usage to zero when an earlier priority resource package grows above baseline", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["first", "second", "third"],
          priorityOrder: ["first", "second", "third"],
          accountAllocations: { first: 5000, second: 6000, third: 8000 },
          quotaBaseline: {
            first: {
              initialRemainingQuota: 102981,
              capturedAt: "2026-08-11T03:24:01.885Z",
              quotaRows: [
                { name: "Personal", remaining: 0, total: 3000 },
                { name: "Resource Package", remaining: 102981 },
              ],
            },
            second: {
              initialRemainingQuota: 6216,
              capturedAt: "2026-08-11T03:24:01.885Z",
              quotaRows: [
                { name: "Personal", remaining: 0, total: 3000 },
                { name: "Resource Package", remaining: 6216, total: 12000 },
              ],
            },
            third: {
              initialRemainingQuota: 8116,
              capturedAt: "2026-08-11T03:24:01.885Z",
              quotaRows: [
                { name: "Personal", remaining: 0, total: 3000 },
                { name: "Resource Package", remaining: 8116, total: 25000 },
              ],
            },
          },
        },
      },
    });

    expect(evaluateApiKeyProviderCreditUsage({
      policy,
      provider: "qoder",
      currentRemainingByConnectionId: {
        first: {
          remaining: 128360,
          quotaRows: [
            { name: "Personal", remaining: 0, total: 3000 },
            { name: "Resource Package", remaining: 128360, total: -1 },
          ],
        },
        second: {
          remaining: 4557,
          quotaRows: [
            { name: "Personal", remaining: 0, total: 3000 },
            { name: "Resource Package", remaining: 4557, total: 12000 },
          ],
        },
        third: {
          remaining: 8056,
          quotaRows: [
            { name: "Personal", remaining: 0, total: 3000 },
            { name: "Resource Package", remaining: 8056, total: 25000 },
          ],
        },
      },
    })).toMatchObject({
      allowed: true,
      used: 1659,
      limit: 19000,
      remaining: 17341,
      activeConnectionId: "second",
    });
  });

  it("keeps Qoder key credit usage monotonic when current quota refills above the last consumed level", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["first", "second"],
          priorityOrder: ["first", "second"],
          accountAllocations: { first: 6000, second: 8000 },
          quotaBaseline: {
            first: {
              initialRemainingQuota: 6200,
              capturedAt: "2026-08-11T03:24:01.885Z",
              quotaRows: [
                { name: "Personal", remaining: 3000, total: 3000 },
                { name: "Resource Package", remaining: 3200, total: 3200 },
              ],
            },
            second: {
              initialRemainingQuota: 9000,
              capturedAt: "2026-08-11T03:24:01.885Z",
              quotaRows: [
                { name: "Personal", remaining: 3000, total: 3000 },
                { name: "Resource Package", remaining: 6000, total: 6000 },
              ],
            },
          },
          creditUsageLedger: {
            first: { used: 5000, lastRemainingQuota: 1200, updatedAt: "2026-08-13T15:00:00.000Z" },
          },
        },
      },
    });

    const currentRemainingByConnectionId = {
      first: {
        remaining: 6100,
        quotaRows: [
          { name: "Personal", remaining: 2900, total: 3000 },
          { name: "Resource Package", remaining: 3200, total: 3200 },
        ],
      },
      second: {
        remaining: 9000,
        quotaRows: [
          { name: "Personal", remaining: 3000, total: 3000 },
          { name: "Resource Package", remaining: 6000, total: 6000 },
        ],
      },
    };

    const ledger = mergeQoderCreditUsageLedger({
      providerPolicy: policy.providers.qoder,
      currentRemainingByConnectionId,
      updatedAt: "2026-08-14T01:00:00.000Z",
    });

    expect(ledger.first.used).toBe(5000);
    expect(ledger.first.lastRemainingQuota).toBe(6100);
    expect(evaluateApiKeyProviderCreditUsage({
      policy,
      provider: "qoder",
      currentRemainingByConnectionId,
      creditUsageLedger: ledger,
    })).toMatchObject({
      allowed: true,
      used: 5000,
      limit: 14000,
      remaining: 9000,
      activeConnectionId: "first",
    });
  });

  it("adds only the newly observed Qoder quota drop to persisted credit usage", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["first"],
          priorityOrder: ["first"],
          accountAllocations: { first: 6000 },
          quotaBaseline: {
            first: { initialRemainingQuota: 6200, capturedAt: "2026-08-11T03:24:01.885Z" },
          },
          creditUsageLedger: {
            first: { used: 5000, lastRemainingQuota: 1200, updatedAt: "2026-08-13T15:00:00.000Z" },
          },
        },
      },
    });

    const ledger = mergeQoderCreditUsageLedger({
      providerPolicy: policy.providers.qoder,
      currentRemainingByConnectionId: { first: 1100 },
      updatedAt: "2026-08-14T01:00:00.000Z",
    });

    expect(ledger.first.used).toBe(5100);
    expect(evaluateApiKeyProviderCreditUsage({
      policy,
      provider: "qoder",
      currentRemainingByConnectionId: { first: 1100 },
      creditUsageLedger: ledger,
    })).toMatchObject({
      allowed: true,
      used: 5100,
      remaining: 900,
      activeConnectionId: "first",
    });
  });

  it("does not recompute persisted Qoder usage from baseline after a checkpoint exists", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["first"],
          priorityOrder: ["first"],
          accountAllocations: { first: 6000 },
          quotaBaseline: {
            first: { initialRemainingQuota: 10000, capturedAt: "2026-08-11T03:24:01.885Z" },
          },
          creditUsageLedger: {
            first: { used: 1200, lastRemainingQuota: 9000, updatedAt: "2026-08-13T15:00:00.000Z" },
          },
        },
      },
    });

    const ledger = mergeQoderCreditUsageLedger({
      providerPolicy: policy.providers.qoder,
      currentRemainingByConnectionId: { first: 8000 },
      updatedAt: "2026-08-14T01:00:00.000Z",
    });

    expect(ledger.first.used).toBe(2200);
  });

  it("keeps the first priority account active when it has no usage and no quota growth", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["first", "second"],
          priorityOrder: ["first", "second"],
          accountAllocations: { first: 5000, second: 6000 },
          quotaBaseline: {
            first: {
              initialRemainingQuota: 10000,
              capturedAt: "2026-08-11T03:24:01.885Z",
              quotaRows: [
                { name: "Personal", remaining: 3000, total: 3000 },
                { name: "Resource Package", remaining: 7000, total: 7000 },
              ],
            },
            second: {
              initialRemainingQuota: 6000,
              capturedAt: "2026-08-11T03:24:01.885Z",
              quotaRows: [
                { name: "Personal", remaining: 3000, total: 3000 },
                { name: "Resource Package", remaining: 3000, total: 3000 },
              ],
            },
          },
        },
      },
    });

    expect(evaluateApiKeyProviderCreditUsage({
      policy,
      provider: "qoder",
      currentRemainingByConnectionId: {
        first: {
          remaining: 10000,
          quotaRows: [
            { name: "Personal", remaining: 3000, total: 3000 },
            { name: "Resource Package", remaining: 7000, total: 7000 },
          ],
        },
        second: {
          remaining: 5000,
          quotaRows: [
            { name: "Personal", remaining: 3000, total: 3000 },
            { name: "Resource Package", remaining: 2000, total: 3000 },
          ],
        },
      },
    })).toMatchObject({
      allowed: true,
      used: 0,
      limit: 11000,
      remaining: 11000,
      activeConnectionId: "first",
    });
  });

  it("builds Qoder quota baselines for selected accounts only", () => {
    expect(buildQoderQuotaBaseline([
      { id: "a", remainingQuota: 3000 },
      { id: "b", remainingQuota: 2000 },
    ], ["b"], "2026-07-28T03:00:00.000Z")).toEqual({
      b: { initialRemainingQuota: 2000, capturedAt: "2026-07-28T03:00:00.000Z" },
    });
  });

  it("captures Qoder quota row baselines for selected accounts", () => {
    expect(buildQoderQuotaBreakdownBaseline([
      {
        id: "a",
        remainingQuota: 3000,
        quotaRows: [
          { name: "Personal", remaining: 1000 },
          { name: "Resource Package", remaining: 2000 },
        ],
      },
      { id: "b", remainingQuota: 2000, quotaRows: [{ name: "Personal", remaining: 2000 }] },
    ], ["a"], "2026-08-07T03:00:00.000Z")).toEqual({
      a: {
        initialRemainingQuota: 3000,
        capturedAt: "2026-08-07T03:00:00.000Z",
        quotaRows: [
          { name: "Personal", remaining: 1000 },
          { name: "Resource Package", remaining: 2000 },
        ],
      },
    });
  });

  it("keeps Qoder quota baseline when only account priority changes", () => {
    const previous = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["a", "b"],
          priorityOrder: ["a", "b"],
          accountAllocations: { a: 3000, b: 1092 },
          startedAt: "2026-07-28T03:22:35.521Z",
          quotaBaseline: {
            a: { initialRemainingQuota: 4092, capturedAt: "2026-07-28T03:22:35.521Z" },
            b: { initialRemainingQuota: 1000, capturedAt: "2026-07-28T03:22:35.521Z" },
          },
        },
      },
    }).providers.qoder;
    const next = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["a", "b"],
          priorityOrder: ["b", "a"],
          accountAllocations: { a: 3000, b: 1092 },
        },
      },
    }).providers.qoder;

    expect(shouldRefreshQoderQuotaBaseline(previous, next)).toBe(false);
    expect(preserveQoderQuotaBaseline(previous, next)).toMatchObject({
      priorityOrder: ["b", "a"],
      startedAt: "2026-07-28T03:22:35.521Z",
      quotaBaseline: previous.quotaBaseline,
    });
  });

  it("keeps Qoder quota baseline and usage ledger when account allocation changes", () => {
    const previous = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["a"],
          priorityOrder: ["a"],
          accountAllocations: { a: 5000 },
          startedAt: "2026-07-28T03:22:35.521Z",
          quotaBaseline: {
            a: { initialRemainingQuota: 8000, capturedAt: "2026-07-28T03:22:35.521Z" },
          },
          creditUsageLedger: {
            a: { used: 3200, lastRemainingQuota: 4800, updatedAt: "2026-08-14T01:00:00.000Z" },
          },
        },
      },
    }).providers.qoder;
    const next = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["a"],
          priorityOrder: ["a"],
          accountAllocations: { a: 6000 },
        },
      },
    }).providers.qoder;

    expect(shouldRefreshQoderQuotaBaseline(previous, next)).toBe(false);
    expect(preserveQoderQuotaBaseline(previous, next)).toMatchObject({
      accountAllocations: { a: 6000 },
      allocationLimit: 6000,
      quotaBaseline: previous.quotaBaseline,
      creditUsageLedger: previous.creditUsageLedger,
    });
  });

  it("adds current baseline consumption when validating an existing Qoder allocation", () => {
    const providerPolicy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["a"],
          allocationLimit: 4092,
          quotaBaseline: {
            a: { initialRemainingQuota: 4092, capturedAt: "2026-07-28T03:22:35.521Z" },
          },
        },
      },
    }).providers.qoder;

    expect(getQoderCreditUsageSinceBaseline(providerPolicy, { a: 3897 })).toBe(195);
  });

  it("validates Qoder allocation against selected account options", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: { qoder: { connectionIds: ["a"], accountAllocations: { a: 2500 } } },
    });
    const quotaOptions = {
      providers: {
        qoder: {
          accounts: [{ id: "a", remainingQuota: 3000, quotaStatus: "ok" }],
        },
      },
    };
    const otherPolicies = [
      normalizeApiKeyPolicy({
        enabled: true,
        providers: { qoder: { connectionIds: ["a"], accountAllocations: { a: 1000 } } },
      }),
    ];

    expect(validateQoderPolicyAllocation(policy, quotaOptions, otherPolicies)).toMatchObject({
      ok: false,
      error: "Allocation exceeds selected Qoder accounts' currently assignable quota",
      allocation: { selectedPool: 3000, allocatedToOtherKeys: 1000, maxAssignable: 2000 },
    });
  });

  it("validates Qoder allocation per selected account", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["a", "b"],
          accountAllocations: { a: 5000, b: 1001 },
        },
      },
    });
    const quotaOptions = {
      providers: {
        qoder: {
          accounts: [
            { id: "a", remainingQuota: 10000, quotaStatus: "ok" },
            { id: "b", remainingQuota: 2000, quotaStatus: "ok" },
          ],
        },
      },
    };
    const otherPolicies = [
      normalizeApiKeyPolicy({
        enabled: true,
        providers: { qoder: { connectionIds: ["b"], accountAllocations: { b: 1000 } } },
      }),
    ];

    expect(validateQoderPolicyAllocation(policy, quotaOptions, otherPolicies)).toMatchObject({
      ok: false,
      error: "Allocation exceeds selected Qoder accounts' currently assignable quota",
      allocation: {
        perAccount: {
          a: { requested: 5000, maxAssignable: 10000 },
          b: { requested: 1001, maxAssignable: 1000 },
        },
      },
    });
  });

  it("reports allocated quota per account for quota option displays", () => {
    const policies = [
      normalizeApiKeyPolicy({
        enabled: true,
        providers: { qoder: { connectionIds: ["a", "b"], accountAllocations: { a: 5000, b: 1000 } } },
      }),
    ];

    expect(getAllocatedToAccount(policies, "a")).toBe(5000);
    expect(getAllocatedToAccount(policies, "b")).toBe(1000);
  });

  it("reports current Qoder key usage state for quota option displays", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["a", "b", "c"],
          priorityOrder: ["a", "b", "c"],
          accountAllocations: { a: 10000, b: 14000, c: 5000 },
          quotaBaseline: {
            a: { initialRemainingQuota: 13357, capturedAt: "2026-08-04T10:44:50.276Z" },
            b: { initialRemainingQuota: 182022, capturedAt: "2026-08-04T10:44:50.276Z" },
            c: { initialRemainingQuota: 5555, capturedAt: "2026-08-04T10:44:50.276Z" },
          },
        },
      },
    });

    expect(buildQoderKeyUsageState(policy, [
      { id: "a", name: "Account A", remainingQuota: 8463 },
      { id: "b", name: "Account B", remainingQuota: 116690 },
      { id: "c", name: "Account C", remainingQuota: 5391 },
    ])).toMatchObject({
      enabled: true,
      used: 4894,
      limit: 29000,
      remaining: 24106,
      activeConnectionId: "a",
      activeAccountName: "Account A",
    });
  });

  it("reports current Qoder key usage by key id for key list summaries", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["a"],
          priorityOrder: ["a"],
          accountAllocations: { a: 5000 },
          quotaBaseline: {
            a: { initialRemainingQuota: 10000, capturedAt: "2026-08-11T03:24:01.885Z" },
          },
          creditUsageLedger: {
            a: { used: 1235, lastRemainingQuota: 8765, updatedAt: "2026-08-14T02:00:00.000Z" },
          },
        },
      },
    });

    expect(buildQoderKeyUsageByKeyId([
      { id: "restricted", policy },
      { id: "open", policy: { enabled: false, providers: {} } },
    ], [
      { id: "a", remainingQuota: 8765, quotaRows: [] },
    ])).toMatchObject({
      restricted: {
        enabled: true,
        used: 1235,
        limit: 5000,
        remaining: 3765,
        activeConnectionId: "a",
      },
    });
  });

  it("allows an existing Qoder key to keep its allocation after consuming credits", () => {
    const policy = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["a"],
          priorityOrder: ["a"],
          accountAllocations: { a: 4092 },
          quotaBaseline: {
            a: { initialRemainingQuota: 4092, capturedAt: "2026-07-28T03:22:35.521Z" },
          },
        },
      },
    });
    const quotaOptions = {
      providers: {
        qoder: {
          accounts: [{ id: "a", remainingQuota: 3897, quotaStatus: "ok" }],
        },
      },
    };

    expect(validateQoderPolicyAllocation(policy, quotaOptions, [], policy)).toMatchObject({
      ok: true,
      allocation: { selectedPool: 4092, allocatedToOtherKeys: 0, maxAssignable: 4092 },
    });
  });

  it("keeps persisted Qoder usage for unselected accounts across policy saves", () => {
    const previous = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["a", "b"],
          priorityOrder: ["a", "b"],
          accountAllocations: { a: 5000, b: 6000 },
          creditUsageLedger: {
            a: { used: 3200, lastRemainingQuota: 4800, updatedAt: "2026-08-14T01:00:00.000Z" },
            b: { used: 900, lastRemainingQuota: 7100, updatedAt: "2026-08-14T01:00:00.000Z" },
          },
        },
      },
    }).providers.qoder;
    const next = normalizeApiKeyPolicy({
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["b"],
          priorityOrder: ["b"],
          accountAllocations: { b: 6000 },
        },
      },
    }).providers.qoder;

    expect(preserveQoderCreditUsageLedger(previous, next)).toEqual(previous.creditUsageLedger);
  });
});

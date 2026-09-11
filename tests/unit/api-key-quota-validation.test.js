import { describe, expect, it } from "vitest";

import { validateQoderPolicyAllocation } from "../../src/app/api/keys/quota-options/route.js";

const ACCOUNT_A = { id: "acc-a", name: "Account A", remainingQuota: 10000, quotaRows: [], quotaStatus: "ok", allocatedToOtherKeys: 0 };
const ACCOUNT_B = { id: "acc-b", name: "Account B", remainingQuota: 5000, quotaRows: [], quotaStatus: "ok", allocatedToOtherKeys: 0 };

function quotaOptions(accounts) {
  return { providers: { qoder: { accounts } } };
}

function policy(connectionIds, accountAllocations) {
  const limit = Object.values(accountAllocations).reduce((sum, value) => sum + value, 0);
  return {
    enabled: true,
    providers: {
      qoder: { connectionIds, priorityOrder: connectionIds, accountAllocations, allocationLimit: limit, unit: "credits", metric: "credits" },
    },
  };
}

describe("validateQoderPolicyAllocation", () => {
  it("passes when every account allocation fits its assignable pool", () => {
    const result = validateQoderPolicyAllocation(
      policy(["acc-a", "acc-b"], { "acc-a": 4000, "acc-b": 1000 }),
      quotaOptions([ACCOUNT_A, ACCOUNT_B]),
      [],
    );
    expect(result.ok).toBe(true);
  });

  it("reports the exact account that exceeds its assignable pool", () => {
    const result = validateQoderPolicyAllocation(
      policy(["acc-a", "acc-b"], { "acc-a": 4000, "acc-b": 9000 }),
      quotaOptions([ACCOUNT_A, ACCOUNT_B]),
      [],
    );
    expect(result.ok).toBe(false);
    expect(result.exceededAccounts).toHaveLength(1);
    expect(result.exceededAccounts[0]).toMatchObject({
      connectionId: "acc-b",
      name: "Account B",
      missing: false,
      maxAssignable: 5000,
      requested: 9000,
    });
  });

  it("flags ghost allocations for accounts that no longer exist as missing", () => {
    const result = validateQoderPolicyAllocation(
      policy(["acc-a", "acc-ghost"], { "acc-a": 1000, "acc-ghost": 9000 }),
      quotaOptions([ACCOUNT_A]),
      [],
    );
    expect(result.ok).toBe(false);
    const ghost = result.exceededAccounts.find((item) => item.connectionId === "acc-ghost");
    expect(ghost).toBeTruthy();
    expect(ghost.missing).toBe(true);
    expect(ghost.maxAssignable).toBe(0);
    expect(ghost.requested).toBe(9000);
    // the healthy account must not be reported
    expect(result.exceededAccounts.some((item) => item.connectionId === "acc-a")).toBe(false);
  });

  it("keeps existing consumed credits assignable when re-saving the same key", () => {
    const existing = {
      enabled: true,
      providers: {
        qoder: {
          connectionIds: ["acc-a"],
          accountAllocations: { "acc-a": 6000 },
          allocationLimit: 6000,
          quotaBaseline: { "acc-a": { initialRemainingQuota: 10000 } },
          creditUsageLedger: { "acc-a": { used: 4000 } },
        },
      },
    };
    const accounts = [{ ...ACCOUNT_A, remainingQuota: 6000 }];
    const result = validateQoderPolicyAllocation(
      policy(["acc-a"], { "acc-a": 6000 }),
      quotaOptions(accounts),
      [],
      existing,
    );
    expect(result.ok).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { evaluateApiKeyProviderCreditUsage, getQoderAccountAllocationState, mergeQoderCreditUsageLedger } from "@/shared/services/apiKeyPolicy.js";
import { buildCcSwitchUsage } from "@/shared/services/ccSwitchUsage.js";
import { validateQoderPolicyAllocation } from "@/app/api/keys/quota-options/route.js";

const policy = (allocations, usage = {}) => ({ enabled: true, providers: { qoder: {
  connectionIds: Object.keys(allocations), priorityOrder: Object.keys(allocations),
  accountAllocations: allocations,
  quotaBaseline: Object.fromEntries(Object.keys(allocations).map(id => [id, { initialRemainingQuota: 10000 }])),
  creditUsageLedger: Object.fromEntries(Object.entries(usage).map(([id, used]) => [id, { used, precise: true }])),
} } });
const account = (id, remainingQuota = 8100) => ({ id, name: id, quotaStatus: "ok", remainingQuota, quotaRows: [] });
const options = (...accounts) => ({ providers: { qoder: { accounts } } });

describe("Key allocation and own credit consumption", () => {
  it("aggregates all account usage after selecting the first eligible route", () => {
    const p = policy({ a: 3000, b: 2000 }, { a: 1200, b: 700 });
    const state = evaluateApiKeyProviderCreditUsage({ policy: p, provider: "qoder", currentRemainingByConnectionId: { a: 8100, b: 4300 }, useBaselineFallback: false });
    expect(state).toMatchObject({ used: 1900, limit: 5000, remaining: 3100, activeConnectionId: "a" });
    expect(buildCcSwitchUsage({ providerPolicy: p.providers.qoder, accounts: [account("a"), account("b", 4300)] }))
      .toMatchObject({ used: 1900, total: 5000, remaining: 3100, balance: 3100 });
  });

  it("rejects lowering 3000 to 1000 after 1200 credits were used", () => {
    const result = validateQoderPolicyAllocation(policy({ a: 1000 }), options(account("a")), [], policy({ a: 3000 }, { a: 1200 }));
    expect(result).toMatchObject({ ok: false, error: "Allocation cannot be less than this key's used credits" });
    expect(result.belowUsageAccounts).toEqual([expect.objectContaining({ connectionId: "a", used: 1200, requested: 1000 })]);
  });

  it("reserves only the other key's unspent credits", () => {
    // Shared pool 5000: A spent 1200, B spent 700, pool now 3100.
    const result = validateQoderPolicyAllocation(policy({ a: 3000 }), options(account("a", 3100)), [policy({ a: 2000 }, { a: 700 })], policy({ a: 3000 }, { a: 1200 }));
    expect(result.ok).toBe(true);
    expect(result.allocation.perAccount.a).toMatchObject({ allocatedToOtherKeys: 1300, maxAssignable: 3000 });
  });

  it("uses the same account-row preview as the Key APIs", () => {
    const p = policy({ a: 3000 }, { a: 1200 }).providers.qoder;
    const a = { ...account("a", 3100), allocatedToOtherKeys: 1300 };
    expect(getQoderAccountAllocationState(p, a, 2000)).toMatchObject({ used: 1200, allocated: 2000, remaining: 800, maxAssignable: 3000, belowUsage: false });
    expect(getQoderAccountAllocationState(p, a, 1000)).toMatchObject({ used: 1200, belowUsage: true });
    expect(getQoderAccountAllocationState(p, a, 1200)).toMatchObject({ exhausted: true, remaining: 0, belowUsage: false });
    expect(getQoderAccountAllocationState(p, { ...a, quotaStatus: "unavailable", remainingQuota: null }, 2000))
      .toMatchObject({ used: 1200, remaining: 800, maxAssignable: null });
  });

  it("keeps removed account history and never adds another Key's observed balance drop", () => {
    const p = policy({ a: 3000 }, { a: 1200, removed: 700 }).providers.qoder;
    const ledger = mergeQoderCreditUsageLedger({ providerPolicy: p, currentRemainingByConnectionId: { a: 100 } });
    expect(ledger.a.used).toBe(1200);
    expect(ledger.removed.used).toBe(700);
  });

  it("reports real spending above the budget without clipping or hiding unavailable accounts", () => {
    const p = policy({ a: 3000, b: 2000 }, { a: 3001.25, b: 2000 });
    const result = buildCcSwitchUsage({ providerPolicy: p.providers.qoder, accounts: [account("a"), { ...account("b"), quotaStatus: "unavailable" }] });
    expect(result).toMatchObject({ used: 5001.25, total: 5000, remaining: 0, balance: 0 });
    const state = evaluateApiKeyProviderCreditUsage({ policy: p, provider: "qoder", currentRemainingByConnectionId: { a: 5000, b: null }, useBaselineFallback: false });
    expect(state).toMatchObject({ allowed: false, exhaustedConnectionIds: ["a", "b"], unavailableConnectionIds: ["b"] });
  });
});

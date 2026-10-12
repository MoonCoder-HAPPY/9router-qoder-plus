import {
  calculateAllowedAllocation, getAccountAllocationLimit, getAccountRemainingAllocation,
  getProviderPolicy, getQoderPersistedCreditUsage,
} from "./apiKeyPolicy.js";

export function validateQoderPolicyAllocation(policy, quotaOptions, otherPolicies, existingPolicy = null) {
  const qoderPolicy = getProviderPolicy(policy, "qoder");
  if (!qoderPolicy) return { ok: true };
  const selected = qoderPolicy.connectionIds;
  if (!selected.length) return { ok: false, error: "Select at least one Qoder account" };
  const existingQoderPolicy = existingPolicy?.providers?.qoder;
  const accounts = quotaOptions?.providers?.qoder?.accounts || [];
  const byId = new Map(accounts.map(account => [account.id, account]));
  const belowUsageAccounts = selected.flatMap(connectionId => {
    const used = getQoderPersistedCreditUsage(existingQoderPolicy, connectionId);
    const requested = getAccountAllocationLimit(qoderPolicy, connectionId);
    return requested < used ? [{ connectionId, name: byId.get(connectionId)?.name || connectionId, used, requested }] : [];
  });
  if (belowUsageAccounts.length) return {
    ok: false, error: "Allocation cannot be less than this key's used credits", belowUsageAccounts,
  };
  if (selected.some(id => {
    const account = byId.get(id);
    return account && account.quotaStatus !== "missing" && (account.quotaStatus !== "ok"
      || account.remainingQuota == null || !Number.isFinite(Number(account.remainingQuota)));
  })) return { ok: false, error: "Unable to validate selected Qoder account quota right now" };

  const perAccount = {}, exceededAccounts = [], accountRemainingById = {};
  for (const connectionId of selected) {
    const account = byId.get(connectionId);
    const missing = !account || account.quotaStatus === "missing";
    const used = getQoderPersistedCreditUsage(existingQoderPolicy, connectionId);
    const remaining = missing ? 0 : Math.max(0, Number(account.remainingQuota) || 0);
    const allocatedToOtherKeys = (otherPolicies || []).reduce((sum, other) => {
      const qoder = getProviderPolicy(other, "qoder");
      return sum + (qoder?.connectionIds.includes(connectionId)
        ? getAccountRemainingAllocation(qoder, connectionId) : 0);
    }, 0);
    const selectedPool = remaining + used;
    const maxAssignable = missing ? 0 : used + Math.max(0, remaining - allocatedToOtherKeys);
    const requested = getAccountAllocationLimit(qoderPolicy, connectionId);
    accountRemainingById[connectionId] = selectedPool;
    perAccount[connectionId] = { selectedPool, allocatedToOtherKeys, maxAssignable, requested };
    if (missing || requested > maxAssignable) exceededAccounts.push({
      connectionId, name: account?.name || connectionId, missing,
      remaining: selectedPool, allocatedToOtherKeys, maxAssignable, requested,
    });
  }
  const allocation = calculateAllowedAllocation({ selectedConnectionIds: selected, accountRemainingById, otherPolicies, provider: "qoder" });
  allocation.perAccount = perAccount;
  allocation.maxAssignable = Object.values(perAccount).reduce((sum, account) => sum + account.maxAssignable, 0);
  if (exceededAccounts.length) return {
    ok: false, error: "Allocation exceeds selected Qoder accounts' currently assignable quota", exceededAccounts, allocation,
  };
  return { ok: true, allocation };
}

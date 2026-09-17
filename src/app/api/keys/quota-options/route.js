import "open-sse/index.js";

import { NextResponse } from "next/server";
import { getApiKeys, getProviderConnections } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import {
  calculateAllowedAllocation,
  evaluateApiKeyProviderCreditUsage,
  getAccountAllocationLimit,
  getQoderPersistedCreditUsage,
  getProviderPolicy,
  sumQoderRemainingQuota,
} from "@/shared/services/apiKeyPolicy.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { queryQuotaAccounts, quotaEventResponse } from "@/shared/services/quotaQuery.js";

export const dynamic = "force-dynamic";

function getConnectionName(connection) {
  return connection.displayName || connection.name || connection.email || connection.id;
}

export function getAllocatedToAccount(policies, accountId, provider = "qoder") {
  return policies.reduce((sum, policy) => {
    const providerPolicy = getProviderPolicy(policy, provider);
    if (!providerPolicy?.allocationLimit) return sum;
    if (providerPolicy.connectionIds.length === 0) {
      return sum + providerPolicy.allocationLimit;
    }
    if (providerPolicy.connectionIds.includes(accountId)) {
      return sum + getAccountAllocationLimit(providerPolicy, accountId);
    }
    return sum;
  }, 0);
}

export function buildQoderKeyUsageState(policy, accounts) {
  const qoderPolicy = getProviderPolicy(policy, "qoder");
  if (!qoderPolicy || qoderPolicy.allocationLimit === null || qoderPolicy.allocationLimit === undefined) {
    return { enabled: false };
  }

  const accountMap = new Map((accounts || []).map((account) => [account.id, account]));
  const currentRemainingByConnectionId = Object.fromEntries(
    (qoderPolicy.connectionIds || []).map((connectionId) => {
      const account = accountMap.get(connectionId);
      const unavailable = !account || (account.quotaStatus != null && account.quotaStatus !== "ok")
        || account.remainingQuota == null || !Number.isFinite(Number(account.remainingQuota));
      return [
        connectionId,
        {
          remaining: unavailable ? Number.NaN : Number(account.remainingQuota),
          quotaRows: unavailable ? [] : account.quotaRows || [],
        },
      ];
    })
  );
  const usageState = evaluateApiKeyProviderCreditUsage({
    policy,
    provider: "qoder",
    currentRemainingByConnectionId,
    useBaselineFallback: true,
  });
  const activeAccount = usageState.activeConnectionId ? accountMap.get(usageState.activeConnectionId) : null;
  return {
    enabled: true,
    used: usageState.used,
    limit: usageState.limit,
    remaining: usageState.remaining,
    allowed: usageState.allowed,
    activeConnectionId: usageState.activeConnectionId || null,
    activeAccountName: activeAccount ? getConnectionName(activeAccount) : null,
    activeAccountEmail: activeAccount?.email || null,
    unavailableConnectionIds: usageState.unavailableConnectionIds || [],
  };
}

export function buildQoderKeyUsageByKeyId(keys, accounts) {
  return Object.fromEntries(
    (keys || [])
      .map((key) => [key.id, buildQoderKeyUsageState(key.policy, accounts)])
      .filter(([keyId, usage]) => keyId && usage?.enabled)
  );
}

export async function buildQoderQuotaOptions({ excludeKeyId = null, connectionIds = null, signal, emit } = {}) {
  const [allConnections, keys] = await Promise.all([
    getProviderConnections({ provider: "qoder" }), getApiKeys(),
  ]);
  if (signal?.aborted) return;
  const currentKey = keys.find(key => key.id === excludeKeyId);
  const currentPolicy = getProviderPolicy(currentKey?.policy, "qoder");
  const selectedIds = connectionIds ?? currentPolicy?.connectionIds ?? [];
  const selected = new Set(selectedIds);
  const connections = allConnections.filter(connection => connection.isActive !== false
    && (connectionIds === null || selected.has(connection.id)));
  const otherPolicies = keys.filter(key => key.id !== excludeKeyId && key.policy?.enabled).map(key => key.policy);
  const accounts = connections.map(connection => ({
    id: connection.id, name: getConnectionName(connection), email: connection.email || null,
    remainingQuota: null, quotaRows: [], quotaStatus: "loading", quotaMessage: null,
    allocatedToOtherKeys: getAllocatedToAccount(otherPolicies, connection.id),
  }));
  for (const id of selectedIds) {
    if (accounts.some(account => account.id === id)) continue;
    accounts.push({
      id, name: getConnectionName(allConnections.find(connection => connection.id === id) || { id }),
      email: null, remainingQuota: null, quotaRows: [], quotaStatus: "missing", quotaMessage: null,
      allocatedToOtherKeys: getAllocatedToAccount(otherPolicies, id),
    });
  }
  const options = () => ({ providers: { qoder: {
    accounts,
    keyUsage: buildQoderKeyUsageState(currentKey?.policy, accounts),
    keyUsageByKeyId: buildQoderKeyUsageByKeyId(keys, accounts),
  } } });
  emit?.({ type: "snapshot", policy: currentKey?.policy || null, ...options() });
  const queue = [...connections].sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)));
  await queryQuotaAccounts(queue, async (connection, querySignal) => {
    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    if (querySignal.aborted) throw querySignal.reason;
    const usage = await getUsageForProvider(connection, {
      ...proxyConfig, strictProxy: false, signal: querySignal,
    });
    if (usage?.message || usage?.error) throw new Error(usage.message || usage.error);
    const summed = sumQoderRemainingQuota(usage);
    if (!summed.rows.length) throw new Error("Qoder quota is unavailable");
    return { remainingQuota: summed.remaining, quotaRows: summed.rows, quotaStatus: "ok", quotaMessage: null };
  }, (connection, result) => {
    const index = accounts.findIndex(account => account.id === connection.id);
    accounts[index] = { ...accounts[index], ...result };
    emit?.({ type: "account", account: accounts[index], keyUsage: buildQoderKeyUsageState(currentKey?.policy, accounts) });
  }, { signal });
  if (!signal?.aborted) emit?.({ type: "complete" });
  return options();
}

export function validateQoderPolicyAllocation(policy, quotaOptions, otherPolicies, existingPolicy = null) {
  const qoderPolicy = getProviderPolicy(policy, "qoder");
  if (!qoderPolicy) {
    return { ok: true };
  }
  if (qoderPolicy.connectionIds.length === 0) return { ok: false, error: "Select at least one Qoder account" };
  const accounts = quotaOptions?.providers?.qoder?.accounts || [];
  const accountRemainingById = Object.fromEntries(accounts.map((account) => [account.id, account.remainingQuota || 0]));
  const existingQoderPolicy = getProviderPolicy(existingPolicy, "qoder");
  if (existingQoderPolicy) {
    for (const connectionId of qoderPolicy.connectionIds || []) {
      if (!existingQoderPolicy.connectionIds?.includes(connectionId)) continue;
      const initial = Number(existingQoderPolicy.quotaBaseline?.[connectionId]?.initialRemainingQuota);
      const current = Number(accountRemainingById[connectionId]);
      const baselineConsumed = Number.isFinite(initial) && Number.isFinite(current)
        ? Math.max(0, initial - current)
        : 0;
      const persistedConsumed = getQoderPersistedCreditUsage(existingQoderPolicy, connectionId);
      accountRemainingById[connectionId] = current + Math.max(baselineConsumed, persistedConsumed);
    }
  }
  const selectedConnectionIds = qoderPolicy.connectionIds;
  const hasUnavailableSelected = accounts.some((account) =>
    selectedConnectionIds.includes(account.id) && account.quotaStatus !== "missing"
      && (account.quotaStatus !== "ok" || account.remainingQuota == null || !Number.isFinite(Number(account.remainingQuota)))
  );
  if (hasUnavailableSelected) {
    return { ok: false, error: "Unable to validate selected Qoder account quota right now" };
  }
  const allocation = calculateAllowedAllocation({
    selectedConnectionIds,
    accountRemainingById,
    otherPolicies,
    provider: "qoder",
  });
  const accountById = Object.fromEntries(accounts.map((account) => [account.id, account]));
  const accountNameById = Object.fromEntries(accounts.map((account) => [account.id, account.name]));
  const perAccount = {};
  const exceededAccounts = [];
  let hasExceeded = false;
  for (const connectionId of selectedConnectionIds) {
    const selectedPool = Number(accountRemainingById[connectionId]) || 0;
    const allocatedToOtherKeys = (otherPolicies || []).reduce((sum, rawPolicy) => {
      const providerPolicy = getProviderPolicy(rawPolicy, "qoder");
      if (!providerPolicy || !providerPolicy.connectionIds?.includes(connectionId)) return sum;
      return sum + getAccountAllocationLimit(providerPolicy, connectionId);
    }, 0);
    const maxAssignable = Math.max(0, selectedPool - allocatedToOtherKeys);
    const requested = getAccountAllocationLimit(qoderPolicy, connectionId);
    perAccount[connectionId] = { selectedPool, allocatedToOtherKeys, maxAssignable, requested };
    if (requested > maxAssignable || !accountById[connectionId] || accountById[connectionId].quotaStatus === "missing") {
      hasExceeded = true;
      exceededAccounts.push({
        connectionId,
        name: accountNameById[connectionId] || connectionId,
        missing: accountById[connectionId]?.quotaStatus === "missing" || !accountNameById[connectionId],
        remaining: selectedPool,
        allocatedToOtherKeys,
        maxAssignable,
        requested,
      });
    }
  }
  allocation.perAccount = perAccount;
  if (hasExceeded || qoderPolicy.allocationLimit > allocation.maxAssignable) {
    return {
      ok: false,
      error: "Allocation exceeds selected Qoder accounts' currently assignable quota",
      exceededAccounts,
      allocation,
    };
  }
  return { ok: true, allocation };
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    if (searchParams.get("stream") === "1") {
      return quotaEventResponse((emit, signal) => buildQoderQuotaOptions({
        excludeKeyId: searchParams.get("excludeKeyId") || null, emit, signal,
      }), request.signal);
    }
    return NextResponse.json(await buildQoderQuotaOptions({
      excludeKeyId: searchParams.get("excludeKeyId") || null,
      signal: request.signal,
    }));
  } catch (error) {
    console.log("Error fetching quota options:", error);
    return NextResponse.json({ error: "Failed to fetch quota options" }, { status: 500 });
  }
}

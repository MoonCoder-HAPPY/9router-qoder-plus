import "open-sse/index.js";

import { NextResponse } from "next/server";
import { getApiKeys, getProviderConnections } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import {
  calculateAllowedAllocation,
  evaluateApiKeyProviderCreditUsage,
  getAccountAllocationLimit,
  getProviderPolicy,
  sumQoderRemainingQuota,
} from "@/shared/services/apiKeyPolicy.js";
import { getUsageForProvider } from "open-sse/services/usage.js";

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
    (qoderPolicy.connectionIds || []).map((connectionId) => [
      connectionId,
      {
        remaining: Number(accountMap.get(connectionId)?.remainingQuota) || 0,
        quotaRows: accountMap.get(connectionId)?.quotaRows || [],
      },
    ])
  );
  const usageState = evaluateApiKeyProviderCreditUsage({
    policy,
    provider: "qoder",
    currentRemainingByConnectionId,
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

export async function buildQoderQuotaOptions({ excludeKeyId = null } = {}) {
  const [connections, keys] = await Promise.all([
    getProviderConnections({ provider: "qoder", isActive: true }),
    getApiKeys(),
  ]);
  const otherPolicies = keys
    .filter((key) => key.id !== excludeKeyId)
    .map((key) => key.policy)
    .filter((policy) => policy?.enabled);

  const accounts = [];
  for (const connection of connections) {
    let remainingQuota = 0;
    let quotaRows = [];
    let quotaStatus = "ok";
    let quotaMessage = null;
    try {
      const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
      const usage = await getUsageForProvider(connection, {
        connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
        connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
        connectionNoProxy: proxyConfig.connectionNoProxy || "",
        vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
        strictProxy: false,
      });
      if (usage?.message || usage?.error) {
        quotaStatus = "unavailable";
        quotaMessage = usage.message || usage.error;
      } else {
        const summed = sumQoderRemainingQuota(usage);
        remainingQuota = summed.remaining;
        quotaRows = summed.rows;
      }
    } catch (error) {
      quotaStatus = "unavailable";
      quotaMessage = error.message;
    }

    accounts.push({
      id: connection.id,
      name: getConnectionName(connection),
      email: connection.email || null,
      remainingQuota,
      quotaRows,
      quotaStatus,
      quotaMessage,
      allocatedToOtherKeys: getAllocatedToAccount(otherPolicies, connection.id),
    });
  }

  const currentKey = keys.find((key) => key.id === excludeKeyId) || null;
  return {
    providers: {
      qoder: {
        accounts,
        keyUsage: buildQoderKeyUsageState(currentKey?.policy, accounts),
        keyUsageByKeyId: buildQoderKeyUsageByKeyId(keys, accounts),
      },
    },
  };
}

export function validateQoderPolicyAllocation(policy, quotaOptions, otherPolicies, existingPolicy = null) {
  const qoderPolicy = getProviderPolicy(policy, "qoder");
  if (!qoderPolicy || qoderPolicy.allocationLimit === null || qoderPolicy.allocationLimit === undefined) {
    return { ok: true };
  }
  const accounts = quotaOptions?.providers?.qoder?.accounts || [];
  const accountRemainingById = Object.fromEntries(accounts.map((account) => [account.id, account.remainingQuota || 0]));
  const existingQoderPolicy = getProviderPolicy(existingPolicy, "qoder");
  if (existingQoderPolicy) {
    for (const connectionId of qoderPolicy.connectionIds || []) {
      if (!existingQoderPolicy.connectionIds?.includes(connectionId)) continue;
      const initial = Number(existingQoderPolicy.quotaBaseline?.[connectionId]?.initialRemainingQuota);
      const current = Number(accountRemainingById[connectionId]);
      if (!Number.isFinite(initial) || !Number.isFinite(current)) continue;
      accountRemainingById[connectionId] = current + Math.max(0, initial - current);
    }
  }
  const selectedConnectionIds = qoderPolicy.connectionIds;
  const hasUnavailableSelected = accounts.some((account) =>
    selectedConnectionIds.includes(account.id) && account.quotaStatus === "unavailable"
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
  const perAccount = {};
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
    if (requested > maxAssignable) hasExceeded = true;
  }
  allocation.perAccount = perAccount;
  if (hasExceeded || qoderPolicy.allocationLimit > allocation.maxAssignable) {
    return {
      ok: false,
      error: "Allocation exceeds selected Qoder accounts' currently assignable quota",
      allocation,
    };
  }
  return { ok: true, allocation };
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    return NextResponse.json(await buildQoderQuotaOptions({
      excludeKeyId: searchParams.get("excludeKeyId") || null,
    }));
  } catch (error) {
    console.log("Error fetching quota options:", error);
    return NextResponse.json({ error: "Failed to fetch quota options" }, { status: 500 });
  }
}

import "open-sse/index.js";

import {
  getApiKeyByValue,
  getProviderConnections,
} from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { getProviderPolicy, sumQoderRemainingQuota } from "@/shared/services/apiKeyPolicy.js";
import { buildCcSwitchUsage } from "@/shared/services/ccSwitchUsage.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { queryQuotaAccounts } from "@/shared/services/quotaQuery.js";

function extractBearerKey(request) {
  const authorization = request.headers.get("authorization") || "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return request.headers.get("x-api-key")?.trim() || "";
}

async function loadAccountUsage(connection, signal) {
  try {
    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
    const usage = await getUsageForProvider(connection, {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
      signal,
    });
    if (usage?.message || usage?.error) {
      return {
        id: connection.id,
        name: connection.displayName || connection.name || connection.email || connection.id,
        quotaStatus: "unavailable",
        quotaMessage: usage.message || usage.error,
        remainingQuota: null,
        quotaRows: [],
      };
    }
    const summed = sumQoderRemainingQuota(usage);
    if (!summed.rows.length) throw new Error("Qoder quota is unavailable");
    return {
      id: connection.id,
      name: connection.displayName || connection.name || connection.email || connection.id,
      quotaStatus: "ok",
      remainingQuota: summed.remaining,
      quotaRows: summed.rows,
      quotaCheckedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      id: connection.id,
      name: connection.displayName || connection.name || connection.email || connection.id,
      quotaStatus: "unavailable",
      quotaMessage: error.message,
      remainingQuota: null,
      quotaRows: [],
    };
  }
}

export async function queryCcSwitchUsage(request, { includeActiveField = false } = {}) {
  const apiKey = extractBearerKey(request);
  if (!apiKey) {
    return {
      status: 401,
      body: {
        isValid: false,
        ...(includeActiveField ? { is_active: false } : {}),
        error: "Invalid API key",
      },
    };
  }

  const apiKeyRecord = await getApiKeyByValue(apiKey);
  if (!apiKeyRecord?.isActive) {
    return {
      status: 401,
      body: {
        isValid: false,
        ...(includeActiveField ? { is_active: false } : {}),
        error: "Invalid API key",
      },
    };
  }

  const providerPolicy = getProviderPolicy(apiKeyRecord.policy, "qoder");
  let connections = await getProviderConnections({ provider: "qoder", isActive: true });
  if (providerPolicy?.connectionIds.length > 0) {
    const allowed = new Set(providerPolicy.connectionIds);
    connections = connections.filter((connection) => allowed.has(connection.id));
  }

  const allocated = providerPolicy?.allocationLimit != null;
  if (connections.length === 0 && !allocated) {
    return {
      status: 200,
      body: {
        isValid: false,
        ...(includeActiveField ? { is_active: true } : {}),
        error: "No active Qoder accounts",
        invalidMessage: "No active Qoder accounts are available.",
      },
    };
  }

  // Actual availability must include official-channel consumption.
  const results = new Map();
  await queryQuotaAccounts(connections, loadAccountUsage, (connection, result) => {
    results.set(connection.id, { id: connection.id, name: connection.name || connection.id, ...result });
  }, { signal: request.signal });
  const accounts = connections.map(connection => results.get(connection.id) || {
    id: connection.id, quotaStatus: "unavailable", remainingQuota: null, quotaRows: [],
  });

  const usage = buildCcSwitchUsage({
    keyName: apiKeyRecord.name || apiKeyRecord.id,
    providerPolicy,
    accounts,
  });
  return {
    status: 200,
    body: {
      ...usage,
      ...(includeActiveField ? { is_active: true } : {}),
    },
  };
}

import "open-sse/index.js";

import { NextResponse } from "next/server";
import {
  getApiKeyByValue,
  getProviderConnections,
} from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { getProviderPolicy, sumQoderRemainingQuota } from "@/shared/services/apiKeyPolicy.js";
import { buildCcSwitchUsage } from "@/shared/services/ccSwitchUsage.js";
import { getUsageForProvider } from "open-sse/services/usage.js";

export const dynamic = "force-dynamic";

function extractBearerKey(request) {
  const authorization = request.headers.get("authorization") || "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return request.headers.get("x-api-key")?.trim() || "";
}

function invalidKeyResponse() {
  return NextResponse.json(
    { isValid: false, error: "Invalid API key" },
    { status: 401 },
  );
}

async function loadAccountUsage(connection) {
  try {
    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
    const usage = await getUsageForProvider(connection, {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
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
    return {
      id: connection.id,
      name: connection.displayName || connection.name || connection.email || connection.id,
      quotaStatus: "ok",
      remainingQuota: summed.remaining,
      quotaRows: summed.rows,
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

export async function POST(request) {
  const apiKey = extractBearerKey(request);
  if (!apiKey) return invalidKeyResponse();

  const apiKeyRecord = await getApiKeyByValue(apiKey);
  if (!apiKeyRecord?.isActive) return invalidKeyResponse();

  const providerPolicy = getProviderPolicy(apiKeyRecord.policy, "qoder");
  let connections = await getProviderConnections({ provider: "qoder", isActive: true });
  if (
    providerPolicy?.allocationLimit !== null
    && providerPolicy?.allocationLimit !== undefined
    && providerPolicy.connectionIds.length > 0
  ) {
    const allowed = new Set(providerPolicy.connectionIds);
    connections = connections.filter((connection) => allowed.has(connection.id));
  }

  if (connections.length === 0) {
    return NextResponse.json({
      isValid: false,
      error: "No active Qoder accounts",
      invalidMessage: "No active Qoder accounts are available.",
    });
  }

  const accounts = [];
  for (const connection of connections) {
    accounts.push(await loadAccountUsage(connection));
  }

  return NextResponse.json(buildCcSwitchUsage({
    keyName: apiKeyRecord.name || apiKeyRecord.id,
    providerPolicy,
    accounts,
  }));
}

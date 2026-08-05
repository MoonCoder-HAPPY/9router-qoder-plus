import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools, getApiKeyByValue, getApiKeyPolicyUsedTokens } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import {
  API_KEY_POLICY_LIMIT_METRIC,
  evaluateApiKeyProviderCreditUsage,
  evaluateApiKeyProviderUsage,
  filterConnectionsByApiKeyPolicy,
  getOrderedPolicyConnectionIds,
  getPolicyConnectionIds,
  getProviderPolicy,
  sumQoderRemainingQuota,
} from "@/shared/services/apiKeyPolicy.js";
import { notifyApiKeyQuotaExhausted, notifyApiKeyQuotaThresholdExceeded } from "@/shared/services/modelIdleAlert.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();
const QODER_POLICY_QUOTA_TTL_MS = 60 * 1000;
if (!global._qoderPolicyQuotaCache) global._qoderPolicyQuotaCache = new Map();
const qoderPolicyQuotaCache = global._qoderPolicyQuotaCache;

async function getQoderRemainingQuotaForPolicy(connection) {
  const cached = qoderPolicyQuotaCache.get(connection.id);
  if (cached && Date.now() - cached.ts < QODER_POLICY_QUOTA_TTL_MS) return cached.remaining;

  const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
  const usage = await getUsageForProvider(connection, {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: false,
  });
  if (usage?.message || usage?.error) throw new Error(usage.message || usage.error);
  const remaining = sumQoderRemainingQuota(usage).remaining;
  qoderPolicyQuotaCache.set(connection.id, { remaining, ts: Date.now() });
  return remaining;
}

async function getQoderRemainingByConnectionId(connections, connectionIds) {
  const allowedIds = new Set(connectionIds || []);
  const result = {};
  for (const connection of connections) {
    if (allowedIds.size > 0 && !allowedIds.has(connection.id)) continue;
    result[connection.id] = await getQoderRemainingQuotaForPolicy(connection);
  }
  return result;
}

function invalidateQoderPolicyQuotaCache(connectionId) {
  if (!connectionId) return;
  qoderPolicyQuotaCache.delete(connectionId);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    const providerPolicy = getProviderPolicy(options?.apiKeyPolicy, providerId);
    const policyFilteredConnections = filterConnectionsByApiKeyPolicy(connections, options?.apiKeyPolicy, providerId);
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, policyAllowed: ${policyFilteredConnections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    if (providerPolicy?.connectionIds?.length > 0 && policyFilteredConnections.length === 0) {
      log.warn("AUTH", `${provider} | API key policy blocks all active accounts`);
      return {
        policyBlocked: true,
        status: 403,
        message: `API key is not allowed to use any active ${providerId} account`,
      };
    }

    if (providerPolicy?.allocationLimit !== null && providerPolicy?.allocationLimit !== undefined) {
      const connectionIds = getPolicyConnectionIds(options?.apiKeyPolicy, providerId);
      let usageState;
      if (providerId === "qoder" && providerPolicy.metric === API_KEY_POLICY_LIMIT_METRIC.CREDITS) {
        try {
          const remainingByConnectionId = await getQoderRemainingByConnectionId(policyFilteredConnections, connectionIds);
          usageState = evaluateApiKeyProviderCreditUsage({
            policy: options?.apiKeyPolicy,
            provider: providerId,
            currentRemainingByConnectionId: remainingByConnectionId,
          });
        } catch (error) {
          log.warn("AUTH", `${provider} | API key quota check skipped: ${error.message}`);
          usageState = { allowed: true };
        }
      } else {
        const used = await getApiKeyPolicyUsedTokens({
          apiKey: options?.apiKeyValue || null,
          provider: providerId,
          connectionIds,
          startDate: providerPolicy.startedAt || null,
        });
        usageState = evaluateApiKeyProviderUsage({
          policy: options?.apiKeyPolicy,
          provider: providerId,
          used,
        });
      }
      if (!usageState.allowed) {
        log.warn("AUTH", `${provider} | API key quota exhausted (${usageState.used}/${usageState.limit})`);
        notifyApiKeyQuotaExhausted({
          keyId: options?.apiKeyRecord?.id || "unknown",
          keyName: options?.apiKeyRecord?.name || options?.apiKeyRecord?.id || "unknown",
          provider: providerId,
          used: usageState.used,
          limit: usageState.limit,
          remaining: usageState.remaining,
        }).catch((error) => {
          log.warn("AUTH", `${provider} | API key quota alert failed: ${error.message}`);
        });
        return {
          quotaExhausted: true,
          status: 429,
          message: `API key quota exhausted for ${providerId}`,
          used: usageState.used,
          limit: usageState.limit,
          remaining: usageState.remaining,
        };
      }
      notifyApiKeyQuotaThresholdExceeded({
        keyId: options?.apiKeyRecord?.id || "unknown",
        keyName: options?.apiKeyRecord?.name || options?.apiKeyRecord?.id || "unknown",
        provider: providerId,
        used: usageState.used,
        limit: usageState.limit,
        remaining: usageState.remaining,
      }).catch((error) => {
        log.warn("AUTH", `${provider} | API key quota threshold alert failed: ${error.message}`);
      });
      if (providerId === "qoder" && usageState.activeConnectionId && !excludeSet.has(usageState.activeConnectionId)) {
        const activeId = usageState.activeConnectionId;
        policyFilteredConnections.splice(
          0,
          policyFilteredConnections.length,
          ...policyFilteredConnections.filter((connection) => connection.id === activeId),
        );
        log.debug("AUTH", `${provider} | API key quota priority pinned to ${activeId.slice(0, 8)} (${usageState.used}/${usageState.limit})`);
      }
    }

    // Filter out model-locked and excluded connections
    const orderedPolicyIds = providerPolicy ? getOrderedPolicyConnectionIds(options?.apiKeyPolicy, providerId) : [];
    const priorityIndex = new Map(orderedPolicyIds.map((id, index) => [id, index]));
    const availableConnections = policyFilteredConnections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      return true;
    }).sort((a, b) => {
      const ai = priorityIndex.has(a.id) ? priorityIndex.get(a.id) : Number.MAX_SAFE_INTEGER;
      const bi = priorityIndex.has(b.id) ? priorityIndex.get(b.id) : Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest lock expiry across all connections for retry timing
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    cooldownMs = Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";
  const lockUpdate = buildModelLockUpdate(model, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  invalidateQoderPolicyQuotaCache(connectionId);
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, { testStatus: "active", lastError: null, lastErrorAt: null, backoffLevel: 0 });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}

export async function getApiKeyRecord(apiKey) {
  if (!apiKey) return null;
  const record = await getApiKeyByValue(apiKey);
  if (!record?.isActive) return null;
  return record;
}

export async function buildApiKeyOptions(apiKey) {
  const apiKeyRecord = await getApiKeyRecord(apiKey);
  return {
    apiKeyRecord,
    apiKeyPolicy: apiKeyRecord?.policy || null,
    apiKeyValue: apiKey || null,
  };
}

export function policyCredentialsResponse(credentials, errorResponse) {
  if (credentials?.policyBlocked || credentials?.quotaExhausted) {
    return errorResponse(credentials.status || 403, credentials.message || "API key policy blocked this request");
  }
  return null;
}

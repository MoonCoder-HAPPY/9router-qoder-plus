export const API_KEY_POLICY_LIMIT_METRIC = {
  CREDITS: "credits",
  TOKENS: "tokens",
};

const EMPTY_POLICY = Object.freeze({ enabled: false, providers: {} });

function parsePolicy(input) {
  if (!input) return null;
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (typeof input === "object" && !Array.isArray(input)) return input;
  return null;
}

function normalizeConnectionIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function normalizeBaseline(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [connectionId, raw] of Object.entries(value)) {
    const id = typeof connectionId === "string" ? connectionId.trim() : "";
    if (!id || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const initialRemainingQuota = Number(raw.initialRemainingQuota);
    if (!Number.isFinite(initialRemainingQuota) || initialRemainingQuota < 0) continue;
    result[id] = {
      initialRemainingQuota,
      capturedAt: typeof raw.capturedAt === "string" && raw.capturedAt ? raw.capturedAt : null,
    };
  }
  return result;
}

function normalizeAccountAllocations(value, connectionIds) {
  const selected = new Set(connectionIds);
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [connectionId, raw] of Object.entries(value)) {
    const id = typeof connectionId === "string" ? connectionId.trim() : "";
    if (!id || !selected.has(id)) continue;
    const limit = normalizeLimit(raw);
    if (limit === null || limit === 0) continue;
    result[id] = limit;
  }
  return result;
}

export function normalizeApiKeyPolicy(input) {
  const parsed = parsePolicy(input);
  if (!parsed) return { ...EMPTY_POLICY };
  const providers = {};
  const rawProviders = parsed.providers && typeof parsed.providers === "object" && !Array.isArray(parsed.providers)
    ? parsed.providers
    : {};

  for (const [provider, raw] of Object.entries(rawProviders)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const providerId = String(provider).trim();
    if (!providerId) continue;
    const metric = typeof raw.metric === "string" && raw.metric.trim()
      ? raw.metric.trim()
      : API_KEY_POLICY_LIMIT_METRIC.CREDITS;
    const connectionIds = normalizeConnectionIds(raw.connectionIds);
    const selectedSet = new Set(connectionIds);
    const priorityOrder = normalizeConnectionIds(raw.priorityOrder).filter((id) => selectedSet.has(id));
    let accountAllocations = normalizeAccountAllocations(raw.accountAllocations, connectionIds);
    if (Object.keys(accountAllocations).length === 0) {
      const legacyLimit = normalizeLimit(raw.allocationLimit);
      const legacyTarget = priorityOrder[0] || connectionIds[0];
      if (legacyLimit !== null && legacyTarget) accountAllocations = { [legacyTarget]: legacyLimit };
    }
    const allocationLimit = Object.values(accountAllocations).reduce((sum, value) => sum + value, 0);
    providers[providerId] = {
      connectionIds,
      priorityOrder,
      allocationLimit: allocationLimit > 0 ? allocationLimit : null,
      accountAllocations,
      unit: typeof raw.unit === "string" && raw.unit.trim() ? raw.unit.trim() : "credits",
      metric: providerId === "qoder" ? API_KEY_POLICY_LIMIT_METRIC.CREDITS : metric,
      startedAt: typeof raw.startedAt === "string" && raw.startedAt ? raw.startedAt : null,
      quotaBaseline: normalizeBaseline(raw.quotaBaseline),
    };
  }

  return {
    enabled: parsed.enabled === true,
    providers,
  };
}

export function getProviderPolicy(policyInput, provider) {
  const policy = normalizeApiKeyPolicy(policyInput);
  if (!policy.enabled || !provider) return null;
  return policy.providers[provider] || null;
}

export function hasProviderRestriction(policyInput, provider) {
  const providerPolicy = getProviderPolicy(policyInput, provider);
  if (!providerPolicy) return false;
  return providerPolicy.connectionIds.length > 0 || providerPolicy.allocationLimit !== null;
}

export function filterConnectionsByApiKeyPolicy(connections, policyInput, provider) {
  const providerPolicy = getProviderPolicy(policyInput, provider);
  if (!providerPolicy || providerPolicy.connectionIds.length === 0) return connections;
  const allowed = new Set(providerPolicy.connectionIds);
  return connections.filter((connection) => allowed.has(connection.id));
}

export function getPolicyConnectionIds(policyInput, provider) {
  return getProviderPolicy(policyInput, provider)?.connectionIds || [];
}

export function getOrderedPolicyConnectionIds(policyInput, provider) {
  const providerPolicy = getProviderPolicy(policyInput, provider);
  if (!providerPolicy) return [];
  const selected = normalizeConnectionIds(providerPolicy.connectionIds);
  if (selected.length === 0) return [];
  const selectedSet = new Set(selected);
  const ordered = normalizeConnectionIds(providerPolicy.priorityOrder).filter((id) => selectedSet.has(id));
  const orderedSet = new Set(ordered);
  return [...ordered, ...selected.filter((id) => !orderedSet.has(id))];
}

export function getAccountAllocationLimit(providerPolicy, connectionId) {
  const allocation = Number(providerPolicy?.accountAllocations?.[connectionId]);
  if (Number.isFinite(allocation) && allocation > 0) return allocation;
  return 0;
}

export function evaluateApiKeyProviderUsage({ policy, provider, used }) {
  const providerPolicy = getProviderPolicy(policy, provider);
  const limit = providerPolicy?.allocationLimit;
  if (limit === null || limit === undefined) {
    return { allowed: true, used: Number(used) || 0, limit: null, remaining: null };
  }
  const usedAmount = Math.max(0, Number(used) || 0);
  const remaining = Math.max(0, limit - usedAmount);
  if (usedAmount >= limit) {
    return { allowed: false, reason: "quota_exhausted", used: usedAmount, limit, remaining };
  }
  return { allowed: true, used: usedAmount, limit, remaining };
}

export function evaluateApiKeyProviderCreditUsage({ policy, provider, currentRemainingByConnectionId }) {
  const providerPolicy = getProviderPolicy(policy, provider);
  const limit = providerPolicy?.allocationLimit;
  if (limit === null || limit === undefined) {
    return { allowed: true, used: 0, limit: null, remaining: null, unavailableConnectionIds: [] };
  }

  const selectedConnectionIds = getOrderedPolicyConnectionIds(policy, provider);
  const baseline = providerPolicy.quotaBaseline || {};
  let used = 0;
  const unavailableConnectionIds = [];
  let activeConnectionId = null;

  for (const connectionId of selectedConnectionIds) {
    const initial = Number(baseline[connectionId]?.initialRemainingQuota);
    const current = Number(currentRemainingByConnectionId?.[connectionId]);
    if (!Number.isFinite(initial) || !Number.isFinite(current)) {
      unavailableConnectionIds.push(connectionId);
      continue;
    }
    const accountLimit = getAccountAllocationLimit(providerPolicy, connectionId);
    const consumed = Math.max(0, initial - current);
    const countedConsumed = accountLimit > 0 ? Math.min(consumed, accountLimit) : 0;
    used += countedConsumed;
    if (current > 0 && consumed < accountLimit) {
      activeConnectionId = connectionId;
      break;
    }
  }

  const usedAmount = Math.max(0, used);
  const remaining = Math.max(0, limit - usedAmount);
  if (usedAmount >= limit) {
    return { allowed: false, reason: "quota_exhausted", used: usedAmount, limit, remaining, unavailableConnectionIds, activeConnectionId };
  }
  return { allowed: true, used: usedAmount, limit, remaining, unavailableConnectionIds, activeConnectionId };
}

export function buildQoderQuotaBaseline(accounts, selectedConnectionIds, capturedAt = new Date().toISOString()) {
  const selected = new Set(normalizeConnectionIds(selectedConnectionIds));
  const baseline = {};
  for (const account of accounts || []) {
    if (!selected.has(account?.id)) continue;
    baseline[account.id] = {
      initialRemainingQuota: Number(account.remainingQuota) || 0,
      capturedAt,
    };
  }
  return baseline;
}

export function getQoderCreditUsageSinceBaseline(providerPolicy, currentRemainingByConnectionId) {
  const baseline = providerPolicy?.quotaBaseline || {};
  let used = 0;
  for (const connectionId of providerPolicy?.connectionIds || []) {
    const initial = Number(baseline[connectionId]?.initialRemainingQuota);
    const current = Number(currentRemainingByConnectionId?.[connectionId]);
    if (!Number.isFinite(initial) || !Number.isFinite(current)) continue;
    used += Math.max(0, initial - current);
  }
  return used;
}

export function shouldRefreshQoderQuotaBaseline(previousProviderPolicy, nextProviderPolicy) {
  if (!nextProviderPolicy) return false;
  if (!previousProviderPolicy) return true;
  const previousIds = normalizeConnectionIds(previousProviderPolicy.connectionIds).sort();
  const nextIds = normalizeConnectionIds(nextProviderPolicy.connectionIds).sort();
  if (previousIds.length !== nextIds.length || previousIds.some((id, index) => id !== nextIds[index])) return true;
  const allIds = new Set([...previousIds, ...nextIds]);
  for (const id of allIds) {
    if (getAccountAllocationLimit(previousProviderPolicy, id) !== getAccountAllocationLimit(nextProviderPolicy, id)) {
      return true;
    }
  }
  return false;
}

export function preserveQoderQuotaBaseline(previousProviderPolicy, nextProviderPolicy) {
  if (!nextProviderPolicy) return nextProviderPolicy;
  return {
    ...nextProviderPolicy,
    startedAt: previousProviderPolicy?.startedAt || nextProviderPolicy.startedAt || null,
    quotaBaseline: previousProviderPolicy?.quotaBaseline || nextProviderPolicy.quotaBaseline || {},
  };
}

export function sumQoderRemainingQuota(usage) {
  const quotas = usage?.quotas && typeof usage.quotas === "object" ? usage.quotas : {};
  const rows = [];
  for (const [quotaType, quota] of Object.entries(quotas)) {
    if (quotaType === "organization" && (!quota || (Number(quota.total) || 0) === 0)) continue;
    const name = quotaType === "user" ? "Personal" : quotaType === "organization" ? "Resource Package" : quotaType;
    rows.push({
      name,
      remaining: Number(quota?.remaining) || 0,
      total: Number(quota?.total) || 0,
      used: Number(quota?.used) || 0,
      unit: quota?.unit || "credits",
      resetAt: quota?.resetAt || null,
    });
  }
  return {
    remaining: rows.reduce((sum, row) => sum + row.remaining, 0),
    rows,
  };
}

export function calculateAllowedAllocation({ selectedConnectionIds, accountRemainingById, otherPolicies, provider }) {
  const selected = new Set(normalizeConnectionIds(selectedConnectionIds));
  const selectedPool = [...selected].reduce((sum, id) => sum + (Number(accountRemainingById?.[id]) || 0), 0);
  let allocatedToOtherKeys = 0;

  for (const rawPolicy of otherPolicies || []) {
    const providerPolicy = getProviderPolicy(rawPolicy, provider);
    if (!providerPolicy || !providerPolicy.allocationLimit) continue;
    if (providerPolicy.connectionIds.length === 0) {
      if (selected.size > 0) allocatedToOtherKeys += providerPolicy.allocationLimit;
      continue;
    }
    for (const id of providerPolicy.connectionIds) {
      if (selected.has(id)) allocatedToOtherKeys += getAccountAllocationLimit(providerPolicy, id);
    }
  }

  return {
    selectedPool,
    allocatedToOtherKeys,
    maxAssignable: Math.max(0, selectedPool - allocatedToOtherKeys),
  };
}

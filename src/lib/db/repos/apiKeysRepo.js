import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { stringifyJson } from "../helpers/jsonCol.js";
import {
  applyQoderPreciseCreditUsage,
  mergeQoderCreditUsageLedger,
  normalizeApiKeyPolicy,
} from "@/shared/services/apiKeyPolicy.js";
import { validateQoderPolicyAllocation } from "@/shared/services/qoderKeyAllocation.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    policy: normalizeApiKeyPolicy(row.policy),
    createdAt: row.createdAt,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function getApiKeyByValue(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function getOtherApiKeyPolicies(excludeId) {
  const db = await getAdapter();
  const rows = db.all(`SELECT policy FROM apiKeys WHERE id <> ?`, [excludeId]);
  return rows
    .map((row) => normalizeApiKeyPolicy(row.policy))
    .filter((policy) => policy.enabled);
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    policy: normalizeApiKeyPolicy(null),
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, policy, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, stringifyJson(apiKey.policy), apiKey.createdAt]
  );
  return apiKey;
}

export async function updateApiKey(id, data, { qoderQuotaOptions = null, preserveQoderUsage = false } = {}) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const current = rowToKey(row);
    const merged = { ...current, ...data };
    merged.policy = normalizeApiKeyPolicy(merged.policy);
    if (qoderQuotaOptions) {
      // The network lookup happens outside the transaction. Recheck current
      // usage and other Keys' reservations inside it before applying a budget.
      const otherPolicies = db.all(`SELECT policy FROM apiKeys WHERE id <> ?`, [id])
        .map(other => normalizeApiKeyPolicy(other.policy));
      const validation = validateQoderPolicyAllocation(merged.policy, qoderQuotaOptions, otherPolicies, current.policy);
      if (!validation.ok) throw Object.assign(new Error(validation.error), { validation });
    }
    if (preserveQoderUsage || qoderQuotaOptions) {
      const previousQoder = current.policy.providers.qoder;
      const nextQoder = merged.policy.providers.qoder;
      if (nextQoder) {
        nextQoder.creditUsageLedger = {
          ...nextQoder.creditUsageLedger,
          ...previousQoder?.creditUsageLedger,
        };
        nextQoder.startedAt = previousQoder?.startedAt || nextQoder.startedAt;
        nextQoder.quotaBaseline = { ...nextQoder.quotaBaseline, ...previousQoder?.quotaBaseline };
      } else if (previousQoder) {
        merged.policy.providers.qoder = previousQoder;
      }
    }
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, policy = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, stringifyJson(merged.policy), id]
    );
    result = merged;
  });
  return result;
}

export async function updateApiKeyQoderCreditUsageLedger(id, currentRemainingByConnectionId, updatedAt = new Date().toISOString()) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const apiKey = rowToKey(row);
    const policy = normalizeApiKeyPolicy(apiKey.policy);
    if (!policy.enabled || !policy.providers.qoder) return;
    const ledger = mergeQoderCreditUsageLedger({
      providerPolicy: policy.providers.qoder,
      currentRemainingByConnectionId,
      updatedAt,
    });
    policy.providers.qoder = {
      ...policy.providers.qoder,
      creditUsageLedger: ledger,
    };
    db.run(`UPDATE apiKeys SET policy = ? WHERE id = ?`, [stringifyJson(policy), id]);
    result = rowToKey({ ...row, policy: stringifyJson(policy) });
  });
  return result;
}

export async function recordApiKeyQoderCreditUsage(apiKey, connectionId, credits, updatedAt = new Date().toISOString()) {
  if (!apiKey || !connectionId) return null;
  const amount = Number(credits);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [apiKey]);
    if (!row) return;
    const record = rowToKey(row);
    const policy = normalizeApiKeyPolicy(record.policy);
    if (!policy.providers.qoder) return;

    const ledger = applyQoderPreciseCreditUsage({
      providerPolicy: policy.providers.qoder,
      connectionId,
      credits: amount,
      updatedAt,
    });
    policy.providers.qoder = {
      ...policy.providers.qoder,
      creditUsageLedger: ledger,
    };
    db.run(`UPDATE apiKeys SET policy = ? WHERE id = ?`, [stringifyJson(policy), record.id]);
    result = rowToKey({ ...row, policy: stringifyJson(policy) });
  });
  return result;
}

export async function resetApiKeyQoderCreditUsage(id, quotaBaseline, resetAt = new Date().toISOString()) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const apiKey = rowToKey(row);
    const policy = normalizeApiKeyPolicy(apiKey.policy);
    if (!policy.enabled || !policy.providers.qoder) return;
    policy.providers.qoder = {
      ...policy.providers.qoder,
      startedAt: resetAt,
      quotaBaseline: quotaBaseline && typeof quotaBaseline === "object" && !Array.isArray(quotaBaseline) ? quotaBaseline : {},
      creditUsageLedger: {},
    };
    db.run(`UPDATE apiKeys SET policy = ? WHERE id = ?`, [stringifyJson(policy), id]);
    result = rowToKey({ ...row, policy: stringifyJson(policy) });
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}

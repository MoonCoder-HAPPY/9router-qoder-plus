import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { stringifyJson } from "../helpers/jsonCol.js";
import { mergeQoderCreditUsageLedger, normalizeApiKeyPolicy } from "@/shared/services/apiKeyPolicy.js";

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

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    merged.policy = normalizeApiKeyPolicy(merged.policy);
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

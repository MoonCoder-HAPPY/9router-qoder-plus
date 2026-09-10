import {
  evaluateApiKeyProviderCreditUsage,
  getProviderPolicy,
} from "@/shared/services/apiKeyPolicy.js";

function effectiveTotal(row) {
  const total = Number(row?.total);
  if (Number.isFinite(total) && total >= 0) return total;
  return Math.max(0, Number(row?.used) || 0) + Math.max(0, Number(row?.remaining) || 0);
}

function accountRows(accounts) {
  return accounts
    .filter((account) => account.quotaStatus !== "unavailable")
    .flatMap((account) => {
      if (Array.isArray(account.quotaRows) && account.quotaRows.length > 0) {
        return account.quotaRows;
      }
      const remaining = Number(account.remainingQuota);
      return Number.isFinite(remaining)
        ? [{ name: account.name || account.id, total: remaining, used: 0, remaining }]
        : [];
    });
}

function buildExtra({ accounts, activeConnectionId }) {
  const unavailable = accounts.filter((account) => account.quotaStatus === "unavailable").length;
  const active = accounts.find((account) => account.id === activeConnectionId);
  const parts = [`${accounts.length} accounts`];
  if (active?.name) parts.push(`active: ${active.name}`);
  else if (active?.id) parts.push(`active: ${active.id}`);
  if (unavailable > 0) parts.push(`${unavailable} account${unavailable === 1 ? "" : "s"} unavailable`);
  return parts.join(" · ");
}

export function buildCcSwitchUsage({ keyName, providerPolicy, accounts = [] }) {
  const qoderPolicy = getProviderPolicy(
    { enabled: true, providers: { qoder: providerPolicy } },
    "qoder",
  );

  if (qoderPolicy?.allocationLimit !== null && qoderPolicy?.allocationLimit !== undefined) {
    const accountMap = new Map(accounts.map((account) => [account.id, account]));
    const currentRemainingByConnectionId = Object.fromEntries(
      (qoderPolicy.connectionIds || []).map((connectionId) => {
        const account = accountMap.get(connectionId);
        const unavailable = !account || account.quotaStatus === "unavailable";
        return [
          connectionId,
          {
            remaining: unavailable ? Number.NaN : Number(account.remainingQuota),
            quotaRows: unavailable ? [] : account.quotaRows || [],
          },
        ];
      }),
    );
    const state = evaluateApiKeyProviderCreditUsage({
      policy: { enabled: true, providers: { qoder: qoderPolicy } },
      provider: "qoder",
      currentRemainingByConnectionId,
      useBaselineFallback: true,
    });
    const total = qoderPolicy.allocationLimit;
    const used = Math.min(total, Math.max(0, Number(state.used) || 0));
    const remaining = Math.max(0, total - used);
    return {
      isValid: true,
      balance: remaining,
      remaining,
      total,
      used,
      unit: "credits",
      planName: `${keyName || "Qoder"} allocated credits`,
      extra: buildExtra({ accounts, activeConnectionId: state.activeConnectionId }),
    };
  }

  const rows = accountRows(accounts);
  const total = rows.reduce((sum, row) => sum + effectiveTotal(row), 0);
  const used = rows.reduce((sum, row) => sum + Math.max(0, Number(row.used) || 0), 0);
  const remaining = Math.max(0, total - used);
  return {
    isValid: true,
    balance: remaining,
    remaining,
    total,
    used,
    unit: "credits",
    planName: "Qoder all accounts",
    extra: buildExtra({ accounts }),
  };
}

"use client";

import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Button, ConfirmModal, Input, Modal, Toggle } from "@/shared/components";
import { translate } from "@/i18n/runtime";

function normalizeEditablePolicy(policy) {
  const qoder = policy?.providers?.qoder || {};
  const connectionIds = Array.isArray(qoder.connectionIds) ? qoder.connectionIds : [];
  const selected = new Set(connectionIds);
  const priorityOrder = Array.isArray(qoder.priorityOrder)
    ? qoder.priorityOrder.filter((id) => selected.has(id))
    : [];
  const ordered = [...priorityOrder, ...connectionIds.filter((id) => !priorityOrder.includes(id))];
  const accountAllocations = qoder.accountAllocations && typeof qoder.accountAllocations === "object"
    ? Object.fromEntries(connectionIds.map((id) => [id, qoder.accountAllocations[id] ?? ""]).filter(([, value]) => value !== ""))
    : {};
  if (Object.keys(accountAllocations).length === 0 && qoder.allocationLimit !== undefined && ordered[0]) {
    accountAllocations[ordered[0]] = qoder.allocationLimit;
  }
  return {
    enabled: policy?.enabled === true,
    connectionIds,
    priorityOrder: ordered,
    accountAllocations,
  };
}

function hasExplicitPriority(policy) {
  const qoder = policy?.providers?.qoder;
  return Array.isArray(qoder?.priorityOrder) && qoder.priorityOrder.length > 0;
}

function formatNumber(value) {
  const n = Number(value) || 0;
  return new Intl.NumberFormat().format(n);
}

function getExistingConsumedByAccount(policy, accountId, remainingQuota) {
  const qoder = policy?.providers?.qoder;
  if (!qoder?.connectionIds?.includes(accountId)) return 0;
  const initial = Number(qoder.quotaBaseline?.[accountId]?.initialRemainingQuota);
  const current = Number(remainingQuota);
  const baselineConsumed = Number.isFinite(initial) && Number.isFinite(current)
    ? Math.max(0, initial - current)
    : 0;
  const ledgerUsed = Number(qoder.creditUsageLedger?.[accountId]?.used);
  return Math.max(baselineConsumed, Number.isFinite(ledgerUsed) ? ledgerUsed : 0);
}

function getAssignableCreditsForAccount(policy, account) {
  const preservedConsumed = getExistingConsumedByAccount(policy, account.id, account.remainingQuota);
  return Math.max(
    0,
    (Number(account.remainingQuota) || 0) + preservedConsumed - (Number(account.allocatedToOtherKeys) || 0)
  );
}

function getAccountUsageDisplay(policy, account, allocationValue) {
  const allocated = Number(allocationValue) || 0;
  const used = getExistingConsumedByAccount(policy, account.id, account.remainingQuota);
  const remaining = Math.max(0, allocated - used);
  return {
    allocated,
    used,
    remaining,
    exhausted: allocated > 0 && remaining <= 0,
  };
}

function sortSelectedByAccountList(selectedIds, accounts) {
  const selected = new Set(selectedIds);
  const ordered = accounts.map((account) => account.id).filter((id) => selected.has(id));
  return [...ordered, ...selectedIds.filter((id) => !ordered.includes(id))];
}

export default function ApiKeyRestrictionsModal({ apiKeyItem, isOpen, onClose, onSaved }) {
  const [form, setForm] = useState(() => normalizeEditablePolicy(apiKeyItem?.policy));
  const [priorityEdited, setPriorityEdited] = useState(() => hasExplicitPriority(apiKeyItem?.policy));
  const [quotaOptions, setQuotaOptions] = useState(null);
  const [loadingOptions, setLoadingOptions] = useState(() => isOpen && !!apiKeyItem);
  const [saving, setSaving] = useState(false);
  const [resettingUsage, setResettingUsage] = useState(false);
  const [confirmResetUsage, setConfirmResetUsage] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isOpen || !apiKeyItem) return;
    let cancelled = false;
    fetch(`/api/keys/quota-options?excludeKeyId=${encodeURIComponent(apiKeyItem.id)}`, { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load quota options");
        if (!cancelled) setQuotaOptions(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingOptions(false);
      });
    return () => { cancelled = true; };
  }, [apiKeyItem, isOpen]);

  const accounts = useMemo(() => quotaOptions?.providers?.qoder?.accounts || [], [quotaOptions]);
  const accountIndex = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  const selectedAccountList = useMemo(
    () => form.connectionIds.map((id) => accountIndex.get(id)).filter(Boolean),
    [accountIndex, form.connectionIds]
  );
  const priorityAccounts = useMemo(
    () => form.priorityOrder.map((id) => accountIndex.get(id)).filter(Boolean),
    [accountIndex, form.priorityOrder]
  );
  const selectedPool = selectedAccountList.reduce((sum, account) =>
    sum + (Number(account.remainingQuota) || 0) + getExistingConsumedByAccount(apiKeyItem?.policy, account.id, account.remainingQuota), 0);
  const keyUsage = quotaOptions?.providers?.qoder?.keyUsage;
  const allocatedElsewhere = selectedAccountList.reduce((sum, account) => sum + (Number(account.allocatedToOtherKeys) || 0), 0);
  const maxAssignable = Math.max(0, selectedPool - allocatedElsewhere);
  const totalAllocation = Object.values(form.accountAllocations).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const allocationTooHigh = form.enabled && selectedAccountList.some((account) => {
    const requested = Number(form.accountAllocations[account.id]) || 0;
    const preservedConsumed = getExistingConsumedByAccount(apiKeyItem?.policy, account.id, account.remainingQuota);
    const assignable = Math.max(
      0,
      (Number(account.remainingQuota) || 0) + preservedConsumed - (Number(account.allocatedToOtherKeys) || 0)
    );
    return requested > assignable;
  });

  function toggleConnection(id) {
    setForm((prev) => {
      const selected = new Set(prev.connectionIds);
      let priorityOrder;
      if (selected.has(id)) {
        selected.delete(id);
        priorityOrder = prev.priorityOrder.filter((item) => item !== id);
        const { [id]: _removed, ...accountAllocations } = prev.accountAllocations;
        return { ...prev, connectionIds: [...selected], priorityOrder, accountAllocations };
      } else {
        selected.add(id);
        const selectedIds = [...selected];
        priorityOrder = priorityEdited
          ? [...prev.priorityOrder, id]
          : sortSelectedByAccountList(selectedIds, accounts);
      }
      return {
        ...prev,
        connectionIds: [...selected],
        priorityOrder,
        accountAllocations: { ...prev.accountAllocations, [id]: prev.accountAllocations[id] ?? "" },
      };
    });
  }

  function movePriority(id, direction) {
    setPriorityEdited(true);
    setForm((prev) => {
      const priorityOrder = [...prev.priorityOrder];
      const index = priorityOrder.indexOf(id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= priorityOrder.length) return prev;
      [priorityOrder[index], priorityOrder[nextIndex]] = [priorityOrder[nextIndex], priorityOrder[index]];
      return { ...prev, priorityOrder };
    });
  }

  function updateAccountAllocation(id, value) {
    setForm((prev) => ({
      ...prev,
      accountAllocations: { ...prev.accountAllocations, [id]: value },
    }));
  }

  async function save() {
    if (!apiKeyItem) return;
    setSaving(true);
    setError("");
    const policy = form.enabled
      ? {
          enabled: true,
          providers: {
            qoder: {
              connectionIds: form.connectionIds,
              priorityOrder: form.priorityOrder,
              accountAllocations: Object.fromEntries(
                form.connectionIds.map((id) => [id, Number(form.accountAllocations[id]) || 0])
              ),
              unit: "credits",
              metric: "credits",
            },
          },
        }
      : { enabled: false, providers: {} };

    try {
      const res = await fetch(`/api/keys/${apiKeyItem.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save restrictions");
      onSaved(data.key);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function resetUsage() {
    if (!apiKeyItem) return;
    setResettingUsage(true);
    setError("");
    try {
      const res = await fetch(`/api/keys/${apiKeyItem.id}/qoder-usage/reset`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to reset Qoder usage");
      setConfirmResetUsage(false);
      onSaved(data.key);
    } catch (e) {
      setError(e.message);
    } finally {
      setResettingUsage(false);
    }
  }

  return (
    <>
      <Modal isOpen={isOpen} title={translate("API Key Restrictions")} onClose={onClose} size="lg">
        <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Enable restrictions</p>
            <p className="text-xs text-text-muted">{apiKeyItem?.name || "API key"}</p>
          </div>
          <Toggle
            checked={form.enabled}
            onChange={(enabled) => setForm((prev) => ({ ...prev, enabled }))}
          />
        </div>

        {form.enabled && (
          <>
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-surface-2 border-b border-border flex items-center justify-between">
                <p className="text-sm font-medium">Qoder Accounts</p>
                <p className="text-xs text-text-muted">
                  {loadingOptions ? "Loading..." : (
                    <>
                      <span>{formatNumber(form.connectionIds.length)}</span> <span>selected</span>
                    </>
                  )}
                </p>
              </div>
              {keyUsage?.enabled && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 border-b border-border bg-surface px-3 py-3 text-center">
                  <div className="rounded border border-border bg-surface-2 p-2">
                    <p className="text-xs text-text-muted">Used / Total</p>
                    <p className="text-sm font-semibold">
                      {formatNumber(keyUsage.used)} / {formatNumber(keyUsage.limit)}
                    </p>
                  </div>
                  <div className="rounded border border-border bg-surface-2 p-2">
                    <p className="text-xs text-text-muted">Remaining</p>
                    <p className="text-sm font-semibold">{formatNumber(keyUsage.remaining)}</p>
                  </div>
                  <div className="rounded border border-border bg-surface-2 p-2 min-w-0">
                    <p className="text-xs text-text-muted">Active Account</p>
                    <p className="text-sm font-semibold truncate" title={keyUsage.activeAccountName || "None"}>
                      {keyUsage.activeAccountName || "None"}
                    </p>
                  </div>
                  <p className="col-span-full text-[11px] leading-snug text-text-muted">
                    {translate("Usage is measured from the moment this key's allocation is saved. Qoder settles credits with a short delay, so very recent calls may appear a few minutes late.")}
                  </p>
                </div>
              )}
              <div className="max-h-72 overflow-auto">
                {accounts.length === 0 && (
                  <div className="p-4 text-sm text-text-muted">
                    {loadingOptions ? "Loading Qoder accounts..." : "No active Qoder accounts found."}
                  </div>
                )}
                {accounts.map((account) => {
                  const isSelected = form.connectionIds.includes(account.id);
                  const assignableCredits = getAssignableCreditsForAccount(apiKeyItem?.policy, account);
                  return (
                  <div
                    key={account.id}
                    className="flex gap-3 p-3 border-b border-border last:border-b-0 hover:bg-surface-2/70"
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleConnection(account.id)}
                      className="mt-1 cursor-pointer"
                      aria-label={translate("Select account")}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            {isSelected && (
                              <span className="shrink-0 inline-flex h-5 items-center justify-center rounded bg-brand-500/10 px-2 text-[11px] font-semibold text-brand-600">
                                Selected
                              </span>
                            )}
                            <p className="text-sm font-medium truncate">{account.name}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <p className="text-xs text-text-muted whitespace-nowrap">
                            {account.quotaStatus === "unavailable" ? "Unavailable" : (
                              <>
                                <span>{formatNumber(account.remainingQuota)}</span> <span>left</span>
                              </>
                            )}
                          </p>
                        </div>
                      </div>
                      {account.email && <p className="text-xs text-text-muted truncate">{account.email}</p>}
                      {account.quotaRows?.length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-2">
                          {account.quotaRows.map((row) => (
                            <span key={row.name} className="text-xs px-2 py-1 rounded bg-surface-2 text-text-muted">
                              {row.name}: {formatNumber(row.remaining)} / {formatNumber(row.total)}
                            </span>
                          ))}
                        </div>
                      )}
                      {isSelected && (
                        <div className="mt-3 max-w-xs">
                          <Input
                            label="Allocated credits"
                            type="number"
                            min="0"
                            value={form.accountAllocations[account.id] ?? ""}
                            onChange={(e) => updateAccountAllocation(account.id, e.target.value)}
                            placeholder="1000"
                          />
                        </div>
                      )}
                      {account.allocatedToOtherKeys > 0 && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                          <span>{formatNumber(account.allocatedToOtherKeys)}</span> <span>allocated to other keys</span>
                          <span> · </span>
                          <span>Assignable</span>: <span>{formatNumber(assignableCredits)}</span>
                        </p>
                      )}
                      {account.allocatedToOtherKeys <= 0 && (
                        <p className="text-xs text-text-muted mt-2">
                          <span>Assignable</span>: <span>{formatNumber(assignableCredits)}</span>
                        </p>
                      )}
                      {account.quotaMessage && (
                        <p className="text-xs text-red-500 mt-2">{account.quotaMessage}</p>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>

            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-surface-2 border-b border-border">
                <p className="text-sm font-medium">Consumption Priority</p>
                <p className="text-xs text-text-muted">
                  Used when multiple selected accounts still have assigned credits.
                </p>
              </div>
              {priorityAccounts.length === 0 ? (
                <div className="p-3 text-sm text-text-muted">Select accounts to set priority.</div>
              ) : (
                <div>
                  {priorityAccounts.map((account, index) => {
                    const usage = getAccountUsageDisplay(apiKeyItem?.policy, account, form.accountAllocations[account.id]);
                    const isActive = keyUsage?.activeConnectionId === account.id && !usage.exhausted;
                    const rowClassName = usage.exhausted
                      ? "bg-surface-2/80 text-text-muted"
                      : isActive
                        ? "bg-orange-50/80 dark:bg-orange-500/10"
                        : "bg-surface";
                    return (
                    <div
                      key={account.id}
                      className={`flex items-center gap-3 p-3 border-b border-border last:border-b-0 ${rowClassName}`}
                    >
                      <span className={`shrink-0 inline-flex h-6 min-w-6 items-center justify-center rounded px-1 text-xs font-semibold ${
                        usage.exhausted
                          ? "bg-surface-3 text-text-muted"
                          : isActive
                            ? "bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300"
                            : "bg-brand-500/10 text-brand-600"
                      }`}>
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <p className="text-sm font-medium truncate">{account.name}</p>
                          {usage.exhausted && (
                            <span className="shrink-0 inline-flex rounded bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-text-muted">
                              Exhausted
                            </span>
                          )}
                          {isActive && (
                            <span className="shrink-0 inline-flex rounded bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700 dark:bg-orange-500/20 dark:text-orange-300">
                              In use
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-text-muted">
                          <span>Allocated credits</span>: <span>{formatNumber(usage.allocated)}</span>
                          <span> · </span>
                          <span>Used</span>: <span>{formatNumber(usage.used)}</span>
                          <span> · </span>
                          <span>Remaining allocation</span>: <span>{formatNumber(usage.remaining)}</span>
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => movePriority(account.id, -1)}
                          disabled={index === 0}
                          className="h-8 w-8 rounded text-text-muted hover:bg-surface-3 hover:text-text-main disabled:opacity-30 disabled:hover:bg-transparent"
                          title={translate("Move up")}
                          aria-label={translate("Move account up")}
                        >
                          <span className="material-symbols-outlined text-[18px]">keyboard_arrow_up</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => movePriority(account.id, 1)}
                          disabled={index === priorityAccounts.length - 1}
                          className="h-8 w-8 rounded text-text-muted hover:bg-surface-3 hover:text-text-main disabled:opacity-30 disabled:hover:bg-transparent"
                          title={translate("Move down")}
                          aria-label={translate("Move account down")}
                        >
                          <span className="material-symbols-outlined text-[18px]">keyboard_arrow_down</span>
                        </button>
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-border p-2">
                <p className="text-xs text-text-muted">Total Allocation</p>
                <p className="text-sm font-semibold">{formatNumber(totalAllocation)}</p>
              </div>
              <div className="rounded-lg border border-border p-2">
                <p className="text-xs text-text-muted">Allocated Elsewhere</p>
                <p className="text-sm font-semibold">{formatNumber(allocatedElsewhere)}</p>
              </div>
              <div className="rounded-lg border border-border p-2">
                <p className="text-xs text-text-muted">Max Assignable</p>
                <p className="text-sm font-semibold">{formatNumber(maxAssignable)}</p>
              </div>
            </div>

            {allocationTooHigh && (
              <p className="text-sm text-red-500">
                Allocation exceeds the currently assignable Qoder quota.
              </p>
            )}
          </>
        )}

        {error && <p className="text-sm text-red-500">{error}</p>}

        <div className="flex gap-2">
          {form.enabled && keyUsage?.enabled && (
            <Button
              type="button"
              variant="danger"
              icon="restart_alt"
              onClick={() => setConfirmResetUsage(true)}
              disabled={resettingUsage || saving}
              fullWidth
            >
              Reset usage
            </Button>
          )}
          <Button onClick={save} fullWidth disabled={saving || allocationTooHigh}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            Cancel
          </Button>
        </div>
        </div>
      </Modal>
      <ConfirmModal
        isOpen={confirmResetUsage}
        onClose={() => !resettingUsage && setConfirmResetUsage(false)}
        onConfirm={resetUsage}
        title={translate("Reset Qoder Usage")}
        message={translate("Reset this key's recorded Qoder usage to 0 and start counting again from the current account quotas? This cannot be undone.")}
        confirmText={translate("Reset usage")}
        cancelText={translate("Cancel")}
        variant="danger"
        loading={resettingUsage}
      />
    </>
  );
}

ApiKeyRestrictionsModal.propTypes = {
  apiKeyItem: PropTypes.object,
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func.isRequired,
};

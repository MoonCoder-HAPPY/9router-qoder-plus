import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, getOtherApiKeyPolicies, updateApiKey } from "@/lib/localDb";
import {
  buildQoderQuotaBreakdownBaseline,
  getProviderPolicy,
  normalizeApiKeyPolicy,
  preserveQoderCreditUsageLedger,
  preserveQoderQuotaBaseline,
  shouldRefreshQoderQuotaBaseline,
} from "@/shared/services/apiKeyPolicy.js";
import { buildQoderQuotaOptions, validateQoderPolicyAllocation } from "../quota-options/route.js";

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, policy } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    let qoderQuotaOptions = null;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (policy !== undefined) {
      const normalizedPolicy = normalizeApiKeyPolicy(policy);
      if (normalizedPolicy.enabled) {
        const selectedIds = getProviderPolicy(normalizedPolicy, "qoder")?.connectionIds || [];
        if (selectedIds.length === 0) {
          return NextResponse.json({ error: "Select at least one Qoder account" }, { status: 400 });
        }
        const [quotaOptions, otherPolicies] = await Promise.all([
          buildQoderQuotaOptions({ excludeKeyId: id, connectionIds: selectedIds, signal: request.signal }),
          getOtherApiKeyPolicies(id),
        ]);
        qoderQuotaOptions = quotaOptions;
        const validation = validateQoderPolicyAllocation(normalizedPolicy, quotaOptions, otherPolicies, existing.policy);
        if (!validation.ok) {
          return NextResponse.json({ error: validation.error, belowUsageAccounts: validation.belowUsageAccounts || [], exceededAccounts: validation.exceededAccounts || [], allocation: validation.allocation }, { status: 400 });
        }
        const qoderPolicy = getProviderPolicy(normalizedPolicy, "qoder");
        if (qoderPolicy) {
          const previousQoderPolicy = existing.policy?.providers?.qoder;
          if (shouldRefreshQoderQuotaBaseline(previousQoderPolicy, qoderPolicy)) {
            const accounts = quotaOptions?.providers?.qoder?.accounts || [];
            const capturedAt = new Date().toISOString();
            normalizedPolicy.providers.qoder = {
              ...normalizedPolicy.providers.qoder,
              startedAt: previousQoderPolicy?.startedAt || capturedAt,
              quotaBaseline: Object.fromEntries(Object.entries(
                buildQoderQuotaBreakdownBaseline(accounts, qoderPolicy.connectionIds, capturedAt)
              ).map(([connectionId, baseline]) => [connectionId,
                previousQoderPolicy?.connectionIds?.includes(connectionId)
                  ? previousQoderPolicy.quotaBaseline?.[connectionId] || baseline : baseline,
              ])),
              creditUsageLedger: preserveQoderCreditUsageLedger(previousQoderPolicy, qoderPolicy),
            };
          } else {
            normalizedPolicy.providers.qoder = preserveQoderQuotaBaseline(previousQoderPolicy, normalizedPolicy.providers.qoder);
          }
          const nextQoder = normalizedPolicy.providers.qoder;
          for (const connectionId of qoderPolicy.connectionIds) {
            nextQoder.creditUsageLedger[connectionId] ??= { used: 0, precise: true };
          }
        }
      } else if (existing.policy?.providers?.qoder) {
        // Disabling restrictions does not erase a Key's recorded credits.
        normalizedPolicy.providers.qoder = existing.policy.providers.qoder;
      }
      updateData.policy = normalizedPolicy;
    }

    const updated = await updateApiKey(id, updateData, { qoderQuotaOptions, preserveQoderUsage: policy !== undefined });

    return NextResponse.json({ key: updated });
  } catch (error) {
    if (error.validation) {
      return NextResponse.json({ error: error.message,
        belowUsageAccounts: error.validation.belowUsageAccounts || [],
        exceededAccounts: error.validation.exceededAccounts || [],
        allocation: error.validation.allocation,
      }, { status: 400 });
    }
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}

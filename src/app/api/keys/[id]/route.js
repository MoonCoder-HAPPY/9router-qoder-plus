import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, getOtherApiKeyPolicies, updateApiKey } from "@/lib/localDb";
import {
  buildQoderQuotaBaseline,
  getProviderPolicy,
  normalizeApiKeyPolicy,
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
    if (isActive !== undefined) updateData.isActive = isActive;
    if (policy !== undefined) {
      const normalizedPolicy = normalizeApiKeyPolicy(policy);
      if (normalizedPolicy.enabled) {
        const [quotaOptions, otherPolicies] = await Promise.all([
          buildQoderQuotaOptions({ excludeKeyId: id }),
          getOtherApiKeyPolicies(id),
        ]);
        const validation = validateQoderPolicyAllocation(normalizedPolicy, quotaOptions, otherPolicies, existing.policy);
        if (!validation.ok) {
          return NextResponse.json({ error: validation.error, allocation: validation.allocation }, { status: 400 });
        }
        const qoderPolicy = getProviderPolicy(normalizedPolicy, "qoder");
        if (qoderPolicy) {
          const previousQoderPolicy = getProviderPolicy(existing.policy, "qoder");
          if (shouldRefreshQoderQuotaBaseline(previousQoderPolicy, qoderPolicy)) {
            const accounts = quotaOptions?.providers?.qoder?.accounts || [];
            const capturedAt = new Date().toISOString();
            normalizedPolicy.providers.qoder = {
              ...normalizedPolicy.providers.qoder,
              startedAt: capturedAt,
              quotaBaseline: buildQoderQuotaBaseline(accounts, qoderPolicy.connectionIds, capturedAt),
            };
          } else {
            normalizedPolicy.providers.qoder = preserveQoderQuotaBaseline(previousQoderPolicy, normalizedPolicy.providers.qoder);
          }
        }
      }
      updateData.policy = normalizedPolicy;
    }

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
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

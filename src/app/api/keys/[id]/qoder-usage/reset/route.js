import { NextResponse } from "next/server";
import { getApiKeyById, resetApiKeyQoderCreditUsage } from "@/lib/localDb";
import { buildQoderQuotaBreakdownBaseline, getProviderPolicy } from "@/shared/services/apiKeyPolicy.js";
import { resetApiKeyQuotaAlertState } from "@/shared/services/modelIdleAlert.js";
import { buildQoderQuotaOptions } from "../../../quota-options/route.js";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const qoderPolicy = getProviderPolicy(key.policy, "qoder");
    if (!qoderPolicy) {
      return NextResponse.json({ error: "Qoder restrictions are not enabled for this key" }, { status: 400 });
    }

    const quotaOptions = await buildQoderQuotaOptions({ excludeKeyId: id });
    const accounts = quotaOptions?.providers?.qoder?.accounts || [];
    const resetAt = new Date().toISOString();
    const updated = await resetApiKeyQoderCreditUsage(
      id,
      buildQoderQuotaBreakdownBaseline(accounts, qoderPolicy.connectionIds, resetAt),
      resetAt
    );
    await resetApiKeyQuotaAlertState(id);

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error resetting Qoder key usage:", error);
    return NextResponse.json({ error: "Failed to reset Qoder key usage" }, { status: 500 });
  }
}

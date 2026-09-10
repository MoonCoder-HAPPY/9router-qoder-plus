import { NextResponse } from "next/server";
import { queryCcSwitchUsage } from "@/lib/ccSwitchUsageRequest";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const result = await queryCcSwitchUsage(request, { includeActiveField: true });
  return NextResponse.json(result.body, { status: result.status });
}

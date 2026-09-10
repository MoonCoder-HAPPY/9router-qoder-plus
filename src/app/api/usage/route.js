import { NextResponse } from "next/server";
import { queryCcSwitchUsage } from "@/lib/ccSwitchUsageRequest";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const result = await queryCcSwitchUsage(request);
  return NextResponse.json(result.body, { status: result.status });
}

import { NextResponse } from "next/server";
import {
  getQoderPublicModelMappings,
  setQoderPublicModelMapping,
} from "@/lib/qoder/publicModels.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const mappings = await getQoderPublicModelMappings();
    return NextResponse.json({ mappings });
  } catch (error) {
    console.log("Error fetching Qoder public model mappings:", error);
    return NextResponse.json({ error: "Failed to fetch Qoder public model mappings" }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const { internalId, publicId } = await request.json();
    const mapping = await setQoderPublicModelMapping(internalId, publicId);
    return NextResponse.json({ success: true, mapping });
  } catch (error) {
    console.log("Error saving Qoder public model mapping:", error);
    return NextResponse.json({ error: error.message || "Failed to save Qoder public model mapping" }, { status: 400 });
  }
}

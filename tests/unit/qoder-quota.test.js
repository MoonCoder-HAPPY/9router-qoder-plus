import { describe, expect, it, vi } from "vitest";
 
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));
 
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getQoderUsage } from "../../open-sse/services/usage/misc.js";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("Qoder quota usage", () => {
  it("surfaces Qoder organization resource package cap as a dashboard quota row", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      userQuota: {
        total: 3000,
        used: 1878,
        remaining: 1122,
        unit: "credits",
      },
      orgResourcePackage: {
        used: 0,
        remaining: 8000,
        cap: 8000,
        available: true,
        unit: "credits",
      },
      expiresAt: 1786863893000,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
 
    const usage = await getQoderUsage("test-token");
    expect(usage.quotas.organization).toMatchObject({
      used: 0,
      total: 8000,
      remaining: 8000,
      unit: "credits",
    });
 
    const rows = parseQuotaData("qoder", usage);
    expect(rows).toEqual([
      expect.objectContaining({ name: "Personal", used: 1878, total: 3000 }),
      expect.objectContaining({ name: "Resource Package", used: 0, total: 8000 }),
    ]);
  });
});

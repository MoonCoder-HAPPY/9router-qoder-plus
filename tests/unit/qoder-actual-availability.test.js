import { expect, it } from "vitest";
import { buildCcSwitchUsage } from "@/shared/services/ccSwitchUsage.js";
import { buildQoderKeyUsageState } from "@/app/api/keys/quota-options/route.js";
const policy = used => ({ enabled: true, providers: { qoder: {
  connectionIds: ["a"], accountAllocations: { a: 3000 }, creditUsageLedger: { a: { used, precise: true } },
} } });
const accounts = remaining => [{ id: "a", quotaStatus: "ok", remainingQuota: remaining, quotaRows: [], quotaCheckedAt: "2026-10-12T01:00:00.000Z" }];
it("caps actual balance at the official remaining amount without charging external spending to the key", () => {
  const result = buildCcSwitchUsage({ providerPolicy: policy(1200).providers.qoder, accounts: accounts(800) });
  expect(result).toMatchObject({ used: 1200, total: 3000, allocationRemaining: 1800, balance: 800, remaining: 800 });
  expect(buildQoderKeyUsageState(policy(1200), accounts(800)))
    .toMatchObject({ used: 1200, limit: 3000, remaining: 1800, availableRemaining: 800, quotaCheckedAt: "2026-10-12T01:00:00.000Z" });
});
it("does not present a failed quota query as a valid balance", () => {
  expect(buildCcSwitchUsage({ providerPolicy: policy(1200).providers.qoder, accounts: [{ id: "a", quotaStatus: "unavailable", remainingQuota: null }] }))
    .toMatchObject({ isValid: false, used: 1200, total: 3000, allocationRemaining: 1800, balance: null, remaining: null });
});
it("requires all funded accounts to be known before displaying a full balance", () => {
  const p = policy(1200);
  p.providers.qoder.connectionIds.push("b");
  p.providers.qoder.accountAllocations.b = 2000;
  const result = buildCcSwitchUsage({ providerPolicy: p.providers.qoder,
    accounts: [...accounts(800), { id: "b", quotaStatus: "loading", remainingQuota: null }] });
  expect(result).toMatchObject({ balance: null, isValid: false, allocationRemaining: 3800 });
});
it("adds each account's usable segment instead of applying a global cap", () => {
  const p = policy(1200);
  p.providers.qoder.connectionIds.push("b");
  p.providers.qoder.accountAllocations.b = 2000;
  p.providers.qoder.creditUsageLedger.b = { used: 700, precise: true };
  expect(buildCcSwitchUsage({ providerPolicy: p.providers.qoder, accounts: [...accounts(800), { id: "b", quotaStatus: "ok", remainingQuota: 4000 }] }))
    .toMatchObject({ used: 1900, total: 5000, allocationRemaining: 3100, balance: 2100 });
});

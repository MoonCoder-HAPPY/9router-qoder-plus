import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MODAL_SOURCE = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../src/app/(dashboard)/dashboard/endpoint/components/ApiKeyRestrictionsModal.js"),
  "utf8"
);

describe("ApiKeyRestrictionsModal interaction source", () => {
  it("keeps account selection separate from priority editing", () => {
    expect(MODAL_SOURCE).toContain("selectedAccountList");
    expect(MODAL_SOURCE).toContain("priorityAccounts");
    expect(MODAL_SOURCE).toContain("Consumption Priority");
  });

  it("does not toggle account selection from the whole account row", () => {
    expect(MODAL_SOURCE).not.toContain('role="button"');
    expect(MODAL_SOURCE).not.toContain("onClick={() => toggleConnection(account.id)}");
  });

  it("appends new selections without changing existing priority or form inputs", () => {
    expect(MODAL_SOURCE).toContain("priorityOrder = [...prev.priorityOrder, id]");
    expect(MODAL_SOURCE).not.toContain("sortSelectedByAccountList");
    expect(MODAL_SOURCE).toContain('aria-label={translate("Remove allocation")}');
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MODAL_SOURCE = fs.readFileSync(
  path.resolve("src/app/(dashboard)/dashboard/endpoint/components/ApiKeyRestrictionsModal.js"),
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

  it("uses stable account order until priority is explicitly edited", () => {
    expect(MODAL_SOURCE).toContain("priorityEdited");
    expect(MODAL_SOURCE).toContain("sortSelectedByAccountList");
    expect(MODAL_SOURCE).toContain("setPriorityEdited(true)");
  });
});

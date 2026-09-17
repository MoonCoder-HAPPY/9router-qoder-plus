import { describe, it, expect } from "vitest";
import { getRequestKeyName, getRequestKeyOptions } from "../../src/app/(dashboard)/dashboard/usage/components/requestKeyLabels.js";

describe("historical Key labels", () => {
  it("separates unknown and explicit no-Key and keeps historical names", () => {
    expect(getRequestKeyName({})).toBe("Unknown API Key");
    expect(getRequestKeyName({ apiKeyId: null, apiKeyName: null })).toBe("No API Key");
    expect(getRequestKeyName({ apiKeyId: "a", apiKeyName: "Before" })).toBe("Before");
  });
  it("disambiguates identical names with unique ID prefixes, extending collisions", () => {
    const options = getRequestKeyOptions([
      { id: "12345678-a", name: "Same" }, { id: "12345678-b", name: "Same" },
      { id: "other", name: "Distinct" },
    ]);
    expect(options[0]).toEqual({ id: "12345678-a", label: "Same (12345678-a)" });
    expect(options[1].label).toBe("Same (12345678-b)");
    expect(options[2].label).toBe("Distinct");
  });
  it("translates only fallback labels, never business names", () => {
    const translate = value => `translated:${value}`;
    expect(getRequestKeyName({ apiKeyId: "a", apiKeyName: "Save" }, translate)).toBe("Save");
    expect(getRequestKeyName({}, translate)).toBe("translated:Unknown API Key");
    expect(getRequestKeyName({ apiKeyId: null, apiKeyName: null }, translate)).toBe("translated:No API Key");
    expect(getRequestKeyOptions([{ id: "a", name: "Save" }, { id: "b", name: null }], translate))
      .toEqual([{ id: "a", label: "Save" }, { id: "b", label: "translated:Unknown API Key" }]);
  });
});

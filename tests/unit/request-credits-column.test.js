// Qoder credits column (usage details tab).
//
// The column is driven purely by data 9router already persists in
// requestDetails.tokens.credits — the amount Qoder actually deducted for the
// request. `original_credits` is the pre-discount list price (production data
// shows it is often ~2.5x the charge), so the column must NEVER fall back to it:
// that would overstate what the account paid. These tests pin the display
// contract, including the parts the UI must get right:
//   - non-Qoder providers must render null (an em dash), never 0
//   - a missing/absent credit value must stay null rather than become 0
//   - a billed-but-tiny charge must not render as a free "0"
//   - malformed rows must not crash the table
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatCredits,
  getCreditsCellValue,
  getRequestCredits,
  isQoderProvider,
  normalizeProviderId,
} from "../../src/shared/utils/requestCredits.js";

describe("requestCredits — provider gating", () => {
  it("recognizes Qoder regardless of case or surrounding whitespace", () => {
    expect(isQoderProvider("qoder")).toBe(true);
    expect(isQoderProvider("Qoder")).toBe(true);
    expect(isQoderProvider("  qoder  ")).toBe(true);
  });

  it("rejects every other provider", () => {
    for (const provider of ["openai", "anthropic", "codex", "qoderr", "", null, undefined, 42, {}]) {
      expect(isQoderProvider(provider)).toBe(false);
    }
  });

  it("normalizes non-strings to an empty id", () => {
    expect(normalizeProviderId(null)).toBe("");
    expect(normalizeProviderId(undefined)).toBe("");
    expect(normalizeProviderId(7)).toBe("");
  });
});

describe("requestCredits — amount resolution", () => {
  it("returns the charged amount", () => {
    expect(getRequestCredits({ credits: 0.125, original_credits: 0.25 })).toBe(0.125);
  });

  it("never falls back to the pre-discount price when the charge is absent", () => {
    // Production rows carry e.g. credits=0.1929 with original_credits=0.4824.
    // Showing 0.4824 would claim the account paid 2.5x what it did.
    expect(getRequestCredits({ original_credits: 0.25 })).toBeNull();
    expect(getRequestCredits({ credits: null, original_credits: 0.25 })).toBeNull();
  });

  it("accepts a real zero charge (free request) but not a missing one", () => {
    expect(getRequestCredits({ credits: 0 })).toBe(0);
    expect(getRequestCredits({ credits: null })).toBeNull();
    expect(getRequestCredits({})).toBeNull();
    expect(getRequestCredits(null)).toBeNull();
    expect(getRequestCredits(undefined)).toBeNull();
  });

  it("ignores negative and non-numeric values", () => {
    expect(getRequestCredits({ credits: -1 })).toBeNull();
    expect(getRequestCredits({ credits: "abc" })).toBeNull();
    expect(getRequestCredits({ credits: NaN })).toBeNull();
    expect(getRequestCredits({ credits: Infinity })).toBeNull();
  });

  it("parses numeric strings coming from serialized rows", () => {
    expect(getRequestCredits({ credits: "0.5" })).toBe(0.5);
  });
});

describe("requestCredits — formatting", () => {
  it("trims trailing zeros so the column stays compact", () => {
    expect(formatCredits(0.5)).toBe("0.5");
    expect(formatCredits(1)).toBe("1");
    expect(formatCredits(1.25)).toBe("1.25");
  });

  it("keeps four decimals so small real charges do not round away", () => {
    expect(formatCredits(0.09924420005714286)).toBe("0.0992");
    expect(formatCredits(0.02731412754285714)).toBe("0.0273");
    expect(formatCredits(0.00001)).toBe("<0.0001");
  });

  it("shows a genuine zero as 0, not as a sub-precision amount", () => {
    expect(formatCredits(0)).toBe("0");
  });

  it("returns null for unusable input", () => {
    expect(formatCredits(null)).toBeNull();
    expect(formatCredits(undefined)).toBeNull();
    expect(formatCredits(-1)).toBeNull();
    expect(formatCredits("abc")).toBeNull();
  });
});

describe("requestCredits — table cell contract", () => {
  it("renders the charged amount for a Qoder row", () => {
    expect(getCreditsCellValue({
      provider: "qoder",
      tokens: { credits: 0.09924420005714286, original_credits: 0.09924420005714286 },
    })).toBe("0.0992");
  });

  it("ignores the pre-discount price for a Qoder row", () => {
    expect(getCreditsCellValue({
      provider: "qoder",
      tokens: { original_credits: 0.4823785714285714 },
    })).toBeNull();
  });

  it("renders null for a non-Qoder row even when tokens carry credits", () => {
    expect(getCreditsCellValue({ provider: "openai", tokens: { credits: 2 } })).toBeNull();
    expect(getCreditsCellValue({ provider: "anthropic", tokens: { credits: 2 } })).toBeNull();
  });

  it("renders null for a Qoder row with no recorded credits", () => {
    expect(getCreditsCellValue({ provider: "qoder", tokens: { prompt_tokens: 5 } })).toBeNull();
    expect(getCreditsCellValue({ provider: "qoder", tokens: {} })).toBeNull();
    expect(getCreditsCellValue({ provider: "qoder" })).toBeNull();
  });

  it("never throws on malformed rows from the API", () => {
    for (const row of [null, undefined, {}, { provider: null }, { provider: "qoder", tokens: null }, 42, "qoder"]) {
      expect(() => getCreditsCellValue(row)).not.toThrow();
      expect(getCreditsCellValue(row)).toBeNull();
    }
  });
});

// Source-level lock for the Credits Used column: helpers alone passing is not
// enough, the dashboard has to actually render them. Mirrors the existing
// codex-dashboard-surfaces.test.js pattern.
const repoRoot = path.resolve(import.meta.dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

const detailsTab = read("src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js");
const zhCN = JSON.parse(read("public/i18n/literals/zh-CN.json"));
const TOOLTIP_TEXT = "Only credit charges for the Qoder provider are recorded. Other providers show an empty cell.";

describe("Credits Used column — dashboard surface", () => {
  it("renders the column header to the right of Output Tokens", () => {
    const outputIdx = detailsTab.indexOf(">Output Tokens</th>");
    const creditsIdx = detailsTab.indexOf("Credits Used");
    const latencyIdx = detailsTab.indexOf(">Latency</th>");
    expect(outputIdx).toBeGreaterThan(-1);
    expect(creditsIdx).toBeGreaterThan(-1);
    expect(latencyIdx).toBeGreaterThan(-1);
    expect(creditsIdx).toBeGreaterThan(outputIdx);
    expect(creditsIdx).toBeLessThan(latencyIdx);
  });

  it("puts an explanatory tooltip on the header", () => {
    expect(detailsTab).toContain('import Tooltip from "@/shared/components/Tooltip"');
    expect(detailsTab).toContain(TOOLTIP_TEXT);
    const headerBlock = detailsTab.slice(detailsTab.indexOf(">Output Tokens</th>"), detailsTab.indexOf(">Latency</th>"));
    expect(headerBlock).toContain("<Tooltip");
    // The table sits in an overflow-x-auto container, so a centered bubble would be
    // clipped: the header tooltip must anchor right and open downwards.
    expect(headerBlock).toContain('position="bottom" align="right"');
  });

  it("keeps the explanation reachable without a mouse", () => {
    const headerBlock = detailsTab.slice(detailsTab.indexOf(">Output Tokens</th>"), detailsTab.indexOf(">Latency</th>"));
    // A hover-only <span> would be invisible to keyboard and screen-reader users.
    expect(headerBlock).toContain("<button");
    expect(headerBlock).toContain('type="button"');
    expect(headerBlock).toContain('aria-label="Credits Used explanation"');
  });

  it("keeps the shared Tooltip default centered for every other caller", () => {
    const tooltip = read("src/shared/components/Tooltip.js");
    expect(tooltip).toContain('align = "center"');
    expect(tooltip).toContain("left-1/2 -translate-x-1/2");
  });

  it("spans every column in the loading, error and empty rows", () => {
    const spans = detailsTab.match(/colSpan="(\d+)"/g) || [];
    const headerCells = (detailsTab.slice(detailsTab.indexOf("<thead>"), detailsTab.indexOf("</thead>")).match(/<th[\s>]/g) || []).length;
    expect(headerCells).toBe(11);
    expect(spans).toHaveLength(3);
    expect(spans.every(span => span === `colSpan="${headerCells}"`)).toBe(true);
  });

  it("reads the value through the shared helper so non-Qoder rows stay empty", () => {
    expect(detailsTab).toContain('getCreditsCellValue } from "@/shared/utils/requestCredits"');
    expect(detailsTab).toContain("{getCreditsCellValue(detail) ?? \"\u2014\"}");
  });

  it("shows the amount in the detail drawer summary too", () => {
    expect(detailsTab).toContain("Credits Used:");
    expect(detailsTab).toContain("getCreditsCellValue(selectedDetail) !== null");
  });

  it("ships zh-CN translations for the new labels", () => {
    expect(zhCN["Credits Used"]).toBe("Credits \u6d88\u8017");
    expect(zhCN["Credits Used:"]).toBe("Credits \u6d88\u8017\uff1a");
    expect(zhCN[TOOLTIP_TEXT]).toContain("Qoder");
  });

  it("has no stale tooltip literal left in the bundle", () => {
    expect(zhCN["Only requests routed to the Qoder provider record the credits actually deducted. Other providers show an empty cell."]).toBeUndefined();
    expect(detailsTab).not.toContain("credits actually deducted");
  });
});

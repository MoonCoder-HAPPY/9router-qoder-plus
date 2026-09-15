import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", relative), "utf8");

const detailsTab = read("src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js");
const profilePage = read("src/app/(dashboard)/dashboard/profile/page.js");

describe("Codex UX surfaces in the dashboard", () => {
  it("shows the Codex metrics line in the request details table", () => {
    expect(detailsTab).toContain("detail.codex");
    for (const field of ["reasoningEvents", "continuations", "contextPeakEstimate", "admissionRejectReason"]) {
      expect(detailsTab, `details tab must render ${field}`).toContain(field);
    }
  });

  it("exposes every Codex compatibility control on the profile page", () => {
    expect(profilePage).toContain("Codex Compatibility");
    for (const field of [
      "proactiveContextGuard",
      "autoCompactRatio",
      "autoCompactMin",
      "autoCompactMax",
      "autoContinueMax",
      "firstTokenTimeoutFallback",
    ]) {
      expect(profilePage, `profile page must expose ${field}`).toContain(field);
    }
    // ...and persist them through the settings API.
    expect(profilePage).toContain("codexCompat: payload");
    expect(profilePage).toContain('fetch("/api/settings"');
  });
});
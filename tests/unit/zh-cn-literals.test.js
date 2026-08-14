import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ZH_CN_LITERALS = JSON.parse(
  fs.readFileSync(path.resolve("public/i18n/literals/zh-CN.json"), "utf8")
);

describe("zh-CN literals", () => {
  it("covers API key quota and DingTalk alert UI strings", () => {
    const required = [
      "API Key Restrictions",
      "Enable restrictions",
      "Qoder Accounts",
      "Allocated credits",
      "Assignable",
      "Total Allocation",
      "Allocated Elsewhere",
      "Max Assignable",
      "Used / Total",
      "Remaining",
      "Active Account",
      "Reset usage",
      "Reset Qoder Usage",
      "Reset this key's recorded Qoder usage to 0 and start counting again from the current account quotas? This cannot be undone.",
      "None",
      "Selected",
      "Exhausted",
      "In use",
      "Consumption Priority",
      "Used when multiple selected accounts still have assigned credits.",
      "Used",
      "Remaining allocation",
      "Select accounts to set priority.",
      "Select account",
      "Move up",
      "Move down",
      "Move account up",
      "Move account down",
      "Allocation exceeds the currently assignable Qoder quota.",
      "Model Idle Alert",
      "DingTalk Alert",
      "Idle Minutes",
      "Alert Cooldown",
      "API Key Usage Threshold",
      "Send a DingTalk message when any API key uses at least this percentage of its assigned quota.",
      "Usage Threshold Percent",
      "DingTalk Webhook",
      "DingTalk Secret",
      "Message Template",
      "Save alert settings",
      "Test DingTalk",
      "DingTalk test message sent",
      "Resource Package",
      "Personal",
    ];

    for (const key of required) {
      expect(ZH_CN_LITERALS[key], key).toBeTruthy();
      expect(ZH_CN_LITERALS[key], key).not.toBe(key);
    }
  });
});

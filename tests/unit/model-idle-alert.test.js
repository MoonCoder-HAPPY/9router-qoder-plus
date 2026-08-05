import { describe, expect, it } from "vitest";

import {
  buildApiKeyQuotaExhaustedText,
  buildApiKeyQuotaThresholdText,
  createModelIdleAlertState,
  createApiKeyQuotaAlertState,
  evaluateModelIdleAlert,
  evaluateApiKeyQuotaAlert,
  evaluateApiKeyQuotaThresholdAlert,
  normalizeModelIdleAlertSettings,
  recordModelCall,
} from "../../src/shared/services/modelIdleAlert.js";

const MINUTE = 60 * 1000;

describe("model idle alert state", () => {
  it("alerts once when the latest successful model call stays idle past the threshold", () => {
    const settings = normalizeModelIdleAlertSettings({
      enabled: true,
      idleMinutes: 5,
      cooldownMinutes: 5,
      dingtalkWebhook: "https://oapi.dingtalk.com/robot/send?access_token=test",
    });
    const state = createModelIdleAlertState();
    recordModelCall(state, Date.parse("2026-07-27T15:50:17+08:00"));

    expect(evaluateModelIdleAlert(state, settings, Date.parse("2026-07-27T15:55:16+08:00")).shouldAlert).toBe(false);

    const first = evaluateModelIdleAlert(state, settings, Date.parse("2026-07-27T15:55:17+08:00"));
    expect(first.shouldAlert).toBe(true);
    expect(first.idleMs).toBe(5 * MINUTE);

    state.lastAlertAt = first.nowMs;
    state.lastAlertedCallAt = state.lastCallAt;

    expect(evaluateModelIdleAlert(state, settings, Date.parse("2026-07-27T16:20:17+08:00")).shouldAlert).toBe(false);
  });

  it("resets the alert window after a later successful model call", () => {
    const settings = normalizeModelIdleAlertSettings({
      enabled: true,
      idleMinutes: 5,
      cooldownMinutes: 5,
      dingtalkWebhook: "https://oapi.dingtalk.com/robot/send?access_token=test",
    });
    const state = createModelIdleAlertState({
      lastCallAt: Date.parse("2026-07-27T15:50:17+08:00"),
      lastAlertAt: Date.parse("2026-07-27T15:55:17+08:00"),
      lastAlertedCallAt: Date.parse("2026-07-27T15:50:17+08:00"),
    });

    recordModelCall(state, Date.parse("2026-07-27T15:58:17+08:00"));

    expect(evaluateModelIdleAlert(state, settings, Date.parse("2026-07-27T16:03:16+08:00")).shouldAlert).toBe(false);
    expect(evaluateModelIdleAlert(state, settings, Date.parse("2026-07-27T16:03:17+08:00")).shouldAlert).toBe(true);
  });

  it("honors the alert cooldown even when a new call creates another idle window", () => {
    const settings = normalizeModelIdleAlertSettings({
      enabled: true,
      idleMinutes: 5,
      cooldownMinutes: 10,
      dingtalkWebhook: "https://oapi.dingtalk.com/robot/send?access_token=test",
    });
    const state = createModelIdleAlertState({
      lastAlertAt: Date.parse("2026-07-27T15:55:17+08:00"),
      lastAlertedCallAt: Date.parse("2026-07-27T15:50:17+08:00"),
    });

    recordModelCall(state, Date.parse("2026-07-27T15:58:17+08:00"));

    expect(evaluateModelIdleAlert(state, settings, Date.parse("2026-07-27T16:03:17+08:00")).shouldAlert).toBe(false);
    expect(evaluateModelIdleAlert(state, settings, Date.parse("2026-07-27T16:05:17+08:00")).shouldAlert).toBe(true);
  });
});

describe("api key quota alert state", () => {
  it("alerts once for an exhausted key and honors the alert cooldown", () => {
    const settings = normalizeModelIdleAlertSettings({
      enabled: true,
      cooldownMinutes: 10,
      dingtalkWebhook: "https://oapi.dingtalk.com/robot/send?access_token=test",
    });
    const state = createApiKeyQuotaAlertState();
    const firstAt = Date.parse("2026-07-28T15:00:00+08:00");

    expect(evaluateApiKeyQuotaAlert(state, settings, "key-a", firstAt)).toMatchObject({
      shouldAlert: true,
      reason: "quota-exhausted",
    });

    state.lastAlertByKey.set("key-a", firstAt);

    expect(evaluateApiKeyQuotaAlert(state, settings, "key-a", firstAt + 5 * MINUTE)).toMatchObject({
      shouldAlert: false,
      reason: "cooldown",
    });
    expect(evaluateApiKeyQuotaAlert(state, settings, "key-b", firstAt + 5 * MINUTE)).toMatchObject({
      shouldAlert: true,
      reason: "quota-exhausted",
    });
    expect(evaluateApiKeyQuotaAlert(state, settings, "key-a", firstAt + 10 * MINUTE)).toMatchObject({
      shouldAlert: true,
      reason: "quota-exhausted",
    });
  });

  it("builds a DingTalk message without exposing the raw API key", () => {
    const text = buildApiKeyQuotaExhaustedText({
      keyName: "desktop",
      provider: "qoder",
      used: 4092,
      limit: 4092,
      remaining: 0,
      nowMs: Date.parse("2026-07-28T15:00:00+08:00"),
    });

    expect(text).toContain("desktop");
    expect(text).toContain("qoder");
    expect(text).toContain("4092/4092");
    expect(text).not.toContain("sk-");
  });

  it("builds simplified Chinese DingTalk quota messages when locale is zh-CN", () => {
    const text = buildApiKeyQuotaExhaustedText({
      keyName: "desktop",
      provider: "qoder",
      used: 4092,
      limit: 4092,
      remaining: 0,
      locale: "zh-CN",
      nowMs: Date.parse("2026-07-28T15:00:00+08:00"),
    });

    expect(text).toContain("分配额度已耗尽");
    expect(text).toContain("提供商：qoder");
    expect(text).toContain("用量：4092/4092");
  });

  it("alerts when API key usage reaches the configured quota percentage threshold", () => {
    const settings = normalizeModelIdleAlertSettings({
      enabled: true,
      cooldownMinutes: 10,
      dingtalkWebhook: "https://oapi.dingtalk.com/robot/send?access_token=test",
      quotaUsageThresholdEnabled: true,
      quotaUsageThresholdPercent: 80,
    });
    const state = createApiKeyQuotaAlertState();
    const firstAt = Date.parse("2026-08-05T15:00:00+08:00");

    expect(evaluateApiKeyQuotaThresholdAlert(state, settings, {
      keyId: "key-a",
      used: 790,
      limit: 1000,
    }, firstAt)).toMatchObject({
      shouldAlert: false,
      reason: "below-threshold",
      usagePercent: 79,
    });

    expect(evaluateApiKeyQuotaThresholdAlert(state, settings, {
      keyId: "key-a",
      used: 800,
      limit: 1000,
    }, firstAt)).toMatchObject({
      shouldAlert: true,
      reason: "quota-threshold",
      usagePercent: 80,
    });

    state.lastThresholdAlertByKey.set("key-a", firstAt);

    expect(evaluateApiKeyQuotaThresholdAlert(state, settings, {
      keyId: "key-a",
      used: 900,
      limit: 1000,
    }, firstAt + 5 * MINUTE)).toMatchObject({
      shouldAlert: false,
      reason: "cooldown",
    });
    expect(evaluateApiKeyQuotaThresholdAlert(state, settings, {
      keyId: "key-b",
      used: 900,
      limit: 1000,
    }, firstAt + 5 * MINUTE)).toMatchObject({
      shouldAlert: true,
      reason: "quota-threshold",
      usagePercent: 90,
    });
  });

  it("builds simplified Chinese DingTalk quota threshold messages", () => {
    const text = buildApiKeyQuotaThresholdText({
      keyName: "home",
      provider: "qoder",
      used: 56000,
      limit: 70000,
      remaining: 14000,
      thresholdPercent: 80,
      usagePercent: 80,
      locale: "zh-CN",
      nowMs: Date.parse("2026-08-05T15:00:00+08:00"),
    });

    expect(text).toContain("使用量已达到阈值");
    expect(text).toContain("使用率：80%");
    expect(text).toContain("阈值：80%");
    expect(text).toContain("用量：56000/70000");
    expect(text).not.toContain("sk-");
  });
});

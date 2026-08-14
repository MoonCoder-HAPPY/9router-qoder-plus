import crypto from "node:crypto";

const MINUTE_MS = 60 * 1000;
const DEFAULT_CHECK_INTERVAL_MS = 30 * 1000;
const DEFAULT_IDLE_MINUTES = 5;
const DEFAULT_COOLDOWN_MINUTES = 5;
const DEFAULT_QUOTA_USAGE_THRESHOLD_PERCENT = 80;
const DEFAULT_TEMPLATE = "[9router] No successful model call for {idleMinutes} minutes. Last call: {lastCallAt}.";

const g = (global.__modelIdleAlert ??= {
  state: null,
  settings: null,
  apiKeyQuotaState: null,
  timer: null,
  checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
});

export function createModelIdleAlertState(initial = {}) {
  return {
    lastCallAt: Number.isFinite(initial.lastCallAt) ? initial.lastCallAt : null,
    lastAlertAt: Number.isFinite(initial.lastAlertAt) ? initial.lastAlertAt : null,
    lastAlertedCallAt: Number.isFinite(initial.lastAlertedCallAt) ? initial.lastAlertedCallAt : null,
  };
}

export function createApiKeyQuotaAlertState(initial = {}) {
  return {
    lastAlertByKey: initial.lastAlertByKey instanceof Map ? new Map(initial.lastAlertByKey) : new Map(),
    lastThresholdAlertByKey: initial.lastThresholdAlertByKey instanceof Map ? new Map(initial.lastThresholdAlertByKey) : new Map(),
    activeExhaustedKeys: initial.activeExhaustedKeys instanceof Set ? new Set(initial.activeExhaustedKeys) : new Set(),
  };
}

function positiveNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function nonNegativeNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

function boundedPercent(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(100, Math.max(1, num));
}

export function normalizeModelIdleAlertSettings(input = {}) {
  const raw = input?.modelIdleAlert && typeof input.modelIdleAlert === "object"
    ? input.modelIdleAlert
    : input;

  return {
    enabled: raw?.enabled === true,
    idleMinutes: positiveNumber(raw?.idleMinutes, DEFAULT_IDLE_MINUTES),
    cooldownMinutes: nonNegativeNumber(raw?.cooldownMinutes, DEFAULT_COOLDOWN_MINUTES),
    dingtalkWebhook: typeof raw?.dingtalkWebhook === "string" ? raw.dingtalkWebhook.trim() : "",
    dingtalkSecret: typeof raw?.dingtalkSecret === "string" ? raw.dingtalkSecret.trim() : "",
    quotaUsageThresholdEnabled: raw?.quotaUsageThresholdEnabled === true,
    quotaUsageThresholdPercent: boundedPercent(raw?.quotaUsageThresholdPercent, DEFAULT_QUOTA_USAGE_THRESHOLD_PERCENT),
    locale: typeof raw?.locale === "string" && raw.locale.trim() ? raw.locale.trim() : "en",
    messageTemplate: typeof raw?.messageTemplate === "string" && raw.messageTemplate.trim()
      ? raw.messageTemplate.trim()
      : DEFAULT_TEMPLATE,
  };
}

export function maskModelIdleAlertSettings(settings = {}) {
  const normalized = normalizeModelIdleAlertSettings(settings);
  return {
    ...normalized,
    dingtalkSecret: "",
    hasDingtalkSecret: !!normalized.dingtalkSecret,
  };
}

export function recordModelCall(state, nowMs = Date.now()) {
  if (!state) return;
  state.lastCallAt = nowMs;
  state.lastAlertedCallAt = null;
}

export function evaluateModelIdleAlert(state, settings, nowMs = Date.now()) {
  const normalized = normalizeModelIdleAlertSettings(settings);
  if (!normalized.enabled) return { shouldAlert: false, reason: "disabled", nowMs };
  if (!normalized.dingtalkWebhook) return { shouldAlert: false, reason: "missing-webhook", nowMs };
  if (!state?.lastCallAt) return { shouldAlert: false, reason: "no-call", nowMs };
  if (state.lastAlertedCallAt === state.lastCallAt) {
    return { shouldAlert: false, reason: "already-alerted", nowMs };
  }

  const idleMs = nowMs - state.lastCallAt;
  if (idleMs < normalized.idleMinutes * MINUTE_MS) {
    return { shouldAlert: false, reason: "below-idle-threshold", nowMs, idleMs };
  }

  if (
    state.lastAlertAt &&
    normalized.cooldownMinutes > 0 &&
    nowMs - state.lastAlertAt < normalized.cooldownMinutes * MINUTE_MS
  ) {
    return { shouldAlert: false, reason: "cooldown", nowMs, idleMs };
  }

  return { shouldAlert: true, reason: "idle", nowMs, idleMs };
}

export function evaluateApiKeyQuotaAlert(state, settings, keyId, nowMs = Date.now()) {
  const normalized = normalizeModelIdleAlertSettings(settings);
  if (!normalized.enabled) return { shouldAlert: false, reason: "disabled", nowMs };
  if (!normalized.dingtalkWebhook) return { shouldAlert: false, reason: "missing-webhook", nowMs };
  if (!keyId) return { shouldAlert: false, reason: "missing-key", nowMs };

  const lastAlertAt = state?.lastAlertByKey?.get(keyId) || null;
  if (state?.activeExhaustedKeys?.has(keyId)) {
    return { shouldAlert: false, reason: "already-alerted", nowMs, lastAlertAt };
  }
  if (
    lastAlertAt &&
    normalized.cooldownMinutes > 0 &&
    nowMs - lastAlertAt < normalized.cooldownMinutes * MINUTE_MS
  ) {
    return { shouldAlert: false, reason: "cooldown", nowMs, lastAlertAt };
  }

  return { shouldAlert: true, reason: "quota-exhausted", nowMs, lastAlertAt };
}

export function markApiKeyQuotaAvailable(state, keyId) {
  if (!state || !keyId) return;
  state.activeExhaustedKeys?.delete(keyId);
  state.lastAlertByKey?.delete(keyId);
}

export function clearApiKeyQuotaAlertStateForKey(state, keyId) {
  if (!state || !keyId) return;
  state.activeExhaustedKeys?.delete(keyId);
  state.lastAlertByKey?.delete(keyId);
  state.lastThresholdAlertByKey?.delete(keyId);
}

export function evaluateApiKeyQuotaThresholdAlert(state, settings, details = {}, nowMs = Date.now()) {
  const normalized = normalizeModelIdleAlertSettings(settings);
  if (!normalized.enabled) return { shouldAlert: false, reason: "disabled", nowMs };
  if (!normalized.quotaUsageThresholdEnabled) return { shouldAlert: false, reason: "threshold-disabled", nowMs };
  if (!normalized.dingtalkWebhook) return { shouldAlert: false, reason: "missing-webhook", nowMs };

  const keyId = details.keyId || details.keyName || "";
  if (!keyId) return { shouldAlert: false, reason: "missing-key", nowMs };

  const used = Math.max(0, Number(details.used) || 0);
  const limit = Number(details.limit);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { shouldAlert: false, reason: "missing-limit", nowMs, used, limit: null };
  }

  const usagePercent = Math.floor((used / limit) * 100);
  const thresholdPercent = normalized.quotaUsageThresholdPercent;
  if (usagePercent < thresholdPercent) {
    return { shouldAlert: false, reason: "below-threshold", nowMs, used, limit, usagePercent, thresholdPercent };
  }

  const lastAlertAt = state?.lastThresholdAlertByKey?.get(keyId) || null;
  if (
    lastAlertAt &&
    normalized.cooldownMinutes > 0 &&
    nowMs - lastAlertAt < normalized.cooldownMinutes * MINUTE_MS
  ) {
    return { shouldAlert: false, reason: "cooldown", nowMs, used, limit, usagePercent, thresholdPercent, lastAlertAt };
  }

  return { shouldAlert: true, reason: "quota-threshold", nowMs, used, limit, usagePercent, thresholdPercent, lastAlertAt };
}

function formatTime(ms) {
  return new Date(ms).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}

export function buildDingTalkText({ settings, state, nowMs = Date.now() }) {
  const normalized = normalizeModelIdleAlertSettings(settings);
  const idleMinutes = state?.lastCallAt
    ? Math.floor((nowMs - state.lastCallAt) / MINUTE_MS)
    : 0;

  return normalized.messageTemplate
    .replaceAll("{idleMinutes}", String(idleMinutes))
    .replaceAll("{lastCallAt}", state?.lastCallAt ? formatTime(state.lastCallAt) : "unknown")
    .replaceAll("{now}", formatTime(nowMs));
}

export function buildApiKeyQuotaExhaustedText({ keyName, provider, used, limit, remaining, locale = "en", nowMs = Date.now() }) {
  const name = keyName || "unknown";
  const providerName = provider || "unknown";
  const usedText = Number.isFinite(Number(used)) ? Number(used) : 0;
  const limitText = Number.isFinite(Number(limit)) ? Number(limit) : 0;
  const remainingText = Number.isFinite(Number(remaining)) ? Number(remaining) : 0;
  if (locale === "zh-CN" || locale === "zh") {
    return `[9router] API Key 分配额度已耗尽。Key：${name}。提供商：${providerName}。用量：${usedText}/${limitText}。剩余：${remainingText}。时间：${formatTime(nowMs)}。`;
  }
  return `[9router] API key quota exhausted. Key: ${name}. Provider: ${providerName}. Usage: ${usedText}/${limitText}. Remaining: ${remainingText}. Time: ${formatTime(nowMs)}.`;
}

export function buildApiKeyQuotaThresholdText({
  keyName,
  provider,
  used,
  limit,
  remaining,
  thresholdPercent,
  usagePercent,
  locale = "en",
  nowMs = Date.now(),
}) {
  const name = keyName || "unknown";
  const providerName = provider || "unknown";
  const usedText = Number.isFinite(Number(used)) ? Number(used) : 0;
  const limitText = Number.isFinite(Number(limit)) ? Number(limit) : 0;
  const remainingText = Number.isFinite(Number(remaining)) ? Number(remaining) : 0;
  const thresholdText = Number.isFinite(Number(thresholdPercent)) ? Number(thresholdPercent) : DEFAULT_QUOTA_USAGE_THRESHOLD_PERCENT;
  const usageText = Number.isFinite(Number(usagePercent))
    ? Number(usagePercent)
    : (limitText > 0 ? Math.floor((usedText / limitText) * 100) : 0);
  if (locale === "zh-CN" || locale === "zh") {
    return `[9router] API Key 使用量已达到阈值。Key：${name}。提供商：${providerName}。使用率：${usageText}%。阈值：${thresholdText}%。用量：${usedText}/${limitText}。剩余：${remainingText}。时间：${formatTime(nowMs)}。`;
  }
  return `[9router] API key usage reached threshold. Key: ${name}. Provider: ${providerName}. Usage rate: ${usageText}%. Threshold: ${thresholdText}%. Usage: ${usedText}/${limitText}. Remaining: ${remainingText}. Time: ${formatTime(nowMs)}.`;
}

export function signDingTalkWebhook(webhook, secret, timestamp = Date.now()) {
  if (!secret) return webhook;
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = encodeURIComponent(
    crypto.createHmac("sha256", secret).update(stringToSign).digest("base64")
  );
  const url = new URL(webhook);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  return url.toString();
}

export async function sendDingTalkAlert(settings, text, fetchImpl = fetch) {
  const normalized = normalizeModelIdleAlertSettings(settings);
  if (!normalized.dingtalkWebhook) throw new Error("DingTalk webhook is required");
  const url = signDingTalkWebhook(normalized.dingtalkWebhook, normalized.dingtalkSecret);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "text",
      text: { content: text },
    }),
  });
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`DingTalk HTTP ${response.status}: ${body || response.statusText}`);
  }
  if (body) {
    try {
      const json = JSON.parse(body);
      if (json.errcode && json.errcode !== 0) {
        throw new Error(json.errmsg || `DingTalk errcode ${json.errcode}`);
      }
    } catch (error) {
      if (/DingTalk|errcode/.test(error.message)) throw error;
    }
  }
  return { ok: true };
}

export function configureModelIdleAlert(settings, options = {}) {
  g.settings = normalizeModelIdleAlertSettings(settings);
  if (settings?.locale) g.settings.locale = settings.locale;
  g.checkIntervalMs = positiveNumber(options.checkIntervalMs, DEFAULT_CHECK_INTERVAL_MS);
  if (!g.state) g.state = createModelIdleAlertState();

  if (g.timer) {
    clearInterval(g.timer);
    g.timer = null;
  }
  if (!g.settings.enabled) return;

  g.timer = setInterval(() => {
    checkModelIdleAlert().catch((error) => {
      console.warn("[ModelIdleAlert] check failed:", error?.message || error);
    });
  }, g.checkIntervalMs);
  if (typeof g.timer.unref === "function") g.timer.unref();
}

export async function ensureModelIdleAlertConfigured() {
  if (g.settings) return;
  try {
    const { getSettings } = await import("@/lib/localDb");
    const settings = await getSettings();
    configureModelIdleAlert(settings);
  } catch (error) {
    console.warn("[ModelIdleAlert] init failed:", error?.message || error);
  }
}

export async function markModelCall(details = {}) {
  if (!g.state) g.state = createModelIdleAlertState();
  recordModelCall(g.state, Date.now());
  await ensureModelIdleAlertConfigured();
  if (details?.provider || details?.model) {
    console.log(`[ModelIdleAlert] model call recorded: ${details.provider || "unknown"}/${details.model || "unknown"}`);
  }
}

export async function checkModelIdleAlert(nowMs = Date.now(), fetchImpl = fetch) {
  await ensureModelIdleAlertConfigured();
  if (!g.state) g.state = createModelIdleAlertState();
  const result = evaluateModelIdleAlert(g.state, g.settings, nowMs);
  if (!result.shouldAlert) return result;

  const text = buildDingTalkText({ settings: g.settings, state: g.state, nowMs });
  await sendDingTalkAlert(g.settings, text, fetchImpl);
  g.state.lastAlertAt = nowMs;
  g.state.lastAlertedCallAt = g.state.lastCallAt;
  console.warn(`[ModelIdleAlert] DingTalk alert sent after ${Math.floor(result.idleMs / MINUTE_MS)} idle minutes`);
  return { ...result, alerted: true };
}

export async function notifyApiKeyQuotaExhausted(details = {}, nowMs = Date.now(), fetchImpl = fetch) {
  await ensureModelIdleAlertConfigured();
  if (!g.apiKeyQuotaState) g.apiKeyQuotaState = createApiKeyQuotaAlertState();
  const keyId = details.keyId || details.keyName || "unknown";
  const result = evaluateApiKeyQuotaAlert(g.apiKeyQuotaState, g.settings, keyId, nowMs);
  if (!result.shouldAlert) return result;

  if (!g.apiKeyQuotaState.activeExhaustedKeys) g.apiKeyQuotaState.activeExhaustedKeys = new Set();
  g.apiKeyQuotaState.activeExhaustedKeys.add(keyId);
  const text = buildApiKeyQuotaExhaustedText({ ...details, locale: g.settings?.locale, nowMs });
  try {
    await sendDingTalkAlert(g.settings, text, fetchImpl);
    g.apiKeyQuotaState.lastAlertByKey.set(keyId, nowMs);
  } catch (error) {
    g.apiKeyQuotaState.activeExhaustedKeys.delete(keyId);
    throw error;
  }
  console.warn(`[ModelIdleAlert] DingTalk key quota alert sent for ${details.provider || "unknown"}/${details.keyName || keyId}`);
  return { ...result, alerted: true };
}

export async function markApiKeyQuotaRecovered(keyId) {
  if (!keyId) return;
  if (!g.apiKeyQuotaState) g.apiKeyQuotaState = createApiKeyQuotaAlertState();
  markApiKeyQuotaAvailable(g.apiKeyQuotaState, keyId);
}

export async function resetApiKeyQuotaAlertState(keyId) {
  if (!keyId) return;
  if (!g.apiKeyQuotaState) g.apiKeyQuotaState = createApiKeyQuotaAlertState();
  clearApiKeyQuotaAlertStateForKey(g.apiKeyQuotaState, keyId);
}

export async function notifyApiKeyQuotaThresholdExceeded(details = {}, nowMs = Date.now(), fetchImpl = fetch) {
  await ensureModelIdleAlertConfigured();
  if (!g.apiKeyQuotaState) g.apiKeyQuotaState = createApiKeyQuotaAlertState();
  const keyId = details.keyId || details.keyName || "unknown";
  const result = evaluateApiKeyQuotaThresholdAlert(g.apiKeyQuotaState, g.settings, { ...details, keyId }, nowMs);
  if (!result.shouldAlert) return result;

  const text = buildApiKeyQuotaThresholdText({
    ...details,
    thresholdPercent: result.thresholdPercent,
    usagePercent: result.usagePercent,
    locale: g.settings?.locale,
    nowMs,
  });
  await sendDingTalkAlert(g.settings, text, fetchImpl);
  g.apiKeyQuotaState.lastThresholdAlertByKey.set(keyId, nowMs);
  console.warn(`[ModelIdleAlert] DingTalk key quota threshold alert sent for ${details.provider || "unknown"}/${details.keyName || keyId} (${result.usagePercent}%)`);
  return { ...result, alerted: true };
}

export function getModelIdleAlertRuntimeState() {
  if (!g.state) g.state = createModelIdleAlertState();
  return {
    ...g.state,
    enabled: g.settings?.enabled === true,
    checkIntervalMs: g.checkIntervalMs,
  };
}

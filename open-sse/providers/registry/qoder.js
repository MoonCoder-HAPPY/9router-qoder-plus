// 9router-fix: Qoder can keep large streaming requests idle for longer than
// the upstream provider default of 120s. Make both the fetch header timeout
// and inter-chunk stall timeout configurable, defaulting to 10 minutes.
function qoderEnvMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const QODER_STREAM_TIMEOUT_MS = qoderEnvMs("QODER_STREAM_TIMEOUT_MS", 600000);
const QODER_STALL_TIMEOUT_MS = qoderEnvMs("QODER_STALL_TIMEOUT_MS", QODER_STREAM_TIMEOUT_MS);

export default {
  id: "qoder",
  priority: 30,
  alias: "qd",
  uiAlias: "qd",
  display: {
    name: "Qoder",
    icon: "water_drop",
    color: "#EC4899",
    website: "https://qoder.com",
    notice: {
      signupUrl: "https://qoder.com",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
  },
  category: "free",
  transport: {
    baseUrl: "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation",
    headers: {},
    timeoutMs: QODER_STREAM_TIMEOUT_MS,
    stallTimeoutMs: QODER_STALL_TIMEOUT_MS,
    usage: {
      url: "https://openapi.qoder.sh/api/v2/quota/usage",
    },
  },
  models: [
    { id: "auto", name: "Auto" },
    { id: "ultimate", name: "Ultimate" },
    { id: "performance", name: "Performance" },
    { id: "efficient", name: "Efficient" },
    { id: "lite", name: "Lite" },
    { id: "qmodel_preview", name: "Qwen3.8-Max-Preview" },
    { id: "qmodel_latest", name: "Qwen3.7-Max" },
    { id: "qmodel", name: "Qwen3.7-Plus" },
    { id: "kmodel_latest", name: "Kimi-K3" },
    { id: "kmodel", name: "Kimi-K2.7-Code" },
    { id: "gm51model", name: "GLM-5.2" },
    { id: "dmodel", name: "DeepSeek-V4-Pro" },
    { id: "dfmodel", name: "DeepSeek-V4-Flash" },
    { id: "mmodel", name: "MiniMax-M3" },
  ],
  oauth: {
    openApiBaseUrl: "https://openapi.qoder.sh",
    centerBaseUrl: "https://center.qoder.sh",
    chatBaseUrl: "https://api3.qoder.sh",
    deviceTokenUrl: "https://openapi.qoder.sh/api/v1/deviceToken/poll",
    refreshUrl: "https://center.qoder.sh/algo/api/v3/user/refresh_token",
    userInfoUrl: "https://openapi.qoder.sh/api/v1/userinfo",
    quotaUsageUrl: "https://openapi.qoder.sh/api/v2/quota/usage",
    loginUrl: "https://qoder.com/device/selectAccounts",
  },
  features: {
    usage: true,
  },
};

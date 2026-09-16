/**
 * QoderExecutor — sends OpenAI-format chat requests to Qoder's COSY-signed
 * inference endpoint at api3.qoder.sh, then unwraps Qoder's `{statusCodeValue,
 * body}` SSE envelope back into plain OpenAI SSE for the rest of the pipeline.
 *
 * Differences vs the previous placeholder:
 *   - URL is api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation
 *     with `&Encode=1` so we can ship the body through the WAF-bypass
 *     encoder.
 *   - Authentication is COSY (RSA + AES + MD5 + ~17 Cosy-* headers), not
 *     a static HMAC.
 *   - The request shape Qoder expects is non-trivial (chat_context with
 *     mirrored modelConfig, business block with stable IDs, system text
 *     hoisted out of the messages array). All ported from the reference.
 *   - Model identifier is one of the canonical Qoder keys (auto / ultimate /
 *     performance / efficient / lite + frontier "*model" ids); the
 *     translator layer feeds us "qoder/<key>" so we strip the prefix.
 *   - Per-model `model_config` is fetched live from /algo/api/v2/model/list
 *     and cached. Sending the wrong block silently downgrades to a
 *     different model upstream, so a missing entry is a hard error.
 */

import { qoderEncodeBody } from "../shared/qoder/encoding.js";
import { buildCosyHeaders } from "../shared/qoder/cosy.js";
import { supportsQoderImageInput } from "../shared/qoder/vision.js";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import {
  QODER_CHAT_URL_ENCODED,
  QODER_MODEL_MAP,
} from "../shared/qoder/constants.js";
import { getQoderModelConfig, resolveQoderModels } from "../services/qoderModels.js";
import { resolveCodexErrorCode, withRetryAfterHint, CONTEXT_OVERFLOW_HEADERS } from "../config/errorConfig.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { estimateRequestTokens } from "../utils/contextAdmission.js";
import { QODER_CONTEXT_WINDOW } from "../../src/shared/services/codexCompat.js";

// ============ 9router-fix: Qoder queue-aware retry patch ============
// Qoder rate-limits by returning HTTP 403 with a nested body containing
// {"isQueued":true,"queueType":"slow",...} (error code 10605). The stock
// pipeline treats any 403 as a hard account failure (2-minute lockout and
// an immediate error to the client), which kills the Claude Code session.
// Instead, we return an SSE response immediately, keep it alive, and retry
// the queued request in the background with a bounded budget.
const QUEUE_RETRY = {
  // Exponential backoff: attempt N waits min(base*N, max). With the defaults
  // below the cumulative wait before the last retry is ~10 minutes
  // (5+10+15+20+25+30+35+40+45+50+55+60+60+60+60 ≈ 9.6 min), then one final
  // try. Total worst-case wall time ≈ 11 min.
  maxAttempts: Number(process.env.QODER_QUEUE_MAX_ATTEMPTS) || 15,
  baseDelayMs: Number(process.env.QODER_QUEUE_BASE_DELAY_MS) || 5000,
  maxDelayMs: Number(process.env.QODER_QUEUE_MAX_DELAY_MS) || 60000,
};
const QODER_KEEPALIVE_MS = Number(process.env.QODER_KEEPALIVE_MS) || 10000;

// First-token 504 policy (spec §16.6 / codexCompat.firstTokenTimeoutFallback):
//   account-then-budget  one quick in-account retry, then a single extended-budget
//                        attempt; if that fails too the error is surfaced so the
//                        pipeline can rotate the account (no silent downgrade)
//   budget-only          no quick retries, go straight to the extended budget
//   off                  keep the legacy env-driven retry ladder
const TIMEOUT_BUDGET_MULTIPLIER = (() => {
  const raw = Number(process.env.QODER_TIMEOUT_BUDGET_MULTIPLIER);
  return Number.isFinite(raw) && raw > 1 ? raw : 2;
})();

export function resolveTimeoutPolicy(settings = {}) {
  const strategy = settings?.firstTokenTimeoutFallback || "account-then-budget";
  const extended = {
    maxAttempts: TIMEOUT_RETRY.maxAttempts,
    baseDelayMs: Math.round(TIMEOUT_RETRY.baseDelayMs * TIMEOUT_BUDGET_MULTIPLIER),
    maxDelayMs: Math.round(TIMEOUT_RETRY.maxDelayMs * TIMEOUT_BUDGET_MULTIPLIER),
  };
  const quickDelay = (attempt) => Math.min(TIMEOUT_RETRY.baseDelayMs * attempt, TIMEOUT_RETRY.maxDelayMs);
  const extendedDelay = (attempt) =>
    Math.min(extended.baseDelayMs * attempt, extended.maxDelayMs);

  if (strategy === "off") {
    return { strategy: "off", timeoutOptions: { ...TIMEOUT_RETRY } };
  }
  if (strategy === "budget-only") {
    return {
      strategy: "budget-only",
      timeoutOptions: { ...extended, delayFor: extendedDelay },
    };
  }
  // account-then-budget (default): exactly one quick retry on the same account, then
  // the extended budget. If even that fails the caller surfaces the mapped error and
  // the pipeline rotates to another account (no silent model downgrade).
  return {
    strategy: "account-then-budget",
    timeoutOptions: {
      maxAttempts: 1 + extended.maxAttempts,
      baseDelayMs: TIMEOUT_RETRY.baseDelayMs,
      maxDelayMs: extended.maxDelayMs,
      delayFor: (attempt) => (attempt <= 1 ? quickDelay(attempt) : extendedDelay(attempt - 1)),
    },
  };
}
const CODE_LOG = "[CODEX]"; // stable prefix: grep-able Codex-observability signal
const CONTINUE_NUDGE =
  "Continue now: execute the step you just announced with a tool call in this turn. Do not restate the intent.";

// Qoder's gateway answers "First Token Timeout or Upstream Timeout" (HTTP 504
// or an SSE envelope with statusCodeValue 504) when a large context cannot
// produce its first token inside the gateway budget. It is transient, so it
// is retried on the same keep-alive stream with a smaller dedicated budget.
const TIMEOUT_RETRY = {
  maxAttempts: Number(process.env.QODER_TIMEOUT_MAX_ATTEMPTS) || 3,
  baseDelayMs: Number(process.env.QODER_TIMEOUT_BASE_DELAY_MS) || 3000,
  maxDelayMs: Number(process.env.QODER_TIMEOUT_MAX_DELAY_MS) || 15000,
};

// Some Qoder models occasionally end an agent turn with finish_reason "stop"
// right after announcing the next step ("let me check ...:"), without emitting
// a tool call. Codex then treats the turn as complete and the session appears
// to die mid-task. When that pattern is detected we issue one hidden
// continuation request and splice its stream into the same response.
const QODER_AUTO_CONTINUE_MAX = (() => {
  const raw = Number(process.env.QODER_AUTO_CONTINUE_MAX);
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 1;
})();

/**
 * Detect whether a 403 response is Qoder's soft "queued" rate limit.
 * The body is nested JSON: {"code":"403","message":"{\"code\":\"10605\",
 * \"message\":\"{\\\"isQueued\\\":true,...}\"}"} — so match raw text.
 * Consumes the body; caller must re-fetch afterwards.
 */
async function readQueueInfo(response) {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return { queued: false, queueCount: null };
  }
  return parseQueueInfoText(text);
}

function parseTimeoutInfoText(text) {
  const lower = String(text || "").toLowerCase();
  const firstToken = lower.includes("first token timeout");
  const upstream = lower.includes("upstream model timeout");
  const upstreamGeneric = lower.includes("upstream timeout");
  if (!firstToken && !upstream && !upstreamGeneric) {
    return { timeout: false, reason: null };
  }
  return {
    timeout: true,
    reason: firstToken ? "first token timeout" : "upstream model timeout",
  };
}

function parseQueueInfoText(text) {
  const queued =
    text.includes('"isQueued":true') ||
    text.includes('\\"isQueued\\":true') ||
    text.includes("10605");
  const m = text.match(/queueCount[\\"]*:?\s*(\d+)/);
  return { queued, queueCount: m ? Number(m[1]) : null };
}

// ============ 9router-fix: upstream error envelopes ============
// Qoder reports most request-level failures as HTTP 200 plus a first SSE
// envelope such as {"statusCodeValue":400,"body":"{\"code\":\"provider_error\",...}"}.
// The stock wrapper turned that into ordinary assistant text
// ("[qoder error 400: ...]") with finish_reason "stop", so the client recorded a
// *successful* turn whose content was garbage, appended it to the history and
// retried — that is exactly how an over-context session used to loop forever
// (every retry grew the prompt by another tool-less turn while the upstream
// spent ~1 minute rejecting it).
//
// Now the envelope is detected before a single byte is streamed downstream and
// converted into a real HTTP error, which lets chatCore log/persist it as a
// failure and lets Codex / Claude Code react (compact the conversation) instead
// of silently spinning.

const CONTEXT_OVERFLOW_PATTERN =
  /range of input length|input length|maximum context|context length|context window|context_length_exceeded|too many tokens|input is too long|prompt is too long|max_input_tokens|reduce the length/i;

const GENERIC_UPSTREAM_MESSAGES =
  /^(error in upstream response|upstream error|internal server error|bad request|service unavailable)$/i;

/**
 * Qoder nests the real provider error several layers deep, e.g.
 *   {"code":"provider_error","message":"Error in upstream response",
 *    "details":"{\"error\":{\"message\":\"<400> InternalError.Algo...\"}}"}
 * Walk the JSON (and JSON-inside-strings) and return the most specific message.
 */
function digUpstreamMessage(value) {
  const seen = [];
  const visit = (node, depth) => {
    if (node == null || depth > 5) return;
    if (typeof node === "string") {
      const text = node.trim();
      if (!text) return;
      if (text.startsWith("{") || text.startsWith("[")) {
        try {
          visit(JSON.parse(text), depth + 1);
          return;
        } catch {
          /* not JSON after all — treat as plain text */
        }
      }
      seen.push(text);
      return;
    }
    if (typeof node !== "object") return;
    for (const key of ["message", "details", "detail", "error", "msg", "reason"]) {
      if (node[key] !== undefined) visit(node[key], depth + 1);
    }
  };
  visit(value, 0);
  const specific = seen.filter((text) => !GENERIC_UPSTREAM_MESSAGES.test(text.trim()));
  return (specific.length > 0 ? specific[specific.length - 1] : seen[0]) || "";
}

/**
 * Classify an error envelope (or an HTTP error body) coming from Qoder.
 * Returns { status, envelopeStatus, message, raw, contextOverflow, code }.
 */
function classifyQoderEnvelopeError(statusVal, inner) {
  const raw = typeof inner === "string" ? inner : JSON.stringify(inner ?? "");
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const envelopeStatus = Number.isFinite(Number(statusVal)) ? Number(statusVal) : 502;
  const status = envelopeStatus >= 400 && envelopeStatus < 600 ? envelopeStatus : 502;
  const detail = digUpstreamMessage(parsed !== null ? parsed : raw);
  const message = truncate(detail || raw, 1000) || `upstream status ${envelopeStatus}`;
  const contextOverflow =
    CONTEXT_OVERFLOW_PATTERN.test(message) || CONTEXT_OVERFLOW_PATTERN.test(raw);
  return {
    status,
    envelopeStatus,
    message,
    raw: truncate(raw, 2000),
    contextOverflow,
    code: contextOverflow
      ? "context_length_exceeded"
      : status >= 500
        ? "upstream_error"
        : "provider_error",
  };
}

/**
 * Client-facing wording. Context overflow deliberately reuses the phrasing
 * OpenAI/Claude clients pattern-match on ("maximum context length",
 * "prompt is too long", "reduce the length") so they compact automatically
 * instead of showing an opaque failure.
 */
function formatQoderErrorMessage(info, opts = {}) {
  const { modelKey = null } = opts || {};
  const where = modelKey ? `qoder/${modelKey}` : "qoder";
  if (info.contextOverflow) {
    const detail = info.message || "";
    // Qoder's own overflow text already uses the canonical OpenAI wording
    // ("This model's maximum context length is N tokens. However, you requested
    // M tokens ... Please reduce the length ..."). Pass it through verbatim —
    // clients pattern-match on exactly those phrases to trigger a compaction,
    // and nesting our own sentence around it only makes the error unreadable.
    if (/maximum context length|reduce the length/i.test(detail)) {
      return `${where}: ${detail}`;
    }
    return (
      `${where}: maximum context length exceeded (prompt is too long / input is too long). ` +
      `Please reduce the length of your messages or compact the conversation, then retry. ` +
      `Upstream detail: ${detail}`
    );
  }
  return `qoder upstream error ${info.envelopeStatus} from ${where}: ${info.message}`;
}

function buildQoderEnvelopeErrorResponse(info, opts = {}) {
  if (info.contextOverflow && opts?.metrics) {
    opts.metrics.compactionTriggers = (opts.metrics.compactionTriggers || 0) + 1;
  }
  const message = truncate(formatQoderErrorMessage(info, opts), 1600);
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: info.status >= 500 ? "server_error" : "invalid_request_error",
        code: resolveCodexErrorCode({ status: info.status, message: info.message, fallbackCode: info.code }),
        ...(info.contextOverflow ? { param: "messages" } : {}),
      },
    }),
    {
      status: info.status,
      headers: {
        "Content-Type": "application/json",
        // Upstream overflow is the same client-facing problem as a proactive
        // rejection, so mark it identically: chatCore turns it into an SSE
        // `response.failed` for Responses-API clients so they compact and retry.
        ...(info.contextOverflow ? CONTEXT_OVERFLOW_HEADERS : {}),
      },
    },
  );
}

function replayQoderResponse(response, reader, chunks) {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const body = new ReadableStream({
    async start(controller) {
      try {
        for (const chunk of chunks) controller.enqueue(chunk);
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      try { reader.cancel(reason); } catch {}
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Qoder sometimes returns HTTP 200 and then emits a first SSE envelope with
 * statusCodeValue=403 and an inner 10605/isQueued body. The stock wrapper
 * turns that into ordinary assistant text ("[qoder error 403: ...]"), which
 * still interrupts Claude Code. Peek the first meaningful SSE data line and
 * ask execute() to retry before anything is sent downstream.
 */
async function peekStreamQueueInfo(response) {
  if (!response.ok || !response.body) return { queued: false, queueCount: null, response };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let buffer = "";
  let totalBytes = 0;
  const replay = () => replayQoderResponse(response, reader, chunks);

  while (true) {
    const { done, value } = await reader.read();
    if (done) return { queued: false, queueCount: null, response: replay() };
    chunks.push(value);
    totalBytes += value?.byteLength || value?.length || 0;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const trimmed = line.replace(/\r$/, "").trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;

      const data = trimmed.slice(5).trimStart();
      if (!data || data === "[DONE]") return { queued: false, queueCount: null, response: replay() };

      let envelope;
      try { envelope = JSON.parse(data); } catch { return { queued: false, queueCount: null, response: replay() }; }
      const statusVal = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
      const inner = typeof envelope.body === "string" ? envelope.body : "";
      if (statusVal === 403) {
        const info = parseQueueInfoText(inner);
        if (info.queued) {
          try { await reader.cancel("qoder stream queued"); } catch {}
          return { ...info, response: null };
        }
      }
      if (statusVal === 504) {
        const info = parseTimeoutInfoText(inner);
        if (info.timeout) {
          try { await reader.cancel(`qoder stream ${info.reason}`); } catch {}
          return { queued: true, queueCount: null, reason: info.reason, response: null };
        }
      }
      if (statusVal >= 400) {
        // Hard upstream failure (context overflow, invalid history, moderation,
        // ...). Nothing has been streamed to the client yet, so we can still
        // answer with a proper HTTP error.
        const info = classifyQoderEnvelopeError(statusVal, inner);
        try { await reader.cancel(`qoder stream error ${statusVal}`); } catch {}
        return { queued: false, queueCount: null, errorInfo: info, response: null };
      }
      return { queued: false, queueCount: null, response: replay() };
    }

    // Avoid buffering an unexpectedly large prefix. If Qoder does not send a
    // complete SSE line quickly, fall back to normal streaming behavior.
    if (totalBytes > 1024 * 1024 || chunks.length > 64) {
      return { queued: false, queueCount: null, response: replay() };
    }
  }
}

async function inspectQoderResponse(response, ctx = {}) {
  if (response.status === 403) {
    const info = await readQueueInfo(response);
    return { ...info, source: "http", response: info.queued ? null : response };
  }

  if (response.status === 504) {
    let text = "";
    try {
      text = await response.text();
    } catch {}
    const info = parseTimeoutInfoText(text);
    if (info.timeout) {
      return {
        queued: true,
        queueCount: null,
        reason: info.reason,
        source: "http",
        response: null,
      };
    }
    return {
      queued: false,
      queueCount: null,
      source: "http",
      response: new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    };
  }

  if (response.ok) {
    const peeked = await peekStreamQueueInfo(response);
    if (peeked.errorInfo) {
      const info = peeked.errorInfo;
      ctx?.log?.warn?.(
        "QODER",
        `upstream envelope error ${info.envelopeStatus}${info.contextOverflow ? " (context overflow)" : ""} · ${info.raw}`,
      );
      return {
        queued: false,
        queueCount: null,
        source: "stream",
        errorInfo: info,
        response: buildQoderEnvelopeErrorResponse(info, ctx),
      };
    }
    return { ...peeked, errorInfo: null, source: "stream" };
  }

  return { queued: false, queueCount: null, source: "http", response };
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(signal.reason || new Error("aborted"));
        },
        { once: true },
      );
    }
  });

function createQoderQueueRetryResponse({
  initialQueueInfo,
  model,
  signal,
  log,
  doFetch,
  retryOptions = QUEUE_RETRY,
  timeoutRetryOptions = TIMEOUT_RETRY,
  keepaliveMs = QODER_KEEPALIVE_MS,
  inspectCtx = {},
  continueFetch = null,
  metrics = null,
  hasTools = false,
  maxContinuations = QODER_AUTO_CONTINUE_MAX,
  sleepFn = sleep,
}) {
  const encoder = new TextEncoder();
  let stopped = false;
  let keepaliveTimer = null;
  let currentReader = null;

  return new Response(
    new ReadableStream({
      async start(controller) {
        const write = (value) => {
          if (stopped) return;
          try {
            controller.enqueue(
              typeof value === "string" ? encoder.encode(value) : value,
            );
          } catch {
            stopped = true;
          }
        };
        const keepalive = () => write(`: qoder queue keepalive ${Date.now()}\n\n`);
        const error = (message) => {
          const chunk = JSON.stringify({
            id: `qoder-error-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: { content: `\n[qoder error: ${truncate(message, 300)}]` },
                finish_reason: "stop",
              },
            ],
          });
          write(`data: ${chunk}\n\n${SSE_DONE}`);
        };

        keepalive();
        keepaliveTimer = setInterval(keepalive, Math.max(1000, keepaliveMs));

        let queueInfo = initialQueueInfo;
        let attempt = 0;
        let timeoutAttempts = 0;

        try {
          while (queueInfo?.queued) {
            const isTimeout = queueInfo.reason === "first token timeout";
            const budget = isTimeout ? timeoutRetryOptions : retryOptions;
            const used = isTimeout ? timeoutAttempts : attempt;
            if (used >= budget.maxAttempts) {
              log?.warn?.(
                "QODER",
                `${isTimeout ? "timeout" : "queue"} retry limit reached after ${used}/${budget.maxAttempts} attempts`,
              );
              error(isTimeout ? "timeout retry limit reached" : "queue retry limit reached");
              return;
            }

            if (isTimeout) timeoutAttempts++;
            else attempt++;
            const current = isTimeout ? timeoutAttempts : attempt;
            const delay = typeof budget.delayFor === "function"
              ? budget.delayFor(current)
              : Math.min(budget.baseDelayMs * current, budget.maxDelayMs);
            log?.info?.(
              "QODER",
              `${queueInfo.reason || "queued"} via ${queueInfo.source || "stream"} (position ${queueInfo.queueCount ?? "?"}), retry ${current}/${budget.maxAttempts} in ${Math.round(delay / 1000)}s`,
            );

            await sleepFn(delay, signal);

            let response;
            try {
              response = await doFetch(true);
            } catch (err) {
              error(`retry failed: ${err.message}`);
              return;
            }

            const inspected = await inspectQoderResponse(response, inspectCtx);
            queueInfo = inspected;

            if (queueInfo.queued) continue;
            if (!inspected.response?.ok) {
              // The keep-alive stream already sent HTTP 200, so the failure can
              // only be reported in-band. Use the classified message (nested
              // Qoder errors are otherwise unreadable) instead of the raw body.
              let message = `upstream status ${inspected.response?.status || 502}`;
              if (inspected.errorInfo) {
                message = formatQoderErrorMessage(inspected.errorInfo, inspectCtx);
              } else {
                try {
                  const text = await inspected.response.text();
                  if (text) message = text;
                } catch {}
              }
              error(message);
              return;
            }

            // A queued request that finally succeeds must keep the same continuation
            // behaviour as a direct one, otherwise the "announce then stop" gap only
            // shows up on the queued path.
            const wrapped = wrapQoderSSE(inspected.response, model, {
              metrics,
              continueFetch,
        metrics,
              hasTools,
              maxContinuations,
              log,
            });
            if (!wrapped.body) {
              error("upstream returned an empty stream");
              return;
            }

            currentReader = wrapped.body.getReader();
            while (!stopped) {
              const { done, value } = await currentReader.read();
              if (done) break;
              write(value);
            }
            return;
          }

          error("queue wait completed without an upstream response");
        } catch (err) {
          if (!stopped) error(err.message || String(err));
        } finally {
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
          if (!stopped) controller.close();
        }
      },
      async cancel(reason) {
        stopped = true;
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        try {
          await currentReader?.cancel(reason);
        } catch {}
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    },
  );
}
// ============ end 9router-fix patch ============

/**
 * Hoist role:"system" messages out of the messages array (Qoder rejects
 * system in messages) and convert multipart image content to Qoder's shape.
 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], systemText: "", imageCount: 0, invalidImageCount: 0 };
  }
  const systemParts = [];
  const out = [];
  let imageCount = 0;
  let invalidImageCount = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const { text, images, invalidImages } = extractContent(msg.content);
    if (msg.role === "system") {
      if (text) systemParts.push(text);
      continue;
    }
    const cloned = { ...msg };
    cloned.content = images.length > 0 ? "" : text;
    if (images.length > 0) {
      cloned.contents = [
        ...images,
        { type: "text", text },
      ];
      imageCount += images.length;
      invalidImageCount += invalidImages;
    }
    out.push(cloned);
  }
  return { messages: out, systemText: systemParts.join("\n\n"), imageCount, invalidImageCount };
}

function isValidQoderImageUrl(url) {
  if (typeof url !== "string" || !url) return false;
  return /^https?:\/\//i.test(url) || (url.startsWith("data:image/") && url.includes(";base64,"));
}

function normalizeImagePart(item) {
  if (!item || typeof item !== "object" || item.type !== "image_url") return null;
  const raw = item.image_url;
  const url = typeof raw === "string" ? raw : raw?.url;
  return {
    type: "image_url",
    image_url: { url: typeof url === "string" ? url : "" },
    _invalid: !isValidQoderImageUrl(url),
  };
}

function extractContent(content) {
  if (typeof content === "string") return { text: content, images: [], invalidImages: 0 };
  if (content == null) return { text: "", images: [], invalidImages: 0 };
  if (Array.isArray(content)) {
    const parts = [];
    const images = [];
    let invalidImages = 0;
    for (const item of content) {
      if (item && typeof item === "object") {
        const image = normalizeImagePart(item);
        if (image) {
          if (image._invalid) {
            invalidImages++;
          }
          delete image._invalid;
          images.push(image);
          continue;
        }
        if (item.type === "text" && typeof item.text === "string") {
          parts.push(item.text);
        } else if (typeof item.text === "string") {
          parts.push(item.text);
        }
      }
    }
    return { text: parts.join("\n"), images, invalidImages };
  }
  return { text: String(content), images: [], invalidImages: 0 };
}

function validateQoderImageSupport({ modelConfig, imageCount, invalidImageCount = 0 }) {
  if (invalidImageCount > 0) {
    throw new Error("qoder: image input is missing a valid image_url");
  }
  if (imageCount > 0 && !supportsQoderImageInput(modelConfig)) {
    throw new Error(
      `qoder: model "${modelConfig?.key || "unknown"}" does not support image input`,
    );
  }
  if (imageCount > 0) return { ...modelConfig, is_vl: true };
  return modelConfig;
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string" && m.content) return m.content;
    if (!Array.isArray(m.contents)) continue;
    const text = m.contents
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (text) return text;
    if (m.contents.some((part) => part?.type === "image_url")) return "[Image input]";
  }
  return "";
}

function stableHash(prefix, ...parts) {
  const h = createHash("sha256");
  h.update(prefix);
  for (const p of parts) {
    h.update("\0");
    h.update(String(p ?? ""));
  }
  return h.digest("hex").slice(0, 16);
}

function stableChatRecordId(model, messages, tools, maxTokens, sessionId) {
  const h = createHash("sha256");
  h.update("qoder-record\0");
  h.update(String(model));
  h.update("\0session=");
  h.update(String(sessionId || ""));
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role) { h.update("\0"); h.update(m.role); }
    if (typeof m.content === "string" && m.content) {
      h.update("\0"); h.update(m.content);
    }
    if (Array.isArray(m.contents)) {
      try { h.update("\0"); h.update(JSON.stringify(m.contents)); } catch {}
    }
  }
  if (tools) {
    h.update("\0");
    try { h.update(JSON.stringify(tools)); } catch {}
  }
  h.update(`\0mt=${maxTokens}`);
  return h.digest("hex").slice(0, 16);
}

const DANGLING_EXCLUSIONS = /let me know|告诉我|如有疑问|有问题随时/i;
const DANGLING_COLON = /[:：]\s*$/;
const DANGLING_INTENT = /(让我|我先|我来|我核对|我检查|我查一下|接下来|现在|let me|i'?ll|i will|now let|next,? i)[^。！？!?]{0,60}[。.]?\s*$/i;

/**
 * Heuristic for "announcement endings": the model said what it will do next
 * but ended the turn instead of emitting a tool call. Conservative on purpose
 * (short text, colon or intent verb at the tail, common closing phrases
 * excluded) so normal final answers are never continued.
 */
export function looksLikeDanglingIntent(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 600) return false;
  if (DANGLING_EXCLUSIONS.test(t)) return false;
  if (DANGLING_COLON.test(t)) return true;
  return DANGLING_INTENT.test(t.slice(-120));
}

// Continuation budget: settings first (dashboard editable), env var wins when set
// explicitly so an operator can still disable it during an incident.
async function resolveTimeoutPolicyForRequest({ log } = {}) {
  try {
    const { getCodexCompatSettings } = await import("@/shared/services/codexCompat.js");
    const settings = await getCodexCompatSettings();
    const policy = resolveTimeoutPolicy(settings);
    log?.info?.(CODE_LOG, `timeout_policy=${policy.strategy}`);
    return policy;
  } catch {
    return resolveTimeoutPolicy({});
  }
}

async function resolveAutoContinueMax() {
  const envRaw = Number(process.env.QODER_AUTO_CONTINUE_MAX);
  if (Number.isFinite(envRaw)) return Math.max(0, Math.floor(envRaw));
  try {
    const { getCodexCompatSettings } = await import("@/shared/services/codexCompat.js");
    const settings = await getCodexCompatSettings();
    const value = Number(settings?.autoContinueMax);
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : QODER_AUTO_CONTINUE_MAX;
  } catch {
    return QODER_AUTO_CONTINUE_MAX;
  }
}
function truncate(s, n) {
  return s && s.length > n ? `${s.slice(0, n)}...` : s || "";
}

/**
 * Map the OpenAI-style request body into the exact shape Qoder expects.
 */
async function buildQoderRequestBody({ model, body, credentials, log, proxyOptions, signal, clientSessionId }) {
  const qoderKey = String(model || "").replace(/^qoder\//, "");
  
  // Fetch model config from dynamic API instead of relying on static QODER_MODEL_MAP.
  // This allows support for new Qoder models (e.g., qmodel_latest) without code changes.
  let modelConfig = await getQoderModelConfig(credentials, qoderKey, { log, proxyOptions, signal });
  if (!modelConfig) {
    // Try a forced refresh once before giving up — the cache may simply
    // not be populated yet on first ever call for this credential.
    const refreshed = await resolveQoderModels(credentials, { forceRefresh: true, log, proxyOptions, signal });
    const retried = refreshed?.rawConfigs.get(qoderKey);
    if (!retried) {
      throw new Error(
        `qoder: model_config for "${qoderKey}" not yet known (run a model list fetch or check upstream connectivity)`,
      );
    }
    modelConfig = { ...retried, key: qoderKey };
  }

  const { messages, systemText, imageCount, invalidImageCount } = normalizeMessages(body.messages || []);
  modelConfig = validateQoderImageSupport({ modelConfig, imageCount, invalidImageCount });
  const tools = body.tools;
  const isReasoning = !!modelConfig.is_reasoning;
  const maxOutputTokens = Number(modelConfig.max_output_tokens) || 0;

  let maxTokens = 32_768;
  if (maxOutputTokens > 0) maxTokens = maxOutputTokens;
  if (typeof body.max_tokens === "number" && body.max_tokens > 0 && body.max_tokens < maxTokens) {
    maxTokens = body.max_tokens;
  }
  if (typeof body.max_completion_tokens === "number" && body.max_completion_tokens > 0 && body.max_completion_tokens < maxTokens) {
    maxTokens = body.max_completion_tokens;
  }

  const lastUser = lastUserText(messages);
  const psd = credentials.providerSpecificData || {};
  // Qoder keeps server-side state by session_id. The account is not a
  // conversation boundary: two clients can legitimately use the same account
  // at the same time. chatCore resolves the client conversation identity before
  // translation so it survives providers that strip client metadata.
  const resolvedClientSessionId =
    typeof clientSessionId === "string" && clientSessionId.trim()
      ? clientSessionId.trim()
      : resolveSessionId({
          headers: credentials?.rawHeaders,
          body,
          connectionId: credentials?.connectionId || credentials?.id,
          scope: "qoder",
        });
  const sessionId = stableHash("qoder-session", qoderKey, resolvedClientSessionId);
  const recordId = stableChatRecordId(qoderKey, messages, tools, maxTokens, sessionId);

  return {
    qoderKey,
    payload: {
      request_id: uuidv4(),
      request_set_id: recordId,
      chat_record_id: recordId,
      session_id: sessionId,
      stream: true,
      chat_task: "FREE_INPUT",
      is_reply: true,
      is_retry: false,
      source: 1,
      version: "3",
      session_type: "qodercli",
      agent_id: "agent_common",
      task_id: "common",
      code_language: "",
      chat_prompt: "",
      image_urls: null,
      aliyun_user_type: "",
      system: systemText,
      messages,
      tools: Array.isArray(tools) ? tools : [],
      parameters: { max_tokens: maxTokens },
      chat_context: {
        chatPrompt: "",
        imageUrls: null,
        extra: {
          context: [],
          modelConfig: {
            key: qoderKey,
            is_reasoning: isReasoning,
            ...(imageCount > 0 ? { is_vl: true } : {}),
          },
          originalContent: lastUser,
        },
        features: [],
        text: lastUser,
      },
      model_config: modelConfig,
      business: {
        product: "cli",
        version: "1.0.0",
        type: "agent",
        stage: "start",
        id: uuidv4(),
        name: truncate(lastUser, 30),
        begin_at: Date.now(),
      },
    },
    modelConfig,
  };
}

/**
 * Wrap the upstream's `{statusCodeValue, body}` SSE envelope into plain
 * OpenAI SSE chunks the rest of the chatCore pipeline understands.
 *
 * Each upstream line looks like:
 *   data: {"statusCodeValue":200,"body":"{\"choices\":[{\"delta\":{...}}]}"}
 * The inner body is an OpenAI streaming chunk (or "[DONE]"). We unwrap it
 * and re-emit as `data: <inner>\n\n`. Errors become `data: [DONE]\n\n` plus
 * a synthetic OpenAI error chunk.
 */
function wrapQoderSSE(response, model, opts = {}) {
  const {
    keepaliveMs = QODER_KEEPALIVE_MS,
    continueFetch = null,
    maxContinuations = QODER_AUTO_CONTINUE_MAX,
    hasTools = false,
    metrics = null,
    log = null,
  } = opts || {};
  if (!response.ok || !response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let doneEmitted = false;
  let upstreamEnded = false;
  let keepaliveTimer = null;
  let reader = null;

  // Per-turn trackers used by the auto-continue guard.
  let sawToolCall = false;
  let lastFinish = null;
  let turnText = "";
  let continuationsUsed = 0;
  // Terminal frames are held back until we know whether this turn continues.
  // Codex ends the turn (and aborts the in-flight request) the moment it sees a
  // finish_reason, so forwarding one and *then* asking upstream for the rest
  // produced "auto-continue request failed: This operation was aborted" and the
  // client kept a truncated answer. Released below when no continuation follows.
  let heldFinishFrame = null;
  const isHeldTerminal = (chunk) => {
    const reason = chunk?.choices?.[0]?.finish_reason;
    // tool_calls is a genuine end of turn: the client still has work to do and
    // will not be aborted, so it passes straight through.
    return typeof reason === "string" && reason.length > 0 && reason !== "tool_calls";
  };

  let reasoningDeltas = 0;
  const trackChunk = (chunk) => {
    if (typeof chunk?.choices?.[0]?.delta?.reasoning_content === "string" && chunk.choices[0].delta.reasoning_content) {
      reasoningDeltas += 1;
      if (metrics) metrics.reasoningEvents = reasoningDeltas;
    }
    const choice = chunk?.choices?.[0];
    if (!choice) return;
    if (Array.isArray(choice.delta?.tool_calls) && choice.delta.tool_calls.length > 0) {
      sawToolCall = true;
    }
    if (typeof choice.delta?.content === "string") turnText += choice.delta.content;
    if (choice.finish_reason) lastFinish = choice.finish_reason;
  };

  // Qoder envelope line: data: {"statusCodeValue":200,"body":"<openai chunk>"}
  const processLine = (line, controller) => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("data:")) return;
    if (doneEmitted || upstreamEnded) return;

    const data = trimmed.slice(5).trimStart();
    if (data === "[DONE]") {
      upstreamEnded = true;
      return;
    }

    let envelope;
    try { envelope = JSON.parse(data); } catch { return; }
    const statusVal = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
    const inner = typeof envelope.body === "string" ? envelope.body : "";
    if (statusVal !== 200) {
      const msg = inner || `upstream status ${statusVal}`;
      // Headers are already on the wire, so this turn can only fail in-band.
      // Log the untruncated upstream detail — the client-facing chunk below is
      // deliberately short.
      const info = classifyQoderEnvelopeError(statusVal, inner);
      if (info.contextOverflow && metrics) {
        metrics.compactionTriggers = (metrics.compactionTriggers || 0) + 1;
      }
      log?.warn?.(
        "QODER",
        `mid-stream envelope error ${info.envelopeStatus}${info.contextOverflow ? " (context overflow)" : ""} · ${info.raw || msg}`,
      );
      // In-band failure means headers are already on the wire, so the only honest
      // signal left is a real error frame: emitting assistant text with
      // finish_reason=stop would make Codex record a successful turn (and retry with
      // a poisoned history).
      const inbandCode = resolveCodexErrorCode({ status: statusVal, message: msg, fallbackCode: "upstream_error" });
      const inbandMessage = inbandCode === "rate_limit_exceeded"
        ? withRetryAfterHint(truncate(msg, 400), 30000)
        : truncate(msg, 1600);
      const errFrame = JSON.stringify({ error: { message: inbandMessage, type: "server_error", code: inbandCode } });
      controller.enqueue(encoder.encode(`data: ${errFrame}\n\n`));
      controller.enqueue(encoder.encode(SSE_DONE));
      doneEmitted = true;
      return;
    }
    if (!inner) return;
    if (inner === "[DONE]") {
      upstreamEnded = true;
      return;
    }
    // Inner is an OpenAI-shaped chunk. Strip any embedded newlines so the
    // SSE frame stays a single event (a literal "\n" inside `inner` would
    // otherwise split the frame across multiple data: lines and downstream
    // parsers would reassemble them as separate events).
    const sanitized = inner.replace(/\r?\n/g, "");
    let chunk = null;
    try { chunk = JSON.parse(sanitized); } catch {}
    if (chunk) trackChunk(chunk);
    if (isHeldTerminal(chunk)) {
      heldFinishFrame = `data: ${sanitized}\n\n`;
      return;
    }
    controller.enqueue(encoder.encode(`data: ${sanitized}\n\n`));
  };

  // Continuation streams are already plain OpenAI SSE (produced by a nested
  // wrapQoderSSE). Forward their chunks verbatim and swallow their terminal
  // [DONE]: this wrapper owns the single terminal sentinel of the response.
  const processOpenAILine = (line, controller) => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("data:")) return;
    if (doneEmitted || upstreamEnded) return;
    const data = trimmed.slice(5).trimStart();
    if (data === "[DONE]") {
      upstreamEnded = true;
      return;
    }
    let chunk = null;
    try { chunk = JSON.parse(data); } catch { return; }
    trackChunk(chunk);
    if (isHeldTerminal(chunk)) {
      heldFinishFrame = `data: ${data}\n\n`;
      return;
    }
    controller.enqueue(encoder.encode(`data: ${data}\n\n`));
  };

  const transformed = new ReadableStream({
    async start(controller) {
      const writeKeepalive = () => {
        if (!doneEmitted) {
          try {
            controller.enqueue(encoder.encode(`: qoder stream keepalive ${Date.now()}\n\n`));
          } catch {}
        }
      };
      keepaliveTimer = setInterval(
        writeKeepalive,
        Math.max(10, keepaliveMs),
      );

      const pump = async (currentReader, kind) => {
        reader = currentReader;
        const handle = kind === "qoder" ? processLine : processOpenAILine;
        while (true) {
          const { done, value } = await reader.read();
          if (done) return true;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            handle(line, controller);
            if (doneEmitted || upstreamEnded) break;
          }
          if (doneEmitted) return false;
          if (upstreamEnded) {
            try { await reader.cancel("qoder stream done"); } catch {}
            return true;
          }
        }
      };

      const flushBuffer = (kind) => {
        if (buffer.length > 0) {
          (kind === "qoder" ? processLine : processOpenAILine)(buffer, controller);
          buffer = "";
        }
      };

      let failure = null;
      let kind = "qoder";
      try {
        let ended = await pump(response.body.getReader(), kind);
        flushBuffer(kind);
        while (
          ended &&
          !doneEmitted &&
          continueFetch &&
          continuationsUsed < maxContinuations &&
          hasTools &&
          !sawToolCall &&
          lastFinish !== "tool_calls" &&
          looksLikeDanglingIntent(turnText)
        ) {
          continuationsUsed += 1;
          if (metrics) metrics.continuations = continuationsUsed;
          // This turn is not over after all - drop the terminal frame we held,
          // otherwise the client would end the turn (and abort us) mid-stream.
          heldFinishFrame = null;
          log?.info?.(
            "QODER",
            `auto-continue ${continuationsUsed}/${maxContinuations}: turn ended (finish=${lastFinish || "eof"}) with no tool call and a dangling intent`,
          );
          let nextStream = null;
          try {
            nextStream = await continueFetch(turnText);
          } catch (err) {
            log?.warn?.("QODER", `auto-continue request failed: ${err.message}`);
          }
          if (!nextStream || !nextStream.body) break;
          sawToolCall = false;
          lastFinish = null;
          turnText = "";
          upstreamEnded = false;
          kind = "openai";
          ended = await pump(nextStream.body.getReader(), kind);
          flushBuffer(kind);
        }
        log?.info?.(CODE_LOG, `stream_done reasoning_events=${reasoningDeltas} continuations=${continuationsUsed}`);
        if (!doneEmitted) {
          // No continuation will follow: release the terminal frame now so the
          // client closes the turn exactly as it did before this guard existed.
          if (heldFinishFrame) {
            controller.enqueue(encoder.encode(heldFinishFrame));
            heldFinishFrame = null;
          }
          controller.enqueue(encoder.encode(SSE_DONE));
          doneEmitted = true;
        }
      } catch (err) {
        if (!doneEmitted) failure = err;
      } finally {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
      }

      if (failure) {
        try { controller.error(failure); } catch {}
      } else {
        try { controller.close(); } catch {}
      }
    },
    async cancel(reason) {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      try {
        await reader?.cancel(reason);
      } catch {}
    },
  });

  /*
   * The manual reader above replaces the previous TransformStream so it can
   * emit comment frames while the upstream is silent. Codex's default SSE
   * idle timeout is only five minutes, while Qoder can legitimately pause for
   * longer during model scheduling.
   */
  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export class QoderExecutor extends BaseExecutor {
  constructor() {
    super("qoder", PROVIDERS.qoder);
  }

  buildUrl() {
    return QODER_CHAT_URL_ENCODED;
  }

  // Override execute entirely — Qoder needs:
  //   - body built from translated chat completion payload
  //   - body encoded with QoderEncodeBody before signing
  //   - COSY headers built from the *encoded* body bytes
  //   - response stream re-wrapped from {statusCodeValue, body} to OpenAI SSE
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, metrics = null, clientSessionId }) {
    const url = this.buildUrl();

    const psd = credentials?.providerSpecificData || {};
    if (!psd.userId) {
      // No user id → no way to sign. Surface a 401 so the dashboard nudges
      // the user back to OAuth.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "qoder credential is missing userId; reconnect the account" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }
    if (!credentials?.accessToken) {
      // Same shape as the userId guard — clean 401 so chatCore reports
      // "reconnect" rather than bubbling cosy.js's synchronous throw as 500.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "qoder credential is missing accessToken; reconnect the account" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    let qoderKey;
    let modelConfig;
    let payload;
    try {
      ({ qoderKey, payload, modelConfig } = await buildQoderRequestBody({ model, body, credentials, log, proxyOptions, signal, clientSessionId }));
    } catch (err) {
      const fakeResp = new Response(
        JSON.stringify({ error: { message: err.message } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    // Diagnostic only: production measured ~1M estimated vs 524K actual tokens.
    // Rejecting on this heuristic strands Codex before its real 900K compact
    // threshold. The upstream enforces its window; response usage drives Codex.
    if (body?._compact !== true) {
      try {
        const contextWindow = QODER_CONTEXT_WINDOW;
        const estimatedTokens = estimateRequestTokens(body);
        if (metrics) {
          metrics.contextPeakEstimate = estimatedTokens;
          metrics.contextLimit = contextWindow;
        }
        if (estimatedTokens > contextWindow * 0.7) {
          log?.info?.(CODE_LOG, `context_estimate est=${estimatedTokens} window=${contextWindow} diagnostic_only=true`);
        }
      } catch (err) {
        log?.warn?.("QODER", `context estimate skipped: ${err.message}`);
      }
    }
    // 9router-fix: Qoder rejects queue retries with "Duplicate request" if
    // request ids are reused after an HTTP-200/SSE queued envelope. Keep the
    // semantic payload stable, but refresh request-level ids before each retry
    // and rebuild the COSY signature over the new encoded body.
    const makeAttemptRequest = (refreshIds = false, basePayload = null) => {
      const source = basePayload || payload;
      const attemptPayload = refreshIds
        ? {
            ...source,
            request_id: uuidv4(),
            request_set_id: uuidv4(),
            chat_record_id: uuidv4(),
            business: {
              ...payload.business,
              id: uuidv4(),
              begin_at: Date.now(),
            },
          }
        : payload;
      const plainBody = Buffer.from(JSON.stringify(attemptPayload), "utf8");
      const encodedBodyStr = qoderEncodeBody(plainBody);
      const encodedBodyBuf = Buffer.from(encodedBodyStr, "latin1");
      const cosyHeaders = buildCosyHeaders(
        encodedBodyBuf,
        url,
        {
          userId: psd.userId,
          authToken: credentials.accessToken,
          name: credentials.displayName || "",
          email: credentials.email || "",
          machineId: psd.machineId || "",
        },
      );
      const modelSource = (attemptPayload.model_config && attemptPayload.model_config.source) || "system";
      return {
        body: encodedBodyBuf,
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Model-Key": qoderKey,
          "X-Model-Source": modelSource,
          // gzip triggers signature validation on Qoder's CDN; force identity.
          "Accept-Encoding": "identity",
          ...cosyHeaders,
        },
        payload: attemptPayload,
      };
    };
    let currentAttemptRequest;
    try {
      currentAttemptRequest = makeAttemptRequest(false);
    } catch (err) {
      // cosy.js throws synchronously on missing userId/authToken — surface
      // as 401 so chatCore prompts re-auth instead of returning a 500.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: `qoder cosy signing failed: ${err.message}` } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;

    // 9router-fix: the whole fetch lives in a helper so the queue stream can
    // re-issue the exact same signed request after a retry delay.
    const fetchRequest = async (reqObj) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const sig = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
      try {
        return await proxyAwareFetch(
          url,
          { method: "POST", headers: reqObj.headers, body: reqObj.body, signal: sig },
          proxyOptions,
        );
      } finally {
        clearTimeout(timer);
      }
    };
    const doFetch = async (refreshIds = false) => {
      if (refreshIds) currentAttemptRequest = makeAttemptRequest(true);
      return fetchRequest(currentAttemptRequest);
    };

    // Context for error classification: which qoder model key the failure
    // belongs to (so the client-facing message names it) plus the logger.
    const inspectCtx = { log, modelKey: qoderKey, metrics };

    // Shared by both success paths (direct and post-queue-retry): continue a turn the
    // model announced but never executed. Empty reasoning-only assistant turns are
    // dropped so the continuation does not replay them.
    const continueFetch = async (danglingText) => {
      const sanitizedMessages = (Array.isArray(body.messages) ? body.messages : []).filter(
        (message) =>
          !(
            message?.role === "assistant" &&
            !message?.tool_calls?.length &&
            !String(message?.content ?? "").trim()
          ),
      );
      const nudgedBody = {
        ...body,
        messages: [
          ...sanitizedMessages,
          { role: "assistant", content: danglingText },
          { role: "user", content: CONTINUE_NUDGE },
        ],
      };
      const built = await buildQoderRequestBody({ model, body: nudgedBody, credentials, log, proxyOptions, signal, clientSessionId });
      const req = makeAttemptRequest(true, built.payload);
      const resp = await fetchRequest(req);
      const inspectedNext = await inspectQoderResponse(resp, inspectCtx);
      if (inspectedNext.queued || inspectedNext.errorInfo || !inspectedNext.response?.ok) return null;
      return wrapQoderSSE(inspectedNext.response, `qoder/${qoderKey}`, { metrics, log });
    };
    const autoContinueMax = await resolveAutoContinueMax();
    const timeoutPolicy = await resolveTimeoutPolicyForRequest({ log });
    let response = await doFetch();
    const inspected = await inspectQoderResponse(response, inspectCtx);

    if (inspected.errorInfo) {
      // Hard upstream rejection (context overflow / bad history / moderation).
      // Hand it back as a real HTTP error so chatCore records a failure and the
      // client can recover — never as assistant text.
      return {
        response: inspected.response,
        url,
        headers: currentAttemptRequest.headers,
        transformedBody: currentAttemptRequest.payload,
      };
    }

    if (inspected.queued) {
      const queued = createQoderQueueRetryResponse({
        initialQueueInfo: inspected,
        model: `qoder/${qoderKey}`,
        signal,
        log,
        doFetch,
        timeoutRetryOptions: timeoutPolicy.timeoutOptions,
        inspectCtx,
        continueFetch,
        metrics,
        hasTools: Array.isArray(body.tools) && body.tools.length > 0,
        maxContinuations: autoContinueMax,
      timeoutRetryOptions: timeoutPolicy.timeoutOptions,
      });
      return {
        response: queued,
        url,
        headers: currentAttemptRequest.headers,
        transformedBody: currentAttemptRequest.payload,
      };
    }

    response = inspected.response;

    if (!response.ok) {
      // Pass error response through unchanged so chatCore can capture it.
      return { response, url, headers: currentAttemptRequest.headers, transformedBody: currentAttemptRequest.payload };
    }

    // Auto-continue guard: if the model ends the turn right after announcing
    // the next step (no tool call), issue one hidden continuation request and
    // splice its stream into this response so the agent loop keeps running.
    const wrapped = wrapQoderSSE(response, `qoder/${qoderKey}`, {
      metrics,
      maxContinuations: autoContinueMax,
      timeoutRetryOptions: timeoutPolicy.timeoutOptions,
      continueFetch,
      hasTools: Array.isArray(body.tools) && body.tools.length > 0,
      log,
    });
    return { response: wrapped, url, headers: currentAttemptRequest.headers, transformedBody: currentAttemptRequest.payload };
  }

  /**
   * chatCore calls this for non-2xx provider responses. Qoder's HTTP-level
   * error bodies nest the real message ({"code":"provider_error","message":
   * "Error in upstream response","details":"{\"error\":{\"message\":\"<400> ...\"}}"}),
   * so decode it and flag context overflow with client-recognisable wording.
   */
  parseError(response, bodyText) {
    const status = response?.status;
    if (!Number.isFinite(Number(status))) return null;
    // chatCore re-parses the body of whatever we hand back, including the
    // envelope-error Response built above. Recognise an already-formatted
    // OpenAI-style error body and pass its message through untouched, otherwise
    // the client sees our sentence wrapped inside our sentence.
    try {
      const parsed = JSON.parse(bodyText || "");
      const message = parsed?.error?.message;
      if (typeof message === "string" && message.trim()) {
        return { status: Number(status), message: truncate(message, 1600) };
      }
    } catch {
      /* not JSON — fall through to Qoder's nested shape */
    }
    const info = classifyQoderEnvelopeError(Number(status), bodyText || "");
    if (!info.message) return null;
    return {
      status: info.status,
      message: truncate(formatQoderErrorMessage(info, { modelKey: null, maxInputTokens: 0 }), 1600),
    };
  }

  // Qoder device tokens don't refresh through OAuth — the upstream returns
  // 403 for our flow. Surfacing failure via 401-on-chat is enough; the
  // dashboard tells users to re-login when their token expires (~30 days).
  async refreshCredentials() {
    return null;
  }

  needsRefresh() {
    return false;
  }
}

export default QoderExecutor;

// Internals exposed for unit tests. Not part of the public API — callers
// should import QoderExecutor and use its public methods.
export const __test__ = {
  looksLikeDanglingIntent,
  normalizeMessages,
  validateQoderImageSupport,
  wrapQoderSSE,
  buildQoderRequestBody,
  createQoderQueueRetryResponse,
  inspectQoderResponse,
  classifyQoderEnvelopeError,
  formatQoderErrorMessage,
  buildQoderEnvelopeErrorResponse,
  digUpstreamMessage,
};

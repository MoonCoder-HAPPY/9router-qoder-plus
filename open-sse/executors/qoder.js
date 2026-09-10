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

function parseQueueInfoText(text) {
  const queued =
    text.includes('"isQueued":true') ||
    text.includes('\\"isQueued\\":true') ||
    text.includes("10605");
  const m = text.match(/queueCount[\\"]*:?\s*(\d+)/);
  return { queued, queueCount: m ? Number(m[1]) : null };
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
      if (statusVal === 504 && inner.toLowerCase().includes("upstream model timeout")) {
        try { await reader.cancel("qoder stream upstream model timeout"); } catch {}
        return { queued: true, queueCount: null, reason: "upstream model timeout", response: null };
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

async function inspectQoderResponse(response) {
  if (response.status === 403) {
    const info = await readQueueInfo(response);
    return { ...info, source: "http", response: info.queued ? null : response };
  }

  if (response.ok) {
    const peeked = await peekStreamQueueInfo(response);
    return { ...peeked, source: "stream" };
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
  keepaliveMs = QODER_KEEPALIVE_MS,
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

        try {
          while (queueInfo?.queued) {
            if (attempt >= retryOptions.maxAttempts) {
              log?.warn?.(
                "QODER",
                `queue retry limit reached after ${attempt}/${retryOptions.maxAttempts} attempts`,
              );
              error("queue retry limit reached");
              return;
            }

            attempt++;
            const delay = Math.min(
              retryOptions.baseDelayMs * attempt,
              retryOptions.maxDelayMs,
            );
            log?.info?.(
              "QODER",
              `${queueInfo.reason || "queued"} via ${queueInfo.source || "stream"} (position ${queueInfo.queueCount ?? "?"}), retry ${attempt}/${retryOptions.maxAttempts} in ${Math.round(delay / 1000)}s`,
            );

            await sleepFn(delay, signal);

            let response;
            try {
              response = await doFetch(true);
            } catch (err) {
              error(`retry failed: ${err.message}`);
              return;
            }

            const inspected = await inspectQoderResponse(response);
            queueInfo = inspected;

            if (queueInfo.queued) continue;
            if (!inspected.response?.ok) {
              let message = `upstream status ${inspected.response?.status || 502}`;
              try {
                const text = await inspected.response.text();
                if (text) message = text;
              } catch {}
              error(message);
              return;
            }

            const wrapped = wrapQoderSSE(inspected.response, model);
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

function stableChatRecordId(model, messages, tools, maxTokens) {
  const h = createHash("sha256");
  h.update("qoder-record\0");
  h.update(String(model));
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

function truncate(s, n) {
  return s && s.length > n ? `${s.slice(0, n)}...` : s || "";
}

/**
 * Map the OpenAI-style request body into the exact shape Qoder expects.
 */
async function buildQoderRequestBody({ model, body, credentials, log, proxyOptions, signal }) {
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
  const sessionId = stableHash("qoder-session", psd.userId, qoderKey);
  const recordId = stableChatRecordId(qoderKey, messages, tools, maxTokens);

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
function wrapQoderSSE(response, model, keepaliveMs = QODER_KEEPALIVE_MS) {
  if (!response.ok || !response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let doneEmitted = false;
  let keepaliveTimer = null;
  let reader = null;

  // Process one already-extracted SSE line (no trailing newline). Returns
  // false when the line indicated end-of-stream so the caller can stop
  // forwarding any remaining chunks after [DONE].
  const processLine = (line, controller) => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("data:")) return;
    if (doneEmitted) return; // never forward chunks past stream end

    const data = trimmed.slice(5).trimStart();
    if (data === "[DONE]") {
      controller.enqueue(encoder.encode(SSE_DONE));
      doneEmitted = true;
      return;
    }

    let envelope;
    try { envelope = JSON.parse(data); } catch { return; }
    const statusVal = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
    const inner = typeof envelope.body === "string" ? envelope.body : "";
    if (statusVal !== 200) {
      const msg = inner || `upstream status ${statusVal}`;
      const errChunk = JSON.stringify({
        id: `qoder-error-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: `\n[qoder error ${statusVal}: ${truncate(msg, 200)}]` }, finish_reason: "stop" }],
      });
      controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
      controller.enqueue(encoder.encode(SSE_DONE));
      doneEmitted = true;
      return;
    }
    if (!inner) return;
    if (inner === "[DONE]") {
      controller.enqueue(encoder.encode(SSE_DONE));
      doneEmitted = true;
      return;
    }
    // Inner is an OpenAI-shaped chunk. Strip any embedded newlines so the
    // SSE frame stays a single event (a literal "\n" inside `inner` would
    // otherwise split the frame across multiple data: lines and downstream
    // parsers would reassemble them as separate events).
    const sanitized = inner.replace(/\r?\n/g, "");
    controller.enqueue(encoder.encode(`data: ${sanitized}\n\n`));
  };

  const transformed = new ReadableStream({
    async start(controller) {
      reader = response.body.getReader();
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

      let failure = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            processLine(line, controller);
            if (doneEmitted) break;
          }
          if (doneEmitted) {
            try { await reader.cancel("qoder stream done"); } catch {}
            break;
          }
        }

        buffer += decoder.decode();
        if (buffer.length > 0) {
          processLine(buffer, controller);
          buffer = "";
        }
        if (!doneEmitted) {
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
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
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
    let payload;
    try {
      ({ qoderKey, payload } = await buildQoderRequestBody({ model, body, credentials, log, proxyOptions, signal }));
    } catch (err) {
      const fakeResp = new Response(
        JSON.stringify({ error: { message: err.message } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    // 9router-fix: Qoder rejects queue retries with "Duplicate request" if
    // request ids are reused after an HTTP-200/SSE queued envelope. Keep the
    // semantic payload stable, but refresh request-level ids before each retry
    // and rebuild the COSY signature over the new encoded body.
    const makeAttemptRequest = (refreshIds = false) => {
      const attemptPayload = refreshIds
        ? {
            ...payload,
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
    const doFetch = async (refreshIds = false) => {
      if (refreshIds) currentAttemptRequest = makeAttemptRequest(true);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const sig = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
      try {
        return await proxyAwareFetch(
          url,
          { method: "POST", headers: currentAttemptRequest.headers, body: currentAttemptRequest.body, signal: sig },
          proxyOptions,
        );
      } finally {
        clearTimeout(timer);
      }
    };

    let response = await doFetch();
    const inspected = await inspectQoderResponse(response);

    if (inspected.queued) {
      const queued = createQoderQueueRetryResponse({
        initialQueueInfo: inspected,
        model: `qoder/${qoderKey}`,
        signal,
        log,
        doFetch,
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

    const wrapped = wrapQoderSSE(response, `qoder/${qoderKey}`);
    return { response: wrapped, url, headers: currentAttemptRequest.headers, transformedBody: currentAttemptRequest.payload };
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
  normalizeMessages,
  validateQoderImageSupport,
  wrapQoderSSE,
  buildQoderRequestBody,
  createQoderQueueRetryResponse,
};

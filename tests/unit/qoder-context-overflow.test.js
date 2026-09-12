import { describe, expect, it, vi } from "vitest";

import QoderExecutor, { __test__ as qoderInternals } from "../../open-sse/executors/qoder.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const {
  inspectQoderResponse,
  classifyQoderEnvelopeError,
  formatQoderErrorMessage,
  wrapQoderSSE,
} = qoderInternals;

// Real shape captured on prod (2026-09-12): HTTP 200 + first SSE envelope
// carrying statusCodeValue 400 and a doubly-nested provider error.
const CONTEXT_ERROR_BODY = JSON.stringify({
  code: "provider_error",
  message: "Error in upstream response",
  request_id: "d57e6bc9-0a75-49b2-be97-6238b89ff096",
  type: "provider_error",
  details: JSON.stringify({
    error: {
      message:
        "<400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 999424]",
      type: "invalid_parameter_error",
    },
  }),
});

const HISTORY_ERROR_BODY = JSON.stringify({
  code: "provider_error",
  message: "Error in upstream response",
  type: "provider_error",
  details: JSON.stringify({
    error: {
      message:
        "An assistant message with 'tool_calls' must be followed by tool messages",
    },
  }),
});

function envelope(body, statusCodeValue = 200) {
  return `data: ${JSON.stringify({ statusCodeValue, body })}\n\n`;
}

function sseResponse(body) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Qoder upstream error envelopes", () => {
  it("digs the real provider message out of the nested body", () => {
    const info = classifyQoderEnvelopeError(400, CONTEXT_ERROR_BODY);
    expect(info.envelopeStatus).toBe(400);
    expect(info.status).toBe(400);
    expect(info.contextOverflow).toBe(true);
    expect(info.code).toBe("context_length_exceeded");
    expect(info.message).toContain("Range of input length should be [1, 999424]");
    expect(info.message).not.toContain("Error in upstream response");
  });

  it("flags non-length 400s as plain provider errors", () => {
    const info = classifyQoderEnvelopeError(400, HISTORY_ERROR_BODY);
    expect(info.contextOverflow).toBe(false);
    expect(info.code).toBe("provider_error");
    expect(info.message).toContain("must be followed by tool messages");
  });

  it("turns an overflow envelope into a real HTTP 400 instead of assistant text", async () => {
    const inspected = await inspectQoderResponse(
      sseResponse(envelope(CONTEXT_ERROR_BODY, 400)),
      { modelKey: "dfmodel" },
    );

    expect(inspected.queued).toBe(false);
    expect(inspected.errorInfo?.contextOverflow).toBe(true);
    expect(inspected.response.status).toBe(400);

    const payload = await inspected.response.json();
    expect(payload.error.code).toBe("context_length_exceeded");
    expect(payload.error.type).toBe("invalid_request_error");
    // Wording clients pattern-match on so they compact instead of retrying.
    expect(payload.error.message).toContain("qoder/dfmodel:");
    expect(payload.error.message).toContain("prompt is too long");
    expect(payload.error.message).toContain("reduce the length");
    expect(payload.error.message).toContain("Range of input length");
    // No self-referential nesting.
    expect(payload.error.message.match(/Upstream detail:/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("keeps the upstream detail for non-context envelope errors", async () => {
    const inspected = await inspectQoderResponse(
      sseResponse(envelope(HISTORY_ERROR_BODY, 400)),
      { modelKey: "dfmodel" },
    );
    expect(inspected.response.status).toBe(400);
    const payload = await inspected.response.json();
    expect(payload.error.code).toBe("provider_error");
    expect(payload.error.message).toContain("must be followed by tool messages");
  });

  it("logs the untruncated envelope body", async () => {
    const warn = vi.fn();
    await inspectQoderResponse(sseResponse(envelope(CONTEXT_ERROR_BODY, 400)), {
      log: { warn },
      modelKey: "dfmodel",
    });
    expect(warn).toHaveBeenCalled();
    const line = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toContain("context overflow");
    expect(line).toContain("Range of input length");
  });

  it("still treats 403 queued envelopes as retryable", async () => {
    const inspected = await inspectQoderResponse(
      sseResponse(
        envelope(JSON.stringify({ code: "10605", message: '{"isQueued":true,"queueCount":7}' }), 403),
      ),
      { modelKey: "dfmodel" },
    );
    expect(inspected.queued).toBe(true);
    expect(inspected.response).toBeNull();
  });

  it("still treats 504 first-token timeouts as retryable", async () => {
    const inspected = await inspectQoderResponse(
      sseResponse(envelope(JSON.stringify({ code: "504", message: "First Token Timeout or Upstream Timeout" }), 504)),
      { modelKey: "dfmodel" },
    );
    expect(inspected.queued).toBe(true);
    expect(inspected.reason).toContain("first token timeout");
  });

  it("passes healthy streams through untouched", async () => {
    const inspected = await inspectQoderResponse(
      sseResponse(
        envelope(JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "hi" } }] })) +
          envelope(JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })),
      ),
      { modelKey: "dfmodel" },
    );
    expect(inspected.queued).toBe(false);
    expect(inspected.errorInfo).toBeNull();
    expect(inspected.response.ok).toBe(true);
  });

  it("reports mid-stream envelope errors in-band but logs the full detail", async () => {
    const warn = vi.fn();
    const wrapped = wrapQoderSSE(
      sseResponse(
        envelope(JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "partial" } }] })) +
          envelope(CONTEXT_ERROR_BODY, 400),
      ),
      "qoder/dfmodel",
      { log: { warn } },
    );
    const text = await wrapped.text();
    expect(text).toContain("partial");
    expect(text).toContain("qoder error 400");
    expect(text).toContain("[DONE]");
    const line = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toContain("mid-stream envelope error 400");
    expect(line).toContain("Range of input length");
  });

  it("passes Qoder's own overflow wording through verbatim", () => {
    const upstream = JSON.stringify({
      code: "provider_error",
      message: "Error in upstream response",
      details: JSON.stringify({
        error: {
          message:
            "This model's maximum context length is 1048576 tokens. However, you requested 1148039 tokens (1100039 in the messages, 48000 in the completion). Please reduce the length of the messages or completion.",
          type: "invalid_request_error",
        },
      }),
    });
    const message = formatQoderErrorMessage(classifyQoderEnvelopeError(400, upstream), {
      modelKey: "dfmodel",
    });
    expect(message).toBe(
      "qoder/dfmodel: This model's maximum context length is 1048576 tokens. However, you requested 1148039 tokens (1100039 in the messages, 48000 in the completion). Please reduce the length of the messages or completion.",
    );
  });

  it("decodes HTTP-level Qoder errors through executor.parseError", () => {
    const executor = new QoderExecutor();
    const response = new Response(CONTEXT_ERROR_BODY, { status: 400 });
    const parsed = executor.parseError(response, CONTEXT_ERROR_BODY);
    expect(parsed.status).toBe(400);
    expect(parsed.message).toContain("maximum context length");
    expect(parsed.message).toContain("Range of input length");
  });

  it("does not double-wrap an error body we produced ourselves", () => {
    const executor = new QoderExecutor();
    const own = JSON.stringify({
      error: {
        message: "qoder/dfmodel: This model's maximum context length is 1048576 tokens. Please reduce the length of the messages or completion.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
      },
    });
    const parsed = executor.parseError(new Response(own, { status: 400 }), own);
    expect(parsed.message).not.toContain("Upstream detail:");
    expect(parsed.message.startsWith("qoder/dfmodel: This model's maximum context length")).toBe(true);
  });
});

describe("account fallback classification", () => {
  it("does not rotate accounts when the payload is over the context limit", () => {
    const message = formatQoderErrorMessage(
      classifyQoderEnvelopeError(400, CONTEXT_ERROR_BODY),
      { modelKey: "dfmodel", maxInputTokens: 1000000 },
    );
    const result = checkFallbackError(400, message);
    expect(result.shouldFallback).toBe(false);
    expect(result.cooldownMs).toBe(0);
  });

  it("does not rotate accounts for any other 400 either", () => {
    expect(checkFallbackError(400, "qoder upstream error 400: invalid history").shouldFallback).toBe(false);
  });

  it("still rotates on rate limits and transient upstream failures", () => {
    expect(checkFallbackError(429, "rate limit exceeded").shouldFallback).toBe(true);
    expect(checkFallbackError(500, "boom").shouldFallback).toBe(true);
    expect(checkFallbackError(403, "no credentials left").shouldFallback).toBe(true);
  });

  it("still honours the qoder queue backoff rule", () => {
    const result = checkFallbackError(403, '{"isQueued":true,"queueCount":12}');
    expect(result.shouldFallback).toBe(true);
    expect(result.newBackoffLevel).toBe(1);
  });
});

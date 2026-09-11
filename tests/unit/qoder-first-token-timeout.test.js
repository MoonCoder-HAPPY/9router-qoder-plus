import { describe, expect, it } from "vitest";

import { __test__ as qoderInternals } from "../../open-sse/executors/qoder.js";

function envelope(body, statusCodeValue = 200) {
  return `data: ${JSON.stringify({
    statusCodeValue,
    body: JSON.stringify(body),
  })}\n\n`;
}

function firstTokenTimeoutStreamResponse() {
  return new Response(
    envelope(
      { code: "504", message: "First Token Timeout or Upstream Timeout" },
      504,
    ),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function firstTokenTimeoutHttpResponse() {
  return new Response(
    JSON.stringify({ code: "504", message: "First Token Timeout or Upstream Timeout" }),
    { status: 504, headers: { "content-type": "application/json" } },
  );
}

function legacyTimeoutStreamResponse() {
  return new Response(
    envelope({ code: "504", message: "upstream model timeout" }, 504),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function completedResponse(content = "timeout recovered") {
  return new Response(
    envelope({
      id: "chatcmpl-timeout-test",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    }) +
      envelope({
        id: "chatcmpl-timeout-test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("Qoder first-token timeout handling", () => {
  it("treats the new 504 wording inside an SSE stream as retryable", async () => {
    const inspected = await qoderInternals.inspectQoderResponse(firstTokenTimeoutStreamResponse());
    expect(inspected.queued).toBe(true);
    expect(inspected.reason).toContain("first token timeout");
    expect(inspected.response).toBeNull();
  });

  it("treats an HTTP 504 with the new wording as retryable", async () => {
    const inspected = await qoderInternals.inspectQoderResponse(firstTokenTimeoutHttpResponse());
    expect(inspected.queued).toBe(true);
    expect(inspected.reason).toContain("first token timeout");
    expect(inspected.response).toBeNull();
  });

  it("keeps the legacy upstream model timeout wording retryable", async () => {
    const inspected = await qoderInternals.inspectQoderResponse(legacyTimeoutStreamResponse());
    expect(inspected.queued).toBe(true);
    expect(inspected.reason).toContain("upstream model timeout");
  });

  it("retries a first-token timeout on the keep-alive stream and then streams the result", async () => {
    let calls = 0;
    const response = await qoderInternals.createQoderQueueRetryResponse({
      initialQueueInfo: { queued: true, reason: "first token timeout", queueCount: null, source: "stream" },
      model: "qoder/qmodel_38max",
      signal: new AbortController().signal,
      log: { info() {} },
      doFetch: async () => {
        calls++;
        return calls === 1 ? firstTokenTimeoutStreamResponse() : completedResponse();
      },
      retryOptions: { maxAttempts: 15, baseDelayMs: 5000, maxDelayMs: 60000 },
      timeoutRetryOptions: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      keepaliveMs: 5,
      sleepFn: async () => {},
    });

    const text = await response.text();

    expect(calls).toBe(2);
    expect(text).toContain(": qoder queue keepalive");
    expect(text).toContain('"content":"timeout recovered"');
    expect(text).toContain("data: [DONE]");
    expect(text).not.toContain("[qoder error");
  });

  it("uses the smaller timeout budget and stops after it is exhausted", async () => {
    let calls = 0;
    const response = await qoderInternals.createQoderQueueRetryResponse({
      initialQueueInfo: { queued: true, reason: "first token timeout", queueCount: null, source: "stream" },
      model: "qoder/qmodel_38max",
      signal: new AbortController().signal,
      log: { info() {} },
      doFetch: async () => {
        calls++;
        return firstTokenTimeoutStreamResponse();
      },
      retryOptions: { maxAttempts: 15, baseDelayMs: 5000, maxDelayMs: 60000 },
      timeoutRetryOptions: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      keepaliveMs: 5,
      sleepFn: async () => {},
    });

    const text = await response.text();

    expect(calls).toBe(2);
    expect(text).toContain("[qoder error");
    expect(text).toContain("timeout retry limit reached");
    expect(text).toContain("data: [DONE]");
  });
});

import { describe, expect, it } from "vitest";

import { __test__ as qoderInternals } from "../../open-sse/executors/qoder.js";

function envelope(body, statusCodeValue = 200) {
  return `data: ${JSON.stringify({
    statusCodeValue,
    body: JSON.stringify(body),
  })}\n\n`;
}

function queuedResponse(position) {
  return new Response(
    envelope(
      {
        code: 403,
        message: JSON.stringify({
          isQueued: true,
          queueType: "slow",
          queueCount: position,
        }),
      },
      403,
    ),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function completedResponse() {
  return new Response(
    envelope({
      id: "chatcmpl-queue-test",
      choices: [
        {
          index: 0,
          delta: { content: "queue recovered" },
          finish_reason: null,
        },
      ],
    }) +
      envelope({
        id: "chatcmpl-queue-test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

describe("Qoder queue-aware streaming", () => {
  it("returns an SSE response immediately and keeps it alive while retrying", async () => {
    let calls = 0;
    const response = await qoderInternals.createQoderQueueRetryResponse({
      initialQueueInfo: { queued: true, queueCount: 42 },
      model: "qoder/qfmodel",
      signal: new AbortController().signal,
      log: { info() {} },
      doFetch: async () => {
        calls++;
        return calls === 1 ? queuedResponse(12) : completedResponse();
      },
      retryOptions: {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
      },
      keepaliveMs: 5,
      sleepFn: async () => {},
    });

    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(calls).toBe(2);
    expect(text).toContain(": qoder queue keepalive");
    expect(text).toContain('"content":"queue recovered"');
    expect(text).toContain("data: [DONE]");
  });

  it("emits a terminal error after the queue retry budget is exhausted", async () => {
    const response = await qoderInternals.createQoderQueueRetryResponse({
      initialQueueInfo: { queued: true, queueCount: 50 },
      model: "qoder/qfmodel",
      signal: new AbortController().signal,
      log: { info() {} },
      doFetch: async () => queuedResponse(40),
      retryOptions: {
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
      },
      keepaliveMs: 5,
      sleepFn: async () => {},
    });

    const text = await response.text();

    expect(text).toContain("[qoder error");
    expect(text).toContain("queue retry limit reached");
    expect(text).toContain("data: [DONE]");
  });
});

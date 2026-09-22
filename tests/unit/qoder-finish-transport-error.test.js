import { describe, expect, it } from "vitest";

import { __test__ as qoderInternals } from "../../open-sse/executors/qoder.js";

const { wrapQoderSSE } = qoderInternals;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const envelope = (inner) => `data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}\n\n`;
const chunk = (finishReason = null) => JSON.stringify({
  id: "chatcmpl-finish-transport-error",
  choices: [{ index: 0, delta: { content: "partial" }, finish_reason: finishReason }],
});
const errorChunk = () => JSON.stringify({
  error: { type: "server_error", code: "stream_disconnected", message: "socket closed" },
});

function socketClosedError() {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });
}

async function drain(response) {
  const reader = response.body.getReader();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  return output;
}

describe("Qoder finish transport termination", () => {
  it.each([
    ["outer", "data: [DONE]\\n\\n"],
    ["inner", envelope("[DONE]")],
  ])("rejects an early %s [DONE] without a terminal chunk", async (_kind, doneLine) => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(envelope(chunk(null))));
        controller.enqueue(encoder.encode(doneLine));
        controller.close();
      },
    }), { status: 200 });

    const output = await drain(wrapQoderSSE(response, "qoder/dfmodel", { keepaliveMs: 60000 }));

    expect(output).toContain('"code":"stream_disconnected"');
    expect(output).not.toContain('"finish_reason":"stop"');
    expect(output).toContain("data: [DONE]");
  });

  it("does not turn a socket close after finish_reason into a successful turn", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(envelope(chunk(null))));
        controller.enqueue(encoder.encode(envelope(chunk("stop"))));
        queueMicrotask(() => controller.error(socketClosedError()));
      },
    }), { status: 200 });

    const output = await drain(wrapQoderSSE(response, "qoder/dfmodel", { keepaliveMs: 60000 }));

    expect(output).toContain('"code":"stream_disconnected"');
    expect(output).not.toContain('"finish_reason":"stop"');
    expect(output).toContain("data: [DONE]");
  });

  it("keeps a normal EOF after finish_reason as a successful completion", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(envelope(chunk(null))));
        controller.enqueue(encoder.encode(envelope(chunk("stop"))));
        controller.close();
      },
    }), { status: 200 });

    const output = await drain(wrapQoderSSE(response, "qoder/dfmodel", { keepaliveMs: 60000 }));

    expect(output).toContain('"finish_reason":"stop"');
    expect(output).toContain("data: [DONE]");
    expect(output).not.toContain('"code":"stream_disconnected"');
  });

  it("turns an upstream AbortError into a structured failure", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(envelope(chunk(null))));
        queueMicrotask(() => controller.error(new DOMException("The operation was aborted", "AbortError")));
      },
    }), { status: 200 });

    const output = await drain(wrapQoderSSE(response, "qoder/dfmodel", { keepaliveMs: 60000 }));

    expect(output).toContain('"code":"stream_disconnected"');
    expect(output).toContain("data: [DONE]");
  });

  it("does not treat an internal stall abort as a client cancellation", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(envelope(chunk(null))));
        queueMicrotask(() => controller.error(new DOMException("The operation was aborted", "AbortError")));
      },
    }), { status: 200 });
    const stallController = new AbortController();
    const wrapped = wrapQoderSSE(response, "qoder/dfmodel", {
      signal: stallController.signal,
      keepaliveMs: 60000,
    });
    stallController.abort(new Error("stream stall timeout"));

    const output = await drain(wrapped);

    expect(output).toContain('"code":"stream_disconnected"');
    expect(output).toContain("data: [DONE]");
  });

  it("does not release a held finish frame after a structured error", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(envelope(chunk("stop"))));
        controller.enqueue(encoder.encode(envelope(errorChunk())));
        controller.close();
      },
    }), { status: 200 });

    const output = await drain(wrapQoderSSE(response, "qoder/dfmodel", { keepaliveMs: 60000 }));

    expect(output).toContain('"code":"stream_disconnected"');
    expect(output).not.toContain('"finish_reason":"stop"');
    expect(output).toContain("data: [DONE]");
  });

  it("does not auto-continue after an inner error frame", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(envelope(JSON.stringify({
          id: "chatcmpl-error-dangling",
          choices: [{
            index: 0,
            delta: { content: "Let me inspect this:" },
            finish_reason: null,
          }],
        }))));
        controller.enqueue(encoder.encode(envelope(JSON.stringify({
          error: {
            type: "server_error",
            code: "stream_disconnected",
            message: "socket closed",
          },
        }))));
        controller.close();
      },
    }), { status: 200 });

    let continuationCalls = 0;
    const output = await drain(wrapQoderSSE(response, "qoder/dfmodel", {
      keepaliveMs: 60000,
      hasTools: true,
      maxContinuations: 1,
      continueFetch: async () => {
        continuationCalls += 1;
        return null;
      },
    }));

    expect(continuationCalls).toBe(0);
    expect(output).toContain('"code":"stream_disconnected"');
    expect(output).toContain("data: [DONE]");
  });
});

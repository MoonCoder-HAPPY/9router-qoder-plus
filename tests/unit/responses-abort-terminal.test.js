import { describe, expect, it, vi } from "vitest";

import { createDisconnectAwareStream, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { buildAbortedResponsesTerminalBytes, buildContextOverflowResponsesFrame } from "../../open-sse/utils/responsesStreamHelpers.js";

// Minimal stream controller stub
function makeController() {
  let connected = true;
  return {
    signal: new AbortController().signal,
    startTime: Date.now(),
    isConnected: () => connected,
    handleComplete: () => { connected = false; },
    handleError: () => { connected = false; },
    handleDisconnect: () => { connected = false; },
    abort: () => { connected = false; },
  };
}

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

describe("Responses abort terminal synthesis", () => {
  it("emits response.failed + [DONE] when upstream errors (abort/stall)", async () => {
    // Upstream readable that errors mid-stream (simulates fetch abort on stall)
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: response.created\ndata: {}\n\n"));
        controller.error(new Error("stream stall timeout"));
      },
    });

    const out = createDisconnectAwareStream(
      { readable: upstream, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      makeController(),
      buildAbortedResponsesTerminalBytes
    );

    const text = await readAll(out);
    expect(text).toContain("event: response.failed");
    expect(text).toContain("data: [DONE]");
  });

  it("does not synthesize terminal for non-Responses streams (callback null)", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
        controller.error(new Error("socket hang up"));
      },
    });

    const out = createDisconnectAwareStream(
      { readable: upstream, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      makeController(),
      null
    );

    const text = await readAll(out);
    expect(text).not.toContain("response.failed");
    expect(text).not.toContain("[DONE]");
  });

  it("does not append response.failed after a completed Responses terminal", async () => {
    let delivered = false;
    const upstream = new ReadableStream({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(new TextEncoder().encode(
            "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
          ));
          return;
        }
        const error = new Error("socket closed after terminal");
        error.code = "UND_ERR_SOCKET";
        controller.error(error);
      },
    });

    const out = createDisconnectAwareStream(
      {
        readable: upstream,
        writable: { getWriter: () => ({ abort: () => Promise.resolve() }) },
        hasTerminal: () => true,
      },
      makeController(),
      buildAbortedResponsesTerminalBytes,
    );

    const text = await readAll(out);
    expect(text).not.toContain("response.failed");
    expect(text).not.toContain("data: [DONE]");
  });

  it("ignores an unknown late error after a completed terminal", async () => {
    let delivered = false;
    const upstream = new ReadableStream({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(new TextEncoder().encode(
            "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
          ));
          return;
        }
        controller.error(new Error("late parser failure"));
      },
    });

    const out = createDisconnectAwareStream(
      {
        readable: upstream,
        writable: { getWriter: () => ({ abort: () => Promise.resolve() }) },
        hasTerminal: () => true,
      },
      makeController(),
      buildAbortedResponsesTerminalBytes,
    );

    const text = await readAll(out);
    expect(text).not.toContain("response.failed");
    expect(text).not.toContain("data: [DONE]");
  });

  it("protects native passthrough after a completed Responses terminal", async () => {
    let delivered = false;
    const upstream = new ReadableStream({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(new TextEncoder().encode(
            "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
          ));
          return;
        }
        const error = new Error("socket closed after terminal");
        error.code = "UND_ERR_SOCKET";
        controller.error(error);
      },
    });
    const onStreamComplete = vi.fn();
    const transform = createPassthroughStreamWithLogger("codex", null, "gpt-5.5", null, null, onStreamComplete);
    const out = pipeWithDisconnect(
      new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
      transform,
      makeController(),
      buildAbortedResponsesTerminalBytes,
      60000,
    );

    const text = await readAll(out);
    expect(text).toContain("response.completed");
    expect(text).not.toContain("response.failed");
    expect(text).not.toContain("data: [DONE]");
    expect(onStreamComplete.mock.calls[0][3]).toEqual({ completed: true });
  });

  it("protects translated Responses streams after a completed terminal", async () => {
    let delivered = false;
    const upstream = new ReadableStream({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(new TextEncoder().encode(
            "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
          ));
          return;
        }
        const error = new Error("socket closed after terminal");
        error.code = "UND_ERR_SOCKET";
        controller.error(error);
      },
    });
    const onStreamComplete = vi.fn();
    const transform = createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI_RESPONSES,
      "qoder",
      null,
      null,
      "gpt-5.5",
      null,
      null,
      onStreamComplete,
    );
    const out = pipeWithDisconnect(
      new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
      transform,
      makeController(),
      buildAbortedResponsesTerminalBytes,
      60000,
    );

    const text = await readAll(out);
    expect(text).toContain("response.completed");
    expect(text).not.toContain("response.failed");
    expect(text).not.toContain("data: [DONE]");
    expect(onStreamComplete.mock.calls[0][3]).toEqual({ completed: true });
  });
});

describe("context overflow frame for Responses clients", () => {
  it("carries the exact code and event Codex matches on", () => {
    // codex-api/src/sse/responses.rs only recognises context_length_exceeded
    // inside a response.failed event; as an HTTP 400 JSON body the same error
    // maps to a generic InvalidRequest that is explicitly not retryable, so the
    // turn dies instead of auto-compacting. This frame is what makes the client
    // shrink its own context and retry.
    const frame = buildContextOverflowResponsesFrame("qoder/dfmodel: maximum context length exceeded (estimated 912345 tokens, limit 900000).");
    expect(frame).toContain("event: response.failed");
    const payload = JSON.parse(frame.split("data: ")[1].trim());
    expect(payload.type).toBe("response.failed");
    expect(payload.response.status).toBe("failed");
    expect(payload.response.error.code).toBe("context_length_exceeded");
    expect(payload.response.error.message).toContain("maximum context length");
  });

  it("carries no assistant content, so a compaction trigger cannot pollute history", () => {
    const frame = buildContextOverflowResponsesFrame("too long");
    expect(frame).not.toContain("output_text");
    expect(frame).not.toContain("output_item");
    expect(frame).not.toContain("summary_text");
  });
});

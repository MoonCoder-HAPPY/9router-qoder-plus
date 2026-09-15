import { describe, expect, it } from "vitest";

import { createDisconnectAwareStream } from "../../open-sse/utils/streamHandler.js";
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

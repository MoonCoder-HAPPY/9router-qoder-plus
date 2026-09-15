import { describe, expect, it, vi } from "vitest";

import { __test__ as qoderInternals } from "../../open-sse/executors/qoder.js";

const { wrapQoderSSE } = qoderInternals;

const enc = new TextEncoder();
const envelope = (inner) => `data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}\n\n`;
const chunk = (delta, finishReason = null) => JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] });

describe("Codex observability signals", () => {
  it("emits a greppable stream summary with reasoning event and continuation counts", async () => {
    const lines = [];
    const log = { info: (tag, message) => lines.push(`${tag} ${message}`), warn: () => {} };
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(envelope(chunk({ reasoning_content: "think 1" }))));
          controller.enqueue(enc.encode(envelope(chunk({ reasoning_content: "think 2" }))));
          controller.enqueue(enc.encode(envelope(chunk({ content: "answer" }))));
          controller.enqueue(enc.encode(envelope(chunk({}, "stop"))));
          controller.enqueue(enc.encode(envelope("[DONE]")));
          controller.close();
        },
      }),
      { status: 200 },
    );

    const wrapped = wrapQoderSSE(upstream, "qoder/dfmodel", { log });
    const reader = wrapped.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    const summary = lines.find((line) => line.includes("stream_done"));
    expect(summary, `expected a stream_done line, got: ${lines.join(" | ")}`).toBeTruthy();
    expect(summary.startsWith("[CODEX]")).toBe(true);
    expect(summary).toContain("reasoning_events=2");
    expect(summary).toContain("continuations=0");
  });
it("fills the shared metrics object the request detail is built from", async () => {
    const metrics = {};
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(envelope(chunk({ reasoning_content: "r1" }))));
          controller.enqueue(enc.encode(envelope(chunk({ content: "a" }))));
          controller.enqueue(enc.encode(envelope(chunk({}, "stop"))));
          controller.enqueue(enc.encode(envelope("[DONE]")));
          controller.close();
        },
      }),
      { status: 200 },
    );

    const wrapped = wrapQoderSSE(upstream, "qoder/dfmodel", { metrics });
    const reader = wrapped.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    expect(metrics.reasoningEvents).toBe(1);
    expect(metrics.continuations).toBeUndefined();
  });
});
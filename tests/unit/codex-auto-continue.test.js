import { describe, expect, it, vi } from "vitest";

import { __test__ as qoderInternals } from "../../open-sse/executors/qoder.js";

const { wrapQoderSSE, createQoderQueueRetryResponse } = qoderInternals;

const enc = new TextEncoder();
const envelope = (inner) => `data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}\n\n`;
const chunk = (delta, finishReason = null) =>
  JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] });

/** Upstream turn that announces the next step and stops without a tool call. */
const danglingTurn = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(envelope(chunk({ content: "Let me check the parser:" }))));
        controller.enqueue(enc.encode(envelope(chunk({}, "stop"))));
        controller.enqueue(enc.encode(envelope("[DONE]")));
        controller.close();
      },
    }),
    { status: 200 },
  );

/** The continuation answers with the tool call the model announced. */
const continuationTurn = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          enc.encode(
            `data: ${chunk({
              tool_calls: [
                { index: 0, id: "call_cont", type: "function", function: { name: "exec_command", arguments: '{"cmd":"ls"}' } },
              ],
            })}\n\n`,
          ),
        );
        controller.enqueue(enc.encode(`data: ${chunk({}, "tool_calls")}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status: 200 },
  );

async function drain(response) {
  const reader = response.body.getReader();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  return out;
}

describe("auto-continue budget from settings", () => {
  it("does not continue when the configured budget is zero", async () => {
    const continueFetch = vi.fn(async () => continuationTurn());
    const out = await drain(
      wrapQoderSSE(danglingTurn(), "qoder/dfmodel", { continueFetch, hasTools: true, maxContinuations: 0 }),
    );
    expect(continueFetch).not.toHaveBeenCalled();
    expect(out).not.toContain("call_cont");
  });

  it("continues once when the budget allows it", async () => {
    const continueFetch = vi.fn(async () => continuationTurn());
    const out = await drain(
      wrapQoderSSE(danglingTurn(), "qoder/dfmodel", { continueFetch, hasTools: true, maxContinuations: 1 }),
    );
    expect(continueFetch).toHaveBeenCalledTimes(1);
    expect(out).toContain("call_cont");
    expect(out).toContain("exec_command");
  });

  it("still ignores requests without tools", async () => {
    const continueFetch = vi.fn(async () => continuationTurn());
    await drain(wrapQoderSSE(danglingTurn(), "qoder/dfmodel", { continueFetch, hasTools: false, maxContinuations: 1 }));
    expect(continueFetch).not.toHaveBeenCalled();
  });
});

describe("auto-continue on the post-queue path", () => {
  it("continues a dangling turn that arrived after a queued retry", async () => {
    const doFetch = vi.fn(async () => danglingTurn());
    const continueFetch = vi.fn(async () => continuationTurn());
    const response = createQoderQueueRetryResponse({
      initialQueueInfo: { queued: true, queueCount: 0, reason: null, source: "http" },
      model: "qoder/dfmodel",
      signal: null,
      log: null,
      doFetch,
      keepaliveMs: 60000,
      sleepFn: async () => {},
      continueFetch,
      hasTools: true,
      maxContinuations: 1,
    });
    const out = await drain(response);
    expect(doFetch).toHaveBeenCalled();
    expect(continueFetch).toHaveBeenCalledTimes(1);
    expect(out).toContain("call_cont");
  });

  it("keeps the old behaviour when no continuation handler is wired", async () => {
    const doFetch = vi.fn(async () => danglingTurn());
    const response = createQoderQueueRetryResponse({
      initialQueueInfo: { queued: true, queueCount: 0, reason: null, source: "http" },
      model: "qoder/dfmodel",
      signal: null,
      log: null,
      doFetch,
      keepaliveMs: 60000,
      sleepFn: async () => {},
    });
    const out = await drain(response);
    expect(out).toContain("Let me check the parser:");
    expect(out).toContain("[DONE]");
  });
});
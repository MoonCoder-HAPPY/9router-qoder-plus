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

  it("holds the first turn's finish_reason back until continuation is ruled out", async () => {
    // Codex ends the turn - and aborts the request it is reading - the instant it
    // sees a finish_reason. Letting the first turn's `stop` through before asking
    // upstream for the rest is what made the continuation die with "This operation
    // was aborted" and left answers truncated mid-sentence.
    let framesSeen = 0;
    let framesAtContinueStart = null;
    const continueFetch = vi.fn(async () => {
      framesAtContinueStart = framesSeen;
      return continuationTurn();
    });
    const wrapped = wrapQoderSSE(danglingTurn(), "qoder/dfmodel", { continueFetch, hasTools: true, maxContinuations: 1 });
    const reader = wrapped.body.getReader();
    const dec = new TextDecoder();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
      framesSeen = (out.match(/finish_reason":\s*"stop"/g) || []).length;
    }
    // The first turn's terminal frame was withheld until the continuation began.
    expect(continueFetch).toHaveBeenCalledTimes(1);
    expect(framesAtContinueStart).toBe(0);
    // The spliced continuation is what the client ends up seeing.
    expect(out).toContain("call_cont");
    expect(out).toContain("tool_calls");
    expect(out).not.toMatch(/finish_reason":\s*"stop"/);
  });

  it("still emits the terminal frame when the turn is a real answer", async () => {
    // A completed answer must end exactly as before: nothing is withheld when no
    // continuation applies, so the client closes the turn normally.
    const finishTurn = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode(envelope(chunk({ content: "All done. Here is the summary." }))));
            controller.enqueue(enc.encode(envelope(chunk({}, "stop"))));
            controller.enqueue(enc.encode(envelope("[DONE]")));
            controller.close();
          },
        }),
        { status: 200 },
      );
    const continueFetch = vi.fn(async () => continuationTurn());
    const out = await drain(wrapQoderSSE(finishTurn(), "qoder/dfmodel", { continueFetch, hasTools: true, maxContinuations: 1 }));
    expect(continueFetch).not.toHaveBeenCalled();
    expect(out).toMatch(/finish_reason":\s*"stop"/);
    expect(out).toContain("[DONE]");
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
import { describe, expect, it } from "vitest";

import { __test__ as qoderInternals } from "../../open-sse/executors/qoder.js";

const { wrapQoderSSE, looksLikeDanglingIntent } = qoderInternals;

function qoderEnvelope(inner) {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}\n\n`;
}

function chunk(delta, finishReason = null) {
  return JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] });
}

function danglingStream(text) {
  return new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(qoderEnvelope(chunk({ content: text }))));
        controller.enqueue(enc.encode(qoderEnvelope(chunk({}, "stop"))));
        controller.enqueue(enc.encode(qoderEnvelope("[DONE]")));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function continuationStreamWithToolCall() {
  return new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: ${chunk({ tool_calls: [{ index: 0, id: "call_cont", type: "function", function: { name: "exec_command", arguments: '{"cmd":"ls"}' } }] })}\n\n`));
        controller.enqueue(enc.encode(`data: ${chunk({}, "tool_calls")}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

async function drain(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("looksLikeDanglingIntent", () => {
  it("matches colon endings and intent verbs", () => {
    expect(looksLikeDanglingIntent("先看一下老生产 Cassandra 上这两个 keyspace 的表结构：")).toBe(true);
    expect(looksLikeDanglingIntent("我核对一下它和两个项目的 git 归属。")).toBe(true);
    expect(looksLikeDanglingIntent("Let me read the config file.")).toBe(true);
  });

  it("does not match normal final answers", () => {
    expect(looksLikeDanglingIntent("修改已完成，测试通过。")).toBe(false);
    expect(looksLikeDanglingIntent("Let me know if you need anything else.")).toBe(false);
    expect(looksLikeDanglingIntent("")).toBe(false);
    expect(looksLikeDanglingIntent("x".repeat(700))).toBe(false);
  });
});

describe("wrapQoderSSE auto-continue", () => {
  it("splices a continuation stream when the turn ends dangling without a tool call", async () => {
    let calls = 0;
    const wrapped = wrapQoderSSE(danglingStream("先看一下表结构："), "qoder/dfmodel", {
      hasTools: true,
      maxContinuations: 1,
      keepaliveMs: 1000,
      continueFetch: async (danglingText) => {
        calls++;
        expect(danglingText).toContain("先看一下表结构：");
        // continueFetch returns an already-unwrapped OpenAI SSE stream
        return continuationStreamWithToolCall();
      },
    });

    const out = await drain(wrapped);

    expect(calls).toBe(1);
    expect(out).toContain('"content":"先看一下表结构："');
    expect(out).toContain('"name":"exec_command"');
    expect(out.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("does not continue when the ending is a normal final answer", async () => {
    let calls = 0;
    const wrapped = wrapQoderSSE(danglingStream("修改已完成，测试通过。"), "qoder/dfmodel", {
      hasTools: true,
      maxContinuations: 1,
      keepaliveMs: 1000,
      continueFetch: async () => {
        calls++;
        return continuationStreamWithToolCall();
      },
    });

    const out = await drain(wrapped);

    expect(calls).toBe(0);
    expect(out).toContain('"content":"修改已完成，测试通过。"');
    expect(out.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("does not continue when the request carries no tools", async () => {
    let calls = 0;
    const wrapped = wrapQoderSSE(danglingStream("先看一下表结构："), "qoder/dfmodel", {
      hasTools: false,
      maxContinuations: 1,
      keepaliveMs: 1000,
      continueFetch: async () => {
        calls++;
        return continuationStreamWithToolCall();
      },
    });

    await drain(wrapped);
    expect(calls).toBe(0);
  });

  it("does not continue when the turn already emitted a tool call", async () => {
    let calls = 0;
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(qoderEnvelope(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec_command", arguments: "{}" } }] }))));
          controller.enqueue(enc.encode(qoderEnvelope(chunk({}, "tool_calls"))));
          controller.enqueue(enc.encode(qoderEnvelope("[DONE]")));
          controller.close();
        },
      }),
      { status: 200 },
    );
    const wrapped = wrapQoderSSE(upstream, "qoder/dfmodel", {
      hasTools: true,
      maxContinuations: 1,
      keepaliveMs: 1000,
      continueFetch: async () => {
        calls++;
        return continuationStreamWithToolCall();
      },
    });

    await drain(wrapped);
    expect(calls).toBe(0);
  });
});

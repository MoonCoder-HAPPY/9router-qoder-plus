import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
}));

import {
  createPassthroughStreamWithLogger,
  createSSETransformStreamWithLogger,
} from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

async function transform(raw, stream) {
  const output = new Response(new Response(raw).body.pipeThrough(stream));
  return output.text();
}

const chatChunk = (finishReason = null) => JSON.stringify({
  id: "chatcmpl-terminal-framing",
  choices: [{ index: 0, delta: { content: "done" }, finish_reason: finishReason }],
});

describe("SSE terminal framing", () => {
  it("does not duplicate [DONE] in OpenAI passthrough mode", async () => {
    const output = await transform(
      `data: ${chatChunk("stop")}\n\ndata: [DONE]\n\n`,
      createPassthroughStreamWithLogger("qoder", null, "dfmodel"),
    );

    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("emits a structured failure before an early passthrough [DONE]", async () => {
    const onStreamComplete = vi.fn();
    const output = await transform(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\ndata: [DONE]\n\n`,
      createPassthroughStreamWithLogger("qoder", null, "dfmodel", null, null, onStreamComplete),
    );

    expect(output).toContain('"code":"stream_disconnected"');
    expect(output).toContain("data: [DONE]");
    expect(onStreamComplete.mock.calls[0][3]).toEqual({ completed: false });
  });

  it("marks an OpenAI passthrough error as incomplete", async () => {
    const onStreamComplete = vi.fn();
    const output = await transform(
      `data: ${JSON.stringify({ error: { code: "server_is_overloaded", message: "socket closed" } })}\n\ndata: [DONE]\n\n`,
      createPassthroughStreamWithLogger("qoder", null, "dfmodel", null, null, onStreamComplete),
    );

    expect(output).toContain('"code":"server_is_overloaded"');
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
    expect(onStreamComplete.mock.calls[0][3]).toEqual({ completed: false });
  });

  it("writes a failed final request status even when partial usage exists", async () => {
    const onStreamComplete = vi.fn();
    const appendRequestLog = (await import("@/lib/usageDb.js")).appendRequestLog;
    appendRequestLog.mockClear();
    await transform(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }], usage: { prompt_tokens: 8, completion_tokens: 2 } })}`,
        `data: ${JSON.stringify({ error: { code: "stream_disconnected", message: "socket closed" } })}`,
        "",
      ].join("\n"),
      createPassthroughStreamWithLogger("qoder", null, "dfmodel", null, null, onStreamComplete),
    );

    expect(appendRequestLog).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED 502" }));
  });

  it("terminates the OpenAI-to-Responses translation with [DONE]", async () => {
    const output = await transform(
      `data: ${chatChunk(null)}\n\ndata: ${chatChunk("stop")}\n\ndata: [DONE]\n\n`,
      createSSETransformStreamWithLogger(
        FORMATS.OPENAI,
        FORMATS.OPENAI_RESPONSES,
        "qoder",
        null,
        null,
        "dfmodel",
      ),
    );

    expect(output).toContain("response.completed");
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("records an OpenAI-to-Responses normal terminal as completed", async () => {
    const onStreamComplete = vi.fn();
    await transform(
      `data: ${chatChunk("stop")}\n\n`,
      createSSETransformStreamWithLogger(
        FORMATS.OPENAI,
        FORMATS.OPENAI_RESPONSES,
        "qoder",
        null,
        null,
        "dfmodel",
        null,
        { messages: [{ role: "user", content: "test" }] },
        onStreamComplete,
      ),
    );

    expect(onStreamComplete).toHaveBeenCalledTimes(1);
    expect(onStreamComplete.mock.calls[0][3]).toEqual({ completed: true });
  });

  it("turns an OpenAI EOF without finish_reason into response.failed", async () => {
    const onStreamComplete = vi.fn();
    const output = await transform(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`,
      createSSETransformStreamWithLogger(
        FORMATS.OPENAI,
        FORMATS.OPENAI_RESPONSES,
        "qoder",
        null,
        null,
        "dfmodel",
        null,
        { messages: [{ role: "user", content: "test" }] },
        onStreamComplete,
      ),
    );

    expect(output).toContain("response.failed");
    expect(output).not.toContain("response.completed");
    expect(onStreamComplete.mock.calls[0][3]).toEqual({ completed: false });
  });

  it("recognizes a valid Responses terminal in passthrough mode", async () => {
    const onStreamComplete = vi.fn();
    const output = await transform(
      [
        "event: response.completed",
        `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      createPassthroughStreamWithLogger("codex", null, "gpt-5.5", null, null, onStreamComplete),
    );

    expect(output).not.toContain("stream_disconnected");
    expect(onStreamComplete.mock.calls[0][3]).toEqual({ completed: true });
  });

  it("parses a Responses event frame left in the flush buffer", async () => {
    const onStreamComplete = vi.fn();
    const output = await transform(
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { status: "completed" },
      })}`,
      createSSETransformStreamWithLogger(
        FORMATS.OPENAI_RESPONSES,
        FORMATS.OPENAI_RESPONSES,
        "qoder",
        null,
        null,
        "dfmodel",
        null,
        { input: [{ role: "user", content: "test" }] },
        onStreamComplete,
      ),
    );

    expect(output).toContain("event: response.completed");
    expect(output).not.toContain("event: response.failed");
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(onStreamComplete.mock.calls[0][3]).toEqual({ completed: true });
  });

  it("marks a structured stream error as incomplete instead of successful", async () => {
    const onStreamComplete = vi.fn();
    const output = await transform(
      `data: ${JSON.stringify({ error: { code: "stream_disconnected", message: "socket closed" } })}\n\ndata: [DONE]\n\n`,
      createSSETransformStreamWithLogger(
        FORMATS.OPENAI,
        FORMATS.OPENAI_RESPONSES,
        "qoder",
        null,
        null,
        "dfmodel",
        null,
        { messages: [{ role: "user", content: "test" }] },
        onStreamComplete,
      ),
    );

    expect(output).toContain("response.failed");
    expect(output).not.toContain("response.completed");
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
    expect(onStreamComplete.mock.calls[0][3]).toEqual({ completed: false });
  });

  it("marks a plain OpenAI EOF without finish_reason as incomplete", async () => {
    const onStreamComplete = vi.fn();
    const output = await transform(
      `data: ${JSON.stringify({ id: "chatcmpl-truncated", choices: [{ delta: { content: "partial" } }] })}\n\n`,
      createPassthroughStreamWithLogger("qoder", null, "dfmodel", null, null, onStreamComplete),
    );

    expect(output).toContain("partial");
    expect(output).toContain("data: [DONE]");
    expect(onStreamComplete.mock.calls[0][3]).toEqual({ completed: false });
  });

  it("forwards Responses completed status=failed without synthesizing success", async () => {
    const onStreamComplete = vi.fn();
    const output = await transform(
      [
        "event: response.completed",
        `data: ${JSON.stringify({ type: "response.completed", response: { status: "failed" } })}`,
        "",
      ].join("\n"),
      createSSETransformStreamWithLogger(
        FORMATS.OPENAI_RESPONSES,
        FORMATS.OPENAI,
        "qoder",
        null,
        null,
        "dfmodel",
        null,
        { messages: [{ role: "user", content: "test" }] },
        onStreamComplete,
      ),
    );

    expect(output).toContain('"code":"upstream_error"');
    expect(output).not.toContain('"finish_reason":"stop"');
    expect(onStreamComplete.mock.calls[0][3]).toEqual({ completed: false });
  });

  it("ignores a passthrough error that arrives after finish_reason", async () => {
    const onStreamComplete = vi.fn();
    const output = await transform(
      [
        `data: ${chatChunk("stop")}`,
        `data: ${JSON.stringify({ error: { code: "late_error", message: "ignore me" } })}`,
        "",
      ].join("\n"),
      createPassthroughStreamWithLogger("qoder", null, "dfmodel", null, null, onStreamComplete),
    );

    expect(output).toContain('"finish_reason":"stop"');
    expect(output).not.toContain("late_error");
    expect(onStreamComplete.mock.calls[0][3]).toEqual({ completed: true });
  });
});

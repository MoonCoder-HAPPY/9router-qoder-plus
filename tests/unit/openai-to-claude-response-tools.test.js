import { describe, expect, it } from "vitest";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";

function createState() {
  return { toolCalls: new Map(), nextBlockIndex: 0 };
}

function getInputJsonDelta(events) {
  return events.find((event) => event.type === "content_block_delta" && event.delta?.type === "input_json_delta")?.delta.partial_json;
}

describe("openaiToClaudeResponse tool argument sanitization", () => {
  it("keeps a Responses error structured through the OpenAI and Claude translators", () => {
    const state = createState();
    const openaiError = openaiResponsesToOpenAIResponse({
      type: "response.failed",
      response: {
        error: { type: "stream_error", code: "stream_disconnected", message: "socket closed" },
      },
    }, state);

    expect(openaiError.error).toEqual({
      type: "stream_error",
      code: "stream_disconnected",
      message: "socket closed",
    });
    expect(openaiToClaudeResponse(openaiError, state)).toEqual([{
      type: "error",
      error: { type: "api_error", message: "socket closed" },
    }]);
    expect(openaiToClaudeResponse({ choices: [{ delta: { content: "late" } }] }, state)).toBeNull();
  });

  it.each(["response.completed", "response.done"])("treats %s with status=failed as an error", (eventType) => {
    const state = createState();
    const openaiError = openaiResponsesToOpenAIResponse({
      type: eventType,
      response: { status: "failed" },
    }, state);

    expect(openaiError).toMatchObject({
      error: { code: "upstream_error", message: "Upstream Responses stream failed" },
    });
    expect(openaiToClaudeResponse(openaiError, state)).toEqual([{
      type: "error",
      error: { type: "api_error", message: "Upstream Responses stream failed" },
    }]);
  });

  it("does not turn a missing Responses terminal event into a Claude message stop", () => {
    const state = createState();
    const partial = openaiResponsesToOpenAIResponse({
      type: "response.output_text.delta",
      delta: "partial",
    }, state);
    expect(openaiToClaudeResponse(partial, state)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "content_block_delta" }),
    ]));

    const failure = openaiResponsesToOpenAIResponse(null, state);
    expect(failure).toMatchObject({ error: { code: "stream_disconnected" } });
    expect(openaiToClaudeResponse(failure, state)).toEqual([{
      type: "error",
      error: { type: "api_error", message: "stream closed before response.completed" },
    }]);
  });

  it("ignores an error that arrives after a normal Claude terminal", () => {
    const state = createState();
    const first = openaiToClaudeResponse({
      id: "chatcmpl-complete-first",
      choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
    }, state);

    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "message_stop" }),
    ]));
    expect(openaiToClaudeResponse({ error: { code: "stream_disconnected", message: "late" } }, state)).toBeNull();
  });

  it("preserves a structured upstream error instead of completing the message", () => {
    const events = openaiToClaudeResponse({
      error: {
        type: "server_error",
        code: "stream_disconnected",
        message: "upstream stream closed before a terminal chunk",
      },
    }, createState());

    expect(events).toEqual([{
      type: "error",
      error: {
        type: "api_error",
        message: "upstream stream closed before a terminal chunk",
      },
    }]);
  });

  it("drops invalid Read pages and clamps numeric bounds", () => {
    const state = createState();

    openaiToClaudeResponse({
      id: "chatcmpl-test-read",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_read", function: { name: "Read" } }] } }],
    }, state);

    const events = openaiToClaudeResponse({
      id: "chatcmpl-test-read",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: "F:/repo/file.js", offset: -5, limit: 999999999, pages: "" }) } }] },
        finish_reason: "tool_calls",
      }],
    }, state);

    expect(JSON.parse(getInputJsonDelta(events))).toEqual({
      file_path: "F:/repo/file.js",
      offset: 0,
      limit: 2000,
    });
  });

  it("keeps valid PDF pages", () => {
    const state = createState();

    openaiToClaudeResponse({
      id: "chatcmpl-test-pdf",
      model: "test-model",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_pdf", function: { name: "proxy_Read" } }] } }],
    }, state);

    const events = openaiToClaudeResponse({
      id: "chatcmpl-test-pdf",
      model: "test-model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ file_path: "F:/repo/doc.pdf", pages: "1-3" }) } }] },
        finish_reason: "tool_calls",
      }],
    }, state);

    expect(JSON.parse(getInputJsonDelta(events))).toEqual({
      file_path: "F:/repo/doc.pdf",
      pages: "1-3",
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleResponsesCore } from "../../open-sse/handlers/responsesHandler.js";

const mocks = vi.hoisted(() => ({
  handleChatCore: vi.fn(),
}));

vi.mock("../../open-sse/handlers/chatCore.js", () => ({
  handleChatCore: mocks.handleChatCore,
}));

const responseSse = (body) => new Response(body, {
  status: 200,
  headers: { "Content-Type": "text/event-stream" },
});

describe("Responses API handler streaming contract", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes through the final Responses SSE produced by chatCore", async () => {
    mocks.handleChatCore.mockResolvedValue({
      success: true,
      response: responseSse([
        "event: response.created",
        'data: {"type":"response.created","response":{"id":"resp_test","status":"in_progress"}}',
        "",
        "event: response.failed",
        'data: {"type":"response.failed","response":{"id":"resp_test","status":"failed","error":{"code":"stream_disconnected"}}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n")),
    });

    const result = await handleResponsesCore({
      body: { model: "qoder/dfmodel", input: "hello", stream: true },
      modelInfo: { provider: "qoder", model: "dfmodel" },
      credentials: {},
    });
    const output = await result.response.text();

    expect(result.success).toBe(true);
    expect(output).toContain("event: response.failed");
    expect(output).not.toContain("event: response.completed");
    expect(output).toContain("stream_disconnected");
  });
});

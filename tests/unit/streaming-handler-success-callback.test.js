import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((data) => data),
  extractRequestConfig: vi.fn(() => ({})),
  formatDoneLine: vi.fn(() => "DONE"),
  saveUsageStats: vi.fn(),
}));

const { buildOnStreamComplete, handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { saveRequestDetail } = await import("@/lib/usageDb.js");

describe("streaming handler success callback", () => {
  it("runs onRequestSuccess again when a streaming response completes", async () => {
    const onRequestSuccess = vi.fn(async () => {});
    const { onStreamComplete } = buildOnStreamComplete({
      provider: "qoder",
      model: "gm51model",
      connectionId: "conn-b",
      apiKey: "sk-test",
      requestStartTime: Date.now(),
      body: { stream: true },
      stream: true,
      finalBody: null,
      translatedBody: null,
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      pxpipe: null,
      reqTag: "test",
      log: { line: vi.fn() },
      onRequestSuccess,
    });

    onStreamComplete({ content: "ok" }, { prompt_tokens: 1, completion_tokens: 2 }, Date.now());
    await vi.waitFor(() => expect(onRequestSuccess).toHaveBeenCalledTimes(1));
  });

  it("does not clear account errors for an incomplete stream", async () => {
    const onRequestSuccess = vi.fn(async () => {});
    const { onStreamComplete } = buildOnStreamComplete({
      provider: "qoder",
      model: "dfmodel",
      connectionId: "conn-failed",
      requestStartTime: Date.now(),
      body: { stream: true },
      stream: true,
      clientRawRequest: { endpoint: "/v1/responses" },
      log: { line: vi.fn() },
      onRequestSuccess,
    });

    onStreamComplete({ content: "partial" }, { prompt_tokens: 1, completion_tokens: 1 }, Date.now(), { completed: false });
    await Promise.resolve();

    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("does not report streaming success before the response is consumed", async () => {
    const onRequestSuccess = vi.fn(async () => {});
    saveRequestDetail.mockClear();
    const streamController = {
      signal: new AbortController().signal,
      startTime: Date.now(),
      isConnected: () => true,
      handleComplete: vi.fn(),
      handleError: vi.fn(),
      handleDisconnect: vi.fn(),
      abort: vi.fn(),
    };
    const result = await handleStreamingResponse({
      providerResponse: new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
      provider: "qoder",
      model: "dfmodel",
      sourceFormat: "openai",
      targetFormat: "openai",
      userAgent: "",
      body: { stream: true },
      stream: true,
      translatedBody: null,
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: null,
      apiKey: null,
      apiKeyIdentity: null,
      clientRawRequest: null,
      onRequestSuccess,
      reqLogger: null,
      toolNameMap: null,
      streamController,
      onStreamComplete: vi.fn(),
      streamDetailId: "stream-test",
      pxpipe: null,
      reqTag: "",
      log: null,
    });

    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(saveRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({ status: "streaming" }),
    );
    await result.response.text();
  });
});

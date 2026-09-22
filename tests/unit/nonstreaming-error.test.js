import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  recordApiKeyQoderCreditUsage: vi.fn(async () => {}),
}));

const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

describe("non-streaming structured errors", () => {
  it("does not turn a 200 SSE error frame into a successful response", async () => {
    const onRequestSuccess = vi.fn();
    const result = await handleNonStreamingResponse({
      providerResponse: new Response(
        'data: {"error":{"code":"stream_disconnected","message":"socket closed"}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
      provider: "qoder",
      model: "dfmodel",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      body: { model: "qoder/dfmodel", messages: [], stream: false },
      stream: false,
      translatedBody: null,
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "nonstream-error",
      apiKey: null,
      apiKeyIdentity: null,
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      onRequestSuccess,
      reqLogger: {
        logProviderResponse: vi.fn(),
        logConvertedResponse: vi.fn(),
      },
      toolNameMap: null,
      trackDone: vi.fn(),
      appendLog: vi.fn(),
      pxpipe: null,
      reqTag: "",
      log: null,
    });

    const json = await result.response.json();
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect(json.error.message).toContain("socket closed");
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((data) => data),
  extractRequestConfig: vi.fn(() => ({})),
  formatDoneLine: vi.fn(() => "DONE"),
  saveUsageStats: vi.fn(),
}));

const { buildOnStreamComplete } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");

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
});

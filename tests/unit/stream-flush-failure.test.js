import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  translateResponse: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/translator/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  translateResponse: mocks.translateResponse,
}));

const { createSSETransformStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

describe("SSE flush failures", () => {
  it("records an incomplete stream and rejects instead of swallowing a flush translator error", async () => {
    const onStreamComplete = vi.fn();
    mocks.translateResponse.mockImplementation((_target, _source, chunk) => {
      if (chunk === null) throw new Error("flush translator failed");
      return [];
    });

    const transform = createSSETransformStreamWithLogger(
      FORMATS.OPENAI,
      FORMATS.CLAUDE,
      "qoder",
      null,
      null,
      "dfmodel",
      null,
      { messages: [{ role: "user", content: "test" }] },
      onStreamComplete,
    );
    const reader = new Response(
      "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
    ).body.pipeThrough(transform).getReader();

    await expect(reader.read()).rejects.toThrow("flush translator failed");
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
    expect(onStreamComplete.mock.calls[0][3]).toEqual({ completed: false });
  });
});

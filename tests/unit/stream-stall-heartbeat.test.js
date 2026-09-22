import { describe, expect, it, vi } from "vitest";

import { pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";

describe("stream stall watchdog and comment heartbeats", () => {
  it("does not reset the watchdog for provider-generated SSE comments", async () => {
    const encoder = new TextEncoder();
    const abortController = new AbortController();
    let interval = null;
    const providerResponse = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[]}\n\n'));
        interval = setInterval(() => {
          controller.enqueue(encoder.encode(": qoder stream keepalive 1\\n\\n"));
        }, 5);
      },
      cancel() {
        if (interval) clearInterval(interval);
      },
    }), { headers: { "content-type": "text/event-stream" } });

    const streamController = {
      signal: abortController.signal,
      startTime: Date.now(),
      isConnected: () => !abortController.signal.aborted,
      handleComplete: vi.fn(),
      handleError: vi.fn(),
      handleDisconnect: vi.fn(),
      abort: vi.fn((reason) => abortController.abort(reason)),
    };

    const output = pipeWithDisconnect(
      providerResponse,
      new TransformStream(),
      streamController,
      null,
      25,
      { ignoreCommentHeartbeats: true },
    );
    const reader = output.getReader();
    await reader.read();

    await vi.waitFor(() => expect(streamController.abort).toHaveBeenCalled(), { timeout: 250 });
    expect(streamController.handleError).toHaveBeenCalledWith(expect.any(Error));
    await reader.cancel();
  });
});

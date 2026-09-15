import { describe, expect, it, vi } from "vitest";

import { __test__ as qoderInternals, resolveTimeoutPolicy } from "../../open-sse/executors/qoder.js";

const { createQoderQueueRetryResponse } = qoderInternals;

// Mirror the shape Qoder really sends: an SSE envelope whose body is a JSON string.
const envelope = (body, statusCodeValue = 200) =>
  `data: ${JSON.stringify({ statusCodeValue, body: JSON.stringify(body) })}\n\n`;

const firstTokenTimeoutStream = () =>
  new Response(envelope({ code: "504", message: "First Token Timeout or Upstream Timeout" }, 504), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const okStream = () =>
  new Response(
    envelope({ id: "chatcmpl-x", choices: [{ index: 0, delta: { content: "PONG" }, finish_reason: null }] }) +
      envelope({ id: "chatcmpl-x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      `data: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
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

describe("first-token 504 retry ladder (account-then-budget)", () => {
  it("retries the same stream with the policy's delay and delivers the answer", async () => {
    const policy = resolveTimeoutPolicy({ firstTokenTimeoutFallback: "account-then-budget" });
    const delays = [];
    let attempt = 0;
    const doFetch = vi.fn(async () => {
      attempt += 1;
      return attempt === 1 ? firstTokenTimeoutStream() : okStream();
    });

    const response = createQoderQueueRetryResponse({
      initialQueueInfo: { queued: true, queueCount: null, reason: "first token timeout", source: "stream" },
      model: "qoder/dfmodel",
      signal: null,
      log: null,
      doFetch,
      keepaliveMs: 60000,
      timeoutRetryOptions: policy.timeoutOptions,
      sleepFn: async (ms) => { delays.push(ms); },
    });

    const out = await drain(response);
    expect(doFetch).toHaveBeenCalledTimes(2);
    // Ladder: one quick retry (3s) then the extended budget (6s) - never the legacy fixed ladder.
    expect(delays).toEqual([policy.timeoutOptions.delayFor(1), policy.timeoutOptions.delayFor(2)]);
    expect(out).toContain("PONG");
    expect(out).not.toContain("[qoder error");
  });

  it("uses the extended budget on the second retry", async () => {
    const policy = resolveTimeoutPolicy({ firstTokenTimeoutFallback: "budget-only" });
    const delays = [];
    let attempt = 0;
    const doFetch = vi.fn(async () => {
      attempt += 1;
      return attempt < 3 ? firstTokenTimeoutStream() : okStream();
    });

    const response = createQoderQueueRetryResponse({
      initialQueueInfo: { queued: true, queueCount: null, reason: "first token timeout", source: "stream" },
      model: "qoder/dfmodel",
      signal: null,
      log: null,
      doFetch,
      keepaliveMs: 60000,
      timeoutRetryOptions: policy.timeoutOptions,
      sleepFn: async (ms) => { delays.push(ms); },
    });

    await drain(response);
    expect(delays).toEqual([policy.timeoutOptions.delayFor(1), policy.timeoutOptions.delayFor(2), policy.timeoutOptions.delayFor(3)]);
    expect(delays[1]).toBeGreaterThan(delays[0]);
  });
});
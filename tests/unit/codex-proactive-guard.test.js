import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/services/qoderModels.js", () => ({
  getQoderModelConfig: vi.fn(async () => ({
    key: "dfmodel",
    is_reasoning: true,
    max_input_tokens: 1000000,
    max_output_tokens: 64000,
  })),
  resolveQoderModels: vi.fn(async () => ({ rawConfigs: new Map() })),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => {
    fetchState.calls += 1;
    return new Response("data: [DONE]\\n\\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }),
}));

const fetchState = vi.hoisted(() => ({ calls: 0 }));
const codexCompatMock = vi.hoisted(() => ({
  settings: {
    autoCompactRatio: 0.9,
    autoCompactMin: 120000,
    autoCompactMax: 1000000,
    proactiveContextGuard: true,
    autoContinueMax: 1,
    firstTokenTimeoutFallback: "account-then-budget",
    rateLimitRetryAfterCapMs: 120000,
  },
}));
vi.mock("../../src/shared/services/codexCompat.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getCodexCompatSettings: vi.fn(async () => codexCompatMock.settings),
  };
});

import { QoderExecutor } from "../../open-sse/executors/qoder.js";
import { clearContextRejections } from "../../open-sse/utils/contextAdmission.js";

const credentials = {
  id: "conn-1",
  accessToken: "dt-test",
  providerSpecificData: { userId: "user-1", machineId: "machine-1" },
};

const bigBody = (chars) => ({
  model: "qoder/dfmodel",
  messages: [
    { role: "system", content: "s" },
    { role: "user", content: "中".repeat(chars) },
  ],
  max_tokens: 1000,
});

let fetchCalls = 0;
const originalFetch = global.fetch;

beforeEach(() => {
  fetchCalls = 0;
  fetchState.calls = 0;
  global.fetch = vi.fn(async () => {
    fetchState.calls += 1;
    return new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  codexCompatMock.settings.proactiveContextGuard = true;
  clearContextRejections();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("proactive context admission", () => {
  it("rejects an oversized prompt before any upstream call", async () => {
    const executor = new QoderExecutor();
    // 800k CJK chars ≈ 1.06M tokens — past the 900k compaction threshold.
    const metrics = {};
    const result = await executor.execute({ model: "qoder/dfmodel", body: bigBody(800000), stream: true, credentials, signal: null, log: null, metrics });
    expect(metrics.compactionTriggers).toBe(1);
    expect(metrics.admissionRejectReason).toBe("context-window");
    expect(result.response.status).toBe(400);
    const payload = await result.response.json();
    expect(payload.error.code).toBe("context_length_exceeded");
    expect(payload.error.message).toContain("maximum context length");
    expect(fetchState.calls).toBe(0);
  });

  it("allows an oversized compact task through so the client can actually shrink history", async () => {
    const executor = new QoderExecutor();
    const body = { ...bigBody(800000), _compact: true };
    const result = await executor.execute({ model: "qoder/dfmodel", body, stream: true, credentials, signal: null, log: null });
    expect(result.response.status).toBe(200);
    expect(fetchState.calls).toBe(1);
  });

  it("lets a small prompt through to the upstream", async () => {
    const executor = new QoderExecutor();
    const result = await executor.execute({ model: "qoder/dfmodel", body: bigBody(50), stream: true, credentials, signal: null, log: null });
    expect(result.response.status).toBe(200);
    expect(fetchState.calls).toBe(1);
  });

  it("stops rejecting after the cap so a retrying client is never trapped", async () => {
    const executor = new QoderExecutor();
    for (let i = 0; i < 3; i += 1) {
      const rejected = await executor.execute({ model: "qoder/dfmodel", body: bigBody(800000), stream: true, credentials, signal: null, log: null, clientSessionId: "retry-session" });
      expect(rejected.response.status).toBe(400);
    }
    const fourth = await executor.execute({ model: "qoder/dfmodel", body: bigBody(800000), stream: true, credentials, signal: null, log: null, clientSessionId: "retry-session" });
    expect(fourth.response.status).toBe(200);
    expect(fetchState.calls).toBe(1);
  });

  it("keeps rejection caps isolated between client sessions", async () => {
    const executor = new QoderExecutor();
    for (let i = 0; i < 3; i += 1) {
      const rejected = await executor.execute({ model: "qoder/dfmodel", body: bigBody(800000), stream: true, credentials, signal: null, log: null, clientSessionId: "session-a" });
      expect(rejected.response.status).toBe(400);
    }

    const otherSession = await executor.execute({ model: "qoder/dfmodel", body: bigBody(800000), stream: true, credentials, signal: null, log: null, clientSessionId: "session-b" });
    expect(otherSession.response.status).toBe(400);
    expect(fetchState.calls).toBe(0);

    const releasedSession = await executor.execute({ model: "qoder/dfmodel", body: bigBody(800000), stream: true, credentials, signal: null, log: null, clientSessionId: "session-a" });
    expect(releasedSession.response.status).toBe(200);
    expect(fetchState.calls).toBe(1);
  });

  it("does not let persisted settings disable the fixed Qoder guard", async () => {
    codexCompatMock.settings.proactiveContextGuard = false;
    const executor = new QoderExecutor();
    const result = await executor.execute({ model: "qoder/dfmodel", body: bigBody(800000), stream: true, credentials, signal: null, log: null });
    expect(result.response.status).toBe(400);
    expect(fetchState.calls).toBe(0);
  });
});

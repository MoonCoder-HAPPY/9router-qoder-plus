import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalTimeoutBaseDelay = process.env.QODER_TIMEOUT_BASE_DELAY_MS;
const originalTimeoutMaxDelay = process.env.QODER_TIMEOUT_MAX_DELAY_MS;
process.env.QODER_TIMEOUT_BASE_DELAY_MS = "1";
process.env.QODER_TIMEOUT_MAX_DELAY_MS = "1";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

vi.mock("../../open-sse/services/qoderModels.js", () => ({
  getQoderModelConfig: vi.fn(async (_credentials, key) => ({
    key,
    max_input_tokens: 1_000_000,
    max_output_tokens: 32_768,
    is_reasoning: false,
  })),
  resolveQoderModels: vi.fn(async () => ({ rawConfigs: new Map() })),
}));

vi.mock("@/shared/services/codexCompat.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getCodexCompatSettings: vi.fn(async () => ({
    autoContinueMax: 1,
    firstTokenTimeoutFallback: "account-then-budget",
  })),
}));

const { default: QoderExecutor } = await import("../../open-sse/executors/qoder.js");
const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");
const { createSSETransformStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const credentials = {
  accessToken: "test-token",
  displayName: "Socket Retry Test",
  providerSpecificData: {
    userId: "test-user",
    machineId: "test-machine",
  },
};

const body = {
  messages: [{ role: "user", content: "keep this request isolated" }],
  tools: [],
};

const log = {
  info: vi.fn(),
  warn: vi.fn(),
};

function completedResponse(content = "recovered") {
  const chunk = JSON.stringify({
    id: "chatcmpl-socket-retry",
    choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
  });
  const envelope = JSON.stringify({ statusCodeValue: 200, body: chunk });
  return new Response(`data: ${envelope}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function firstTokenTimeoutResponse() {
  const body = JSON.stringify({
    code: "504",
    message: "First Token Timeout or Upstream Timeout",
  });
  const envelope = JSON.stringify({ statusCodeValue: 504, body });
  return new Response(`data: ${envelope}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function socketClosedError() {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("other side closed"), {
      code: "UND_ERR_SOCKET",
    }),
  });
}

function execute(signal = new AbortController().signal) {
  return new QoderExecutor().execute({
    model: "qoder/dfmodel",
    body,
    stream: true,
    credentials,
    signal,
    log,
    clientSessionId: "socket-retry-session",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  if (originalTimeoutBaseDelay === undefined) delete process.env.QODER_TIMEOUT_BASE_DELAY_MS;
  else process.env.QODER_TIMEOUT_BASE_DELAY_MS = originalTimeoutBaseDelay;
  if (originalTimeoutMaxDelay === undefined) delete process.env.QODER_TIMEOUT_MAX_DELAY_MS;
  else process.env.QODER_TIMEOUT_MAX_DELAY_MS = originalTimeoutMaxDelay;
});

describe("Qoder pre-response socket retry", () => {
  it("retries one upstream socket close on the same account with fresh request identity", async () => {
    mocks.proxyAwareFetch
      .mockRejectedValueOnce(socketClosedError())
      .mockResolvedValueOnce(completedResponse());

    const result = await execute();
    const text = await result.response.text();

    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);
    const firstInit = mocks.proxyAwareFetch.mock.calls[0][1];
    const secondInit = mocks.proxyAwareFetch.mock.calls[1][1];
    expect(firstInit.headers["X-Request-Id"]).not.toBe(secondInit.headers["X-Request-Id"]);
    expect(firstInit.headers.Authorization).not.toBe(secondInit.headers.Authorization);
    expect(Buffer.compare(firstInit.body, secondInit.body)).not.toBe(0);
    expect(result.headers["X-Request-Id"]).toBe(secondInit.headers["X-Request-Id"]);
    expect(text).toContain(": qoder network retry keepalive");
    expect(text).toContain('"content":"recovered"');
    expect(text).toContain("data: [DONE]");
  });

  it("stops after the single internal retry and returns a retryable SSE error", async () => {
    mocks.proxyAwareFetch.mockRejectedValue(socketClosedError());

    const result = await execute();
    const text = await result.response.text();

    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(text).toContain('"code":"server_is_overloaded"');
    expect(text).toContain("UND_ERR_SOCKET");
    expect(text).toContain("data: [DONE]");
  });

  it("maps an exhausted retry to response.failed for the production Responses endpoint", async () => {
    mocks.proxyAwareFetch.mockRejectedValue(socketClosedError());

    const result = await execute();
    const translated = await new Response(
      result.response.body.pipeThrough(
        createSSETransformStreamWithLogger(
          FORMATS.OPENAI,
          FORMATS.OPENAI_RESPONSES,
          "qoder",
          null,
          null,
          "dfmodel",
          null,
          body,
        ),
      ),
    ).text();

    expect(translated).toContain("event: response.failed");
    expect(translated).toContain('"code":"server_is_overloaded"');
    expect(translated).not.toContain("event: response.completed");
  });

  it("hands a 504 response after the socket retry to the existing timeout ladder", async () => {
    mocks.proxyAwareFetch
      .mockRejectedValueOnce(socketClosedError())
      .mockResolvedValueOnce(firstTokenTimeoutResponse())
      .mockResolvedValueOnce(completedResponse("recovered after timeout"));

    const result = await execute();
    const text = await result.response.text();

    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(3);
    expect(text).toContain(": qoder network retry keepalive");
    expect(text).toContain(": qoder queue keepalive");
    expect(text).toContain('"content":"recovered after timeout"');
    expect(text).toContain("data: [DONE]");
  });

  it("does not classify an exhausted socket close as an account fault", () => {
    const result = checkFallbackError(
      502,
      "[502]: fetch failed (cause: UND_ERR_SOCKET: other side closed)",
    );

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
  });

  it.each([
    "UND_ERR_SOCKET: other side closed",
    "ECONNRESET",
    "EPIPE",
    "socket hang up",
    "connection reset by peer",
  ])("keeps explicit transport failure %s out of the account lock path", (message) => {
    expect(checkFallbackError(502, message)).toEqual({ shouldFallback: false, cooldownMs: 0 });
  });

  it("still treats an unrelated 502 as a fallback candidate", () => {
    expect(checkFallbackError(502, "upstream returned an invalid response").shouldFallback).toBe(true);
  });

  it("does not retry a client AbortError", async () => {
    const error = new DOMException("The operation was aborted", "AbortError");
    mocks.proxyAwareFetch.mockRejectedValueOnce(error);

    await expect(execute()).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight internal retry when the client disconnects", async () => {
    const controller = new AbortController();
    mocks.proxyAwareFetch
      .mockRejectedValueOnce(socketClosedError())
      .mockImplementationOnce(async (_url, init) => new Promise((_, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(init.signal.reason || new DOMException("The operation was aborted", "AbortError")),
          { once: true },
        );
      }));

    const result = await execute(controller.signal);
    const reading = result.response.text();
    controller.abort(new DOMException("The operation was aborted", "AbortError"));

    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps ordinary HTTP account errors on the existing fallback path", async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(
      new Response('{"error":{"message":"invalid credential"}}', {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await execute();

    expect(result.response.status).toBe(401);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(checkFallbackError(401, "invalid credential").shouldFallback).toBe(true);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";

const { execute, resolveKey, fallback } = vi.hoisted(() => ({ execute: vi.fn(), resolveKey: vi.fn(), fallback: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true, execute }) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {},
    logProviderResponse() {}, logConvertedResponse() {}, logError() {},
    logStreamChunk() {},
  }),
}));
vi.mock("@/shared/services/modelIdleAlert.js", () => ({ markModelCall: vi.fn() }));
vi.mock("@/lib/usageDb.js", async (importOriginal) => ({
  ...await importOriginal(), trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("../../src/sse/services/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildApiKeyOptions: async (...args) => { resolveKey(...args); return actual.buildApiKeyOptions(...args); },
    getProviderCredentials: async () => ({ connectionId: "account", apiKey: "upstream-secret", providerSpecificData: {} }),
    clearAccountError: async () => {},
    markAccountUnavailable: fallback,
  };
});
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_, credentials) => credentials, updateProviderCredentials: async () => {},
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "openai", model: "gpt-4o" }),
  getComboModels: async () => null,
}));

let db, adapter, handleChat, key, tempDir;
const originalDataDir = process.env.DATA_DIR;
beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-entry-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ enableObservability2: true, observabilityBatchSize: 1, requireApiKey: false });
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  ({ handleChat } = await import("../../src/sse/handlers/chat.js"));
});
afterAll(() => {
  adapter?.close();
  delete global._dbAdapter;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});
beforeEach(async () => {
  vi.clearAllMocks();
  fallback.mockResolvedValue({ shouldFallback: false });
  adapter.run("DELETE FROM requestDetails");
  key = await db.createApiKey("Original", "test-machine");
});

function request(stream = false, value = key.key) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: value ? { authorization: `Bearer ${value}`, "content-type": "application/json" } : {},
    body: JSON.stringify({ model: "openai/gpt-4o", stream, messages: [{ role: "user", content: "hello" }], apiKeyId: "forged", apiKeyName: "Forged" }),
  });
}
const jsonResponse = () => new Response(JSON.stringify({
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
}), { headers: { "content-type": "application/json" } });
const sseResponse = () => new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });

describe("trusted Key snapshot at actual chat entry", () => {
  it.each(["json", "forced-sse-json", "stream", "http-error", "throw"])("persists %s details after the Key is renamed and deleted in flight", async mode => {
    execute.mockImplementation(async () => {
      await db.updateApiKey(key.id, { name: "Renamed" });
      await db.deleteApiKey(key.id);
      if (mode === "throw") throw new Error("upstream unavailable");
      const response = mode === "http-error"
        ? new Response('{"error":{"message":"failed"}}', { status: 500 })
        : mode === "json" ? jsonResponse() : sseResponse();
      return { response, headers: {}, url: "http://mock/upstream" };
    });
    const response = await handleChat(request(mode === "stream"));
    await response.text();
    await vi.waitFor(async () => {
      const { details } = await db.getRequestDetails();
      expect(details.length).toBeGreaterThan(0);
      for (const detail of details) expect(detail).toMatchObject({ apiKeyId: key.id, apiKeyName: "Original" });
      if (mode === "stream") expect(details[0].response.content).toBe("ok");
      expect(JSON.stringify(details)).not.toContain(key.key);
    });
    expect(resolveKey).toHaveBeenCalledTimes(1);
  });
  it.each([[null, true], ["unrecognized-secret", false]])("distinguishes missing and unresolved credentials: %s", async (value, noKey) => {
    execute.mockResolvedValue({ response: jsonResponse(), headers: {} });
    await (await handleChat(request(false, value))).text();
    await vi.waitFor(async () => expect((await db.getRequestDetails()).details).toHaveLength(1));
    const detail = (await db.getRequestDetails()).details[0];
    if (noKey) expect(detail).toMatchObject({ apiKeyId: null, apiKeyName: null });
    else expect(detail).not.toHaveProperty("apiKeyId");
  });
  it("reuses the original snapshot across account fallback without resolving again", async () => {
    fallback.mockResolvedValueOnce({ shouldFallback: true });
    execute.mockImplementationOnce(async () => {
      await db.deleteApiKey(key.id);
      throw new Error("retry this account");
    }).mockImplementationOnce(async () => ({ response: jsonResponse(), headers: {} }));
    expect((await handleChat(request())).status).toBe(200);
    await vi.waitFor(async () => expect((await db.getRequestDetails()).details).toHaveLength(2));
    for (const detail of (await db.getRequestDetails()).details) {
      expect(detail).toMatchObject({ apiKeyId: key.id, apiKeyName: "Original" });
    }
    expect(resolveKey).toHaveBeenCalledTimes(1);
  });
  it("keeps the snapshot when the upstream stream fails after starting", async () => {
    let upstream;
    execute.mockImplementation(async () => ({
      response: new Response(new ReadableStream({ start(controller) { upstream = controller; } }), {
        headers: { "content-type": "text/event-stream" },
      }), headers: {},
    }));
    const response = await handleChat(request(true));
    const reading = response.text();
    upstream.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n'));
    await vi.waitFor(async () => expect((await db.getRequestDetails()).details).toHaveLength(1));
    upstream.error(new Error("ECONNRESET"));
    await reading;
    expect((await db.getRequestDetails()).details[0]).toMatchObject({ apiKeyId: key.id, apiKeyName: "Original" });
    expect(resolveKey).toHaveBeenCalledTimes(1);
  });
  it("continues rejecting invalid or inactive credentials when authentication is required", async () => {
    await db.updateSettings({ requireApiKey: true });
    try {
      expect((await handleChat(request(false, "unknown"))).status).toBe(401);
      await db.updateApiKey(key.id, { isActive: false });
      expect((await handleChat(request())).status).toBe(401);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await db.updateSettings({ requireApiKey: false });
    }
  });
});

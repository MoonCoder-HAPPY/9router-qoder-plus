import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-detail-codex-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  delete global._dbAdapter;
  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* windows lock: TEMP cleanup is harmless */ }
  }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("request details persist the Codex metrics block", () => {
  it("keeps the codex block through the buffered write path", async () => {
    const { saveRequestDetail, getRequestDetails } = await import("../../src/lib/usageDb.js");
    await saveRequestDetail({
      id: "detail-codex-1",
      provider: "qoder",
      model: "dfmodel",
      timestamp: new Date().toISOString(),
      status: "success",
      latency: { ttft: 1, total: 2 },
      tokens: { prompt_tokens: 1, completion_tokens: 1 },
      request: { model: "dfmodel" },
      providerResponse: "ok",
      response: { content: "ok", thinking: null, type: "streaming" },
      codex: { reasoningEvents: 7, contextPeakEstimate: 1234, contextLimit: 500000 },
    });

    // The repo buffers writes and flushes on a timer (observability batch settings).
    let detail = null;
    for (let attempt = 0; attempt < 40 && !detail; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const listed = await getRequestDetails({ provider: "qoder" });
      detail = (listed?.items || listed?.details || []).find((row) => row?.id === "detail-codex-1") || null;
    }

    expect(detail, "detail row was never flushed").toBeTruthy();
    expect(detail.codex).toEqual({ reasoningEvents: 7, contextPeakEstimate: 1234, contextLimit: 500000 });
  }, 20000);
});
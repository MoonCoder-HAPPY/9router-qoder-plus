import { describe, expect, it, vi } from "vitest";

const modelConfig = {
  key: "qmodel_latest",
  max_input_tokens: 1_000_000,
  max_output_tokens: 32_768,
  is_reasoning: false,
};

vi.mock("../../open-sse/services/qoderModels.js", () => ({
  getQoderModelConfig: vi.fn(async (_credentials, key) => ({ ...modelConfig, key })),
  resolveQoderModels: vi.fn(async () => ({
    rawConfigs: new Map([[modelConfig.key, modelConfig]]),
  })),
}));

import { __test__ as qoderInternals } from "../../open-sse/executors/qoder.js";

describe("Qoder session isolation", () => {
  it("keeps identical prompts from different client sessions on separate upstream identities", async () => {
    const credentials = {
      accessToken: "test-token",
      providerSpecificData: { userId: "same-qoder-account" },
    };
    const body = {
      messages: [{ role: "user", content: "same prompt" }],
      tools: [],
    };

    const sessionA = await qoderInternals.buildQoderRequestBody({
      model: "qoder/qmodel_latest",
      body,
      credentials,
      clientSessionId: "client-session-a",
    });
    const sessionB = await qoderInternals.buildQoderRequestBody({
      model: "qoder/qmodel_latest",
      body,
      credentials,
      clientSessionId: "client-session-b",
    });

    expect(sessionA.payload.session_id).not.toBe(sessionB.payload.session_id);
    expect(sessionA.payload.request_set_id).not.toBe(sessionB.payload.request_set_id);
    expect(sessionA.payload.chat_record_id).not.toBe(sessionB.payload.chat_record_id);
  });

  it("keeps the upstream identity stable across turns in one client session", async () => {
    const credentials = {
      accessToken: "test-token",
      providerSpecificData: { userId: "same-qoder-account" },
    };

    const firstTurn = await qoderInternals.buildQoderRequestBody({
      model: "qoder/qmodel_latest",
      body: { messages: [{ role: "user", content: "first turn" }], tools: [] },
      credentials,
      clientSessionId: "client-session-a",
    });
    const secondTurn = await qoderInternals.buildQoderRequestBody({
      model: "qoder/qmodel_latest",
      body: { messages: [{ role: "user", content: "second turn" }], tools: [] },
      credentials,
      clientSessionId: "client-session-a",
    });

    expect(firstTurn.payload.session_id).toBe(secondTurn.payload.session_id);
  });

  it("uses a raw client session header when the caller has not passed a resolved id", async () => {
    const base = {
      accessToken: "test-token",
      providerSpecificData: { userId: "same-qoder-account" },
      rawHeaders: { "x-session-id": "header-session-a" },
    };
    const sessionA = await qoderInternals.buildQoderRequestBody({
      model: "qoder/qmodel_latest",
      body: { messages: [{ role: "user", content: "same prompt" }], tools: [] },
      credentials: base,
    });
    const sessionB = await qoderInternals.buildQoderRequestBody({
      model: "qoder/qmodel_latest",
      body: { messages: [{ role: "user", content: "same prompt" }], tools: [] },
      credentials: { ...base, rawHeaders: { "x-session-id": "header-session-b" } },
    });

    expect(sessionA.payload.session_id).not.toBe(sessionB.payload.session_id);
  });
});

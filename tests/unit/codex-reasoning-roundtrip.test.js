import { describe, expect, it } from "vitest";

import { initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import {
  buildReasoningEncryptedContent,
  parseReasoningEncryptedContent,
  reasoningEnvelopeMatches,
} from "../../open-sse/translator/concerns/reasoningEnvelope.js";

const chunk = (delta, extra = {}) => ({
  id: "chatcmpl-test",
  model: "DeepSeek-Flash",
  object: "chat.completion.chunk",
  created: 1,
  choices: [{ index: 0, delta, ...extra }],
});

const collect = (chunks) => {
  const state = { ...initState(FORMATS.OPENAI_RESPONSES), created: 1 };
  const events = [];
  for (const c of chunks) events.push(...openaiToOpenAIResponsesResponse(c, state));
  return events;
};
const byName = (events, name) => events.filter((e) => e.event === name);
const dataOf = (events, name) => byName(events, name).map((e) => e.data);

describe("reasoning envelope", () => {
  it("round-trips our own opaque blob", () => {
    const blob = buildReasoningEncryptedContent({ model: "DeepSeek-Flash", text: "step 1", now: 1700000000000 });
    const parsed = parseReasoningEncryptedContent(blob);
    expect(parsed).toMatchObject({ v: 1, model: "DeepSeek-Flash", ts: 1700000000000, len: 6 });
    expect(reasoningEnvelopeMatches(blob, "step 1")).toBe(true);
    expect(reasoningEnvelopeMatches(blob, "tampered")).toBe(false);
  });

  it("carries no chain-of-thought text and no credentials", () => {
    const secret = "the model secretly reasoned about api keys";
    const blob = buildReasoningEncryptedContent({ model: "DeepSeek-Flash", text: secret });
    expect(blob).not.toContain("secretly");
    expect(Buffer.from(blob, "base64url").toString("utf8")).not.toContain("secretly");
  });

  it("rejects foreign or malformed payloads instead of throwing", () => {
    expect(parseReasoningEncryptedContent("not-base64!!")).toBeNull();
    expect(parseReasoningEncryptedContent(Buffer.from("{\"v\":9}").toString("base64url"))).toBeNull();
    expect(parseReasoningEncryptedContent(null)).toBeNull();
    expect(parseReasoningEncryptedContent(undefined)).toBeNull();
  });
});

describe("responses reasoning event contract", () => {
  const events = collect([
    chunk({ role: "assistant", reasoning_content: "" }),
    chunk({ reasoning_content: "Let me " }),
    chunk({ reasoning_content: "think." }),
    chunk({ content: "Answer" }, { finish_reason: "stop" }),
  ]);

  it("announces the reasoning item before any delta (Codex errors otherwise)", () => {
    const order = events.map((e) => e.event);
    expect(order.indexOf("response.output_item.added")).toBeLessThan(order.indexOf("response.reasoning_summary_text.delta"));
    expect(dataOf(events, "response.output_item.added").some((d) => d.item?.type === "reasoning")).toBe(true);
  });

  it("streams an expandable reasoning body after a separate status header", () => {
    const parts = dataOf(events, "response.reasoning_summary_part.added");
    expect(parts.map((part) => part.summary_index)).toEqual([0, 1]);
    const itemId = dataOf(events, "response.output_item.added").find((d) => d.item?.type === "reasoning").item.id;
    expect(itemId.length).toBeLessThanOrEqual(64);
    for (const d of dataOf(events, "response.reasoning_summary_text.delta")) {
      expect(d.item_id).toBe(itemId);
      expect(d.summary_index).toBeGreaterThanOrEqual(0);
    }
    expect(dataOf(events, "response.reasoning_summary_text.delta").at(-1)?.summary_index).toBe(1);
    const indexes = new Set(dataOf(events, "response.reasoning_summary_text.delta").map((d) => d.output_index));
    expect(indexes.size).toBe(1);
  });

  it("closes the reasoning section with the full text and our envelope", () => {
    const done = dataOf(events, "response.output_item.done").find((d) => d.item?.type === "reasoning");
    expect(done.item.summary).toEqual([
      { type: "summary_text", text: "**Reasoning**" },
      { type: "summary_text", text: "Let me think." },
    ]);
    expect(reasoningEnvelopeMatches(done.item.encrypted_content, "Let me think.")).toBe(true);
    expect(dataOf(events, "response.reasoning_summary_text.done").at(-1)?.text).toBe("Let me think.");
  });

  it("preserves the expandable two-part structure through the complete SSE pipeline", async () => {
    const raw = [
      `data: ${JSON.stringify(chunk({ reasoning_content: "Let me " }))}\n\n`,
      `data: ${JSON.stringify(chunk({ reasoning_content: "think." }))}\n\n`,
      `data: ${JSON.stringify(chunk({ content: "Answer" }, { finish_reason: "stop" }))}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const transform = createSSETransformStreamWithLogger(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      "qoder",
      null,
      null,
      "DeepSeek-Flash",
      null,
      { input: [{ type: "message", role: "user", content: "question" }] },
    );
    const output = await new Response(new Response(raw).body.pipeThrough(transform)).text();
    const payloads = output
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));

    expect(payloads
      .filter((event) => event.type === "response.reasoning_summary_part.added")
      .map((event) => event.summary_index)).toEqual([0, 1]);
    expect(payloads
      .filter((event) => event.type === "response.reasoning_summary_text.delta")
      .map((event) => [event.summary_index, event.delta])).toEqual([
      [0, "**Reasoning**"],
      [1, "Let me "],
      [1, "think."],
    ]);
    expect(payloads.some((event) => event.type === "response.completed")).toBe(true);
  });
});

describe("responses request side keeps only the latest chain of thought", () => {
  const olderBlob = buildReasoningEncryptedContent({ model: "DeepSeek-Flash", text: "old reasoning" });
  const latestBlob = buildReasoningEncryptedContent({ model: "DeepSeek-Flash", text: "new reasoning" });
  const body = {
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "old reasoning" }], encrypted_content: olderBlob },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "a1" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "q2" }] },
      {
        type: "reasoning",
        summary: [
          { type: "summary_text", text: "**Reasoning**" },
          { type: "summary_text", text: "new reasoning" },
        ],
        encrypted_content: latestBlob,
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "a2" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "q3" }] },
    ],
  };

  it("keeps reasoning only on the most recent assistant turn", () => {
    const out = openaiResponsesToOpenAIRequest("DeepSeek-Flash", body, true, null);
    const assistants = out.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0].reasoning_content).toBeUndefined();
    expect(assistants[0].encrypted_content).toBeUndefined();
    expect(assistants[1].reasoning_content).toBe("new reasoning");
    expect(assistants[1].encrypted_content).toBe(latestBlob);
  });

  it("forwards a foreign encrypted_content verbatim (opaque to us)", () => {
    const foreign = {
      input: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "x" }], encrypted_content: "OPENAI-CIPHERTEXT" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    };
    const out = openaiResponsesToOpenAIRequest("DeepSeek-Flash", foreign, true, null);
    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant.reasoning_content).toBe("x");
    expect(assistant.encrypted_content).toBe("OPENAI-CIPHERTEXT");
  });
});

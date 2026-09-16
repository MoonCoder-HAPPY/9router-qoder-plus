import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState, translateRequest } from "../../open-sse/translator/index.js";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

function parseCompactionContent(value) {
  const prefix = "9router:qoder-compact:v1:";
  if (typeof value !== "string" || !value.startsWith(prefix)) return null;
  return JSON.parse(Buffer.from(value.slice(prefix.length), "base64url").toString("utf8"));
}

function compactRequest(input) {
  return openaiResponsesToOpenAIRequest(
    "DeepSeek-Flash",
    {
      model: "DeepSeek-Flash",
      input,
      tools: [{ type: "function", name: "shell_command", parameters: { type: "object" } }],
      stream: true,
    },
    true,
    null,
  );
}

describe("Qoder remote compaction v2 bridge", () => {
  it("turns compaction_trigger into a tool-free summarization request", () => {
    const translated = compactRequest([
      { type: "message", role: "user", content: [{ type: "input_text", text: "old context" }] },
      { type: "compaction_trigger" },
    ]);

    expect(translated._compact).toBe(true);
    expect(translated.tools).toBeUndefined();
    expect(translated.messages.at(-1)?.role).toBe("user");
    expect(translated.messages.at(-1)?.content).toMatch(/summary|summar/i);
    expect(JSON.stringify(translated)).not.toContain("compaction_trigger");

    const throughRegistry = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI,
      "DeepSeek-Flash",
      {
        model: "DeepSeek-Flash",
        input: [{ type: "message", role: "user", content: "old" }, { type: "compaction_trigger" }],
        stream: true,
      },
      true,
      {},
      "qoder",
    );
    expect(throughRegistry._compact).toBe(true);
  });

  it("keeps compact mode through the full SSE translation stream", async () => {
    const raw = [
      `data: ${JSON.stringify({ id: "chat-3", model: "DeepSeek-Flash", choices: [{ index: 0, delta: { content: "Pipeline summary." } }] })}\n\n`,
      `data: ${JSON.stringify({ id: "chat-3", model: "DeepSeek-Flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
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
      { input: [{ type: "compaction_trigger" }] },
    );
    const output = await new Response(
      new Response(raw).body.pipeThrough(transform),
    ).text();

    expect(output).toContain("response.output_item.done");
    expect(output).toContain('"type":"compaction"');
    expect(output).toContain("response.completed");
    expect(output).not.toContain('"type":"message"');
  });

  it("returns exactly one compaction item instead of an assistant message", () => {
    const state = initState("openai-responses");
    state.provider = "qoder";
    state.model = "DeepSeek-Flash";
    state.requestBody = {
      input: [{ type: "compaction_trigger" }],
    };

    const events = [
      ...openaiToOpenAIResponsesResponse(
        { id: "chat-1", model: "DeepSeek-Flash", choices: [{ index: 0, delta: { content: "Current work summary." } }] },
        state,
      ),
      ...openaiToOpenAIResponsesResponse(
        { id: "chat-1", model: "DeepSeek-Flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        state,
      ),
      ...openaiToOpenAIResponsesResponse(null, state),
    ];

    const doneItems = events
      .filter((event) => event.event === "response.output_item.done")
      .map((event) => event.data.item);
    expect(doneItems).toHaveLength(1);
    expect(doneItems[0].type).toBe("compaction");
    expect(parseCompactionContent(doneItems[0].encrypted_content)?.summary).toBe("Current work summary.");
    expect(events.some((event) => event.event === "response.completed")).toBe(true);
    expect(events.some((event) => event.data?.item?.type === "message")).toBe(false);
  });

  it("restores a router compaction item as usable context on the next request", () => {
    const state = initState("openai-responses");
    state.provider = "qoder";
    state.model = "DeepSeek-Flash";
    state.requestBody = { input: [{ type: "compaction_trigger" }] };
    const events = [
      ...openaiToOpenAIResponsesResponse(
        { id: "chat-2", model: "DeepSeek-Flash", choices: [{ index: 0, delta: { content: "Keep decision A and file B." } }] },
        state,
      ),
      ...openaiToOpenAIResponsesResponse(
        { id: "chat-2", model: "DeepSeek-Flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        state,
      ),
      ...openaiToOpenAIResponsesResponse(null, state),
    ];
    const compacted = events.find((event) => event.event === "response.output_item.done").data.item;

    const next = compactRequest([
      compacted,
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ]);

    expect(next._compact).toBeUndefined();
    expect(next.messages.some((message) => String(message.content).includes("Keep decision A and file B."))).toBe(true);
  });
});

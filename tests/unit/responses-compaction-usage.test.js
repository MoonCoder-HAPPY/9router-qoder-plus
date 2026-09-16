import { describe, expect, it } from "vitest";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

async function translate(chunks, body = {}) {
  const raw = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  const output = await new Response(new Response(raw).body.pipeThrough(
    createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "qoder", null, null, "dfmodel", null, body),
  )).text();
  return output.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
}

const usage = {
  prompt_tokens: 900001, completion_tokens: 50, total_tokens: 900051,
  prompt_tokens_details: { cached_tokens: 800000 },
  completion_tokens_details: { reasoning_tokens: 10 },
};
const content = { choices: [{ index: 0, delta: { content: "Response." } }] };
const finish = (reason) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });

describe("Responses usage drives Codex automatic compaction", () => {
  it.each(["stop", "tool_calls", "length"])("preserves trailing usage after %s", async (reason) => {
    const events = await translate([content, finish(reason), { choices: [], usage }]);
    const completed = events.filter((event) => event.type === "response.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].response.usage).toEqual({
      input_tokens: 900001, output_tokens: 50, total_tokens: 900051,
      input_tokens_details: { cached_tokens: 800000 },
      output_tokens_details: { reasoning_tokens: 10 },
    });
  });

  it("preserves usage on the finish frame without adding a buffer", async () => {
    const events = await translate([content, { ...finish("stop"), usage }]);
    expect(events.at(-1).response.usage?.total_tokens).toBe(900051);
  });

  it("does not invent zero usage when the upstream sends none", async () => {
    const events = await translate([content, finish("stop")]);
    expect(events.at(-1).response.usage).toBeUndefined();
  });

  it("keeps trailing usage on compaction responses too", async () => {
    const events = await translate([content, finish("stop"), { choices: [], usage }], { _compact: true });
    expect(events.at(-1).response.usage?.total_tokens).toBe(900051);
  });

  it.each([{}, { _compact: true }])("never turns an upstream failure into successful completion: %j", async (body) => {
    const events = await translate([content, { error: { code: "context_length_exceeded", message: "prompt is too long" } }], body);
    expect(events.filter((event) => event.type === "response.failed")).toHaveLength(1);
    expect(events.some((event) => event.type === "response.completed")).toBe(false);
    expect(events.some((event) => event.item?.type === "compaction")).toBe(false);
  });

  it.each([{ tail: [] }, { tail: [finish("length")] }])("does not commit a truncated compaction summary: %j", async ({ tail }) => {
    const events = await translate([content, ...tail], { _compact: true });
    expect(events.at(-1).type).toBe("response.failed");
    expect(events.some((event) => event.item?.type === "compaction")).toBe(false);
  });

  it("finishes on DONE without waiting for transport EOF", async () => {
    const raw = [content, finish("stop"), { choices: [], usage }].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    const upstream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(raw)); } });
    const reader = upstream.pipeThrough(createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "qoder", null, null, "dfmodel", null, {})).getReader();
    let output = "";
    const timer = setTimeout(() => reader.cancel("test timeout"), 1000);
    try {
      while (!output.includes('"type":"response.completed"')) {
        const { value, done } = await reader.read();
        if (done) break;
        output += new TextDecoder().decode(value);
      }
      expect(output).toContain('"total_tokens":900051');
      expect(output).toContain('"type":"response.completed"');
    } finally { clearTimeout(timer); await reader.cancel(); }
  });
});

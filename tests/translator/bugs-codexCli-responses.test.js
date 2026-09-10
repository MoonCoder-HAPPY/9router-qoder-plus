// Real Codex CLI requests (OpenAI Responses API: { input:[], instructions }) → providers.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const R2O = (body) => translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "m", body, true, null, null);
const O2R = (body) => translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "m", body, true, null, null);

describe("Codex CLI Responses → OpenAI", () => {
  it("preserves a direct input_image data URL", () => {
    const url = "data:image/png;base64,AAA";
    const out = R2O({
      input: [{ type: "message", role: "user", content: [
        { type: "input_text", text: "look" },
        { type: "input_image", image_url: url, detail: "high" },
      ] }],
    });
    const image = out.messages[0].content.find((c) => c.type === "image_url");
    expect(image.image_url).toEqual({ url, detail: "high" });
  });

  it("preserves function_call_output image arrays", () => {
    const out = R2O({
      input: [
        { type: "function_call", call_id: "call_1", name: "screenshot", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: [
          { type: "input_text", text: "captured" },
          { type: "input_image", image_url: "data:image/png;base64,AAA" },
        ] },
      ],
    });
    const tool = out.messages.find((m) => m.role === "tool");
    const imageMsg = out.messages.find((m) =>
      Array.isArray(m.content) && m.content.some((c) => c.type === "image_url")
    );
    expect(tool.content).toBe("captured");
    expect(imageMsg.content[0].text).toContain("call_1");
    expect(imageMsg.content[1].image_url.url).toBe("data:image/png;base64,AAA");
  });

  it("keeps all tool results before tool-result images", () => {
    const out = R2O({
      input: [
        { type: "function_call", call_id: "call_1", name: "shot_a", arguments: "{}" },
        { type: "function_call", call_id: "call_2", name: "shot_b", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: [
          { type: "input_image", image_url: "data:image/png;base64,AAA" },
        ] },
        { type: "function_call_output", call_id: "call_2", output: [
          { type: "input_image", image_url: "data:image/png;base64,BBB" },
        ] },
      ],
    });
    const roles = out.messages.map((m) => m.role);
    expect(roles).toEqual(["assistant", "tool", "tool", "user", "user"]);
  });

  // openai-responses.js:103 — function_call with empty name skipped, can leave tool_calls: []
  // KNOWN BUG: empty tool_calls array is rejected by OpenAI/Codex
  it.fails("assistant has no empty tool_calls array when all names are empty", () => {
    const out = R2O({
      input: [
        { type: "function_call", call_id: "c1", name: "", arguments: "{}" },
      ],
    });
    const asst = out.messages.find((m) => m.role === "assistant" && m.tool_calls);
    expect(asst?.tool_calls?.length ?? 0, "empty tool_calls[] produced").toBeGreaterThan(0);
  });

  // openai-responses.js:109-110 — arguments passed through without ensuring string type
  // KNOWN BUG
  it.fails("function_call arguments end up as a string", () => {
    const out = R2O({
      input: [{ type: "function_call", call_id: "c1", name: "f", arguments: { a: 1 } }],
    });
    const asst = out.messages.find((m) => m.tool_calls);
    expect(typeof asst.tool_calls[0].function.arguments).toBe("string");
  });

  it("does not use file_id as a raw image URL", () => {
    const out = R2O({
      input: [{ type: "message", role: "user", content: [
        { type: "input_image", file_id: "file-abc" },
      ] }],
    });
    const userMsg = out.messages.find((m) => m.role === "user");
    const img = userMsg.content.find((c) => c.type === "image_url");
    expect(img.image_url.url).toBe("");
  });
});

describe("OpenAI → Codex Responses (reverse)", () => {
  it("maps developer messages to Responses API instructions", () => {
    const out = O2R({
      messages: [
        { role: "developer", content: "Follow the project rules." },
        { role: "user", content: "Hello" },
      ],
    });

    expect(out.instructions).toBe("Follow the project rules.");
    expect(out.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
    ]);
  });

  // openai-responses.js:13 — clampCallId NOT applied on Responses→Chat; but here Chat→Responses must clamp
  it("call_id longer than 64 chars is clamped", () => {
    const longId = "call_" + "x".repeat(80);
    const out = O2R({
      messages: [
        { role: "assistant", content: null, tool_calls: [
          { id: longId, type: "function", function: { name: "f", arguments: "{}" } },
        ] },
        { role: "tool", tool_call_id: longId, content: "ok" },
      ],
    });
    const fc = out.input.find((i) => i.type === "function_call");
    expect(fc.call_id.length).toBeLessThanOrEqual(64);
  });
});

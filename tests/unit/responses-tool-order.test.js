import { describe, expect, it } from "vitest";

import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";

function fc(callId, name, args = "{}") {
  return { type: "function_call", call_id: callId, name, arguments: args };
}
function fco(callId, text) {
  return { type: "function_call_output", call_id: callId, output: text };
}
function msg(role, text) {
  return { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] };
}

describe("Responses history tool ordering (DeepSeek strict validation)", () => {
  it("keeps each assistant tool_calls immediately followed by its tool messages when calls and outputs interleave", () => {
    const out = openaiResponsesToOpenAIRequest("m", {
      input: [
        msg("user", "do two things"),
        fc("call_a", "exec_command"),
        fco("call_a", "result a"),
        fc("call_b", "exec_command"),
        fco("call_b", "result b"),
        msg("assistant", "done"),
      ],
    }, true, null);

    const roles = out.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
    expect(out.messages[1].tool_calls[0].id).toBe("call_a");
    expect(out.messages[2].tool_call_id).toBe("call_a");
    expect(out.messages[3].tool_calls[0].id).toBe("call_b");
    expect(out.messages[4].tool_call_id).toBe("call_b");
  });

  it("groups multiple tool results after one assistant message", () => {
    const out = openaiResponsesToOpenAIRequest("m", {
      input: [
        msg("user", "parallel"),
        fc("call_a", "exec_command"),
        fc("call_b", "exec_command"),
        fco("call_a", "result a"),
        fco("call_b", "result b"),
        msg("user", "next"),
      ],
    }, true, null);

    const roles = out.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "tool", "user"]);
    expect(out.messages[1].tool_calls.map((t) => t.id)).toEqual(["call_a", "call_b"]);
    expect(out.messages[2].tool_call_id).toBe("call_a");
    expect(out.messages[3].tool_call_id).toBe("call_b");
  });

  it("does not emit an assistant message with an empty tool_calls array when a nameless call is skipped", () => {
    const out = openaiResponsesToOpenAIRequest("m", {
      input: [
        msg("user", "hi"),
        { type: "function_call", call_id: "call_x", arguments: "{}" },
        fco("call_x", "orphan"),
        msg("assistant", "ok"),
      ],
    }, true, null);

    for (const m of out.messages) {
      if (m.role === "assistant") {
        expect(m.tool_calls === undefined || m.tool_calls.length > 0).toBe(true);
      }
    }
    expect(out.messages.some((m) => m.role === "tool" && m.tool_call_id === "call_x")).toBe(false);
  });
});

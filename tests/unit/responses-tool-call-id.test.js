import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState } from "../../open-sse/translator/index.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";

function chunk(delta, finishReason = null) {
  return {
    id: "chatcmpl-test",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

describe("OpenAI Responses tool-call ID fallback", () => {
  it("preserves a tool call when the upstream omits its id", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const events = openaiToOpenAIResponsesResponse(
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              type: "function",
              function: {
                name: "exec_command",
                arguments: '{"cmd":"ls"}',
              },
            },
          ],
        },
        "tool_calls",
      ),
      state,
    );

    const added = events.find((event) => event.event === "response.output_item.added");
    const done = events.find(
      (event) =>
        event.event === "response.output_item.done" &&
        event.data.item?.type === "function_call",
    );

    expect(added).toBeTruthy();
    expect(done).toBeTruthy();
    expect(added.data.item.call_id).toMatch(/^call_0_\d+$/);
    expect(added.data.item.name).toBe("exec_command");
    expect(done.data.item.call_id).toBe(added.data.item.call_id);
    expect(done.data.item.arguments).toBe('{"cmd":"ls"}');
  });

  it("reuses the generated id across streamed argument chunks", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);

    const first = openaiToOpenAIResponsesResponse(
      chunk({
        tool_calls: [
          {
            index: 0,
            type: "function",
            function: { name: "exec_command", arguments: '{"cmd":' },
          },
        ],
      }),
      state,
    );
    const second = openaiToOpenAIResponsesResponse(
      chunk({
        tool_calls: [
          {
            index: 0,
            type: "function",
            function: { arguments: '"pwd"}' },
          },
        ],
      }),
      state,
    );
    const final = openaiToOpenAIResponsesResponse(
      chunk({}, "tool_calls"),
      state,
    );

    const added = first.find((event) => event.event === "response.output_item.added");
    const deltas = [...first, ...second].filter(
      (event) => event.event === "response.function_call_arguments.delta",
    );
    const done = final.find(
      (event) =>
        event.event === "response.output_item.done" &&
        event.data.item?.type === "function_call",
    );

    expect(added).toBeTruthy();
    expect(deltas).toHaveLength(2);
    expect(deltas.every((event) => event.data.item_id === added.data.item.id)).toBe(true);
    expect(done.data.item.call_id).toBe(added.data.item.call_id);
    expect(done.data.item.arguments).toBe('{"cmd":"pwd"}');
  });

  it("assigns distinct output indexes to reasoning, text, and tool calls", () => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const events = [
      ...openaiToOpenAIResponsesResponse(
        chunk({ reasoning_content: "Need to inspect the file." }),
        state,
      ),
      ...openaiToOpenAIResponsesResponse(
        chunk({ content: "I will inspect it." }),
        state,
      ),
      ...openaiToOpenAIResponsesResponse(
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"a.txt"}',
                },
              },
            ],
          },
          "tool_calls",
        ),
        state,
      ),
    ];

    const addedItems = events.filter(
      (event) => event.event === "response.output_item.added",
    );

    expect(addedItems.map((event) => event.data.item.type)).toEqual([
      "reasoning",
      "message",
      "function_call",
    ]);
    expect(addedItems.map((event) => event.data.output_index)).toEqual([0, 1, 2]);
  });
});

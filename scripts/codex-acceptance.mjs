#!/usr/bin/env node
/**
 * Codex acceptance scenarios for the codex-agent-ux spec (§16).
 *
 * Runs three scenarios against a *test* instance (never production) and asserts
 * the Responses-API contract Codex depends on:
 *
 *   A. plain question  - reasoning item announced before deltas, thought text
 *                        streamed, message streamed, response.completed
 *   B. tool chain      - a function_call item with an id, arguments and call_id
 *   C. long context    - either the proactive guard answers 400
 *                        context_length_exceeded (compaction path) or the turn
 *                        streams normally; a fake "[qoder error" body fails
 *
 * Usage:
 *   node scripts/codex-acceptance.mjs --base http://127.0.0.1:20129 --key sk-... [--model DeepSeek-Flash]
 */
import { setTimeout as delay } from "node:timers/promises";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const [key, value] = process.argv[i].replace(/^--/, "").split("=");
  args.set(key, value ?? process.argv[++i]);
}
const base = (args.get("base") || "http://127.0.0.1:20129").replace(/\/$/, "");
const apiKey = args.get("key") || process.env.NINER_KEY || "";
const model = args.get("model") || "DeepSeek-Flash";
if (!apiKey) {
  console.error("missing --key (or NINER_KEY)");
  process.exit(2);
}

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
};

async function streamResponses(body, { timeoutMs = 240000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, stream: true, store: false, include: ["reasoning.encrypted_content"], ...body }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: response.status, events: [], raw: await response.text() };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          events.push(JSON.parse(payload));
        } catch {
          /* keepalive or partial frame */
        }
      }
    }
    return { status: response.status, events, raw: "" };
  } finally {
    clearTimeout(timer);
  }
}

const of = (events, type) => events.filter((event) => event.type === type);

async function scenarioPlainQuestion() {
  const { status, events } = await streamResponses({
    instructions: "You are a terse assistant.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Reply with the single word: PONG" }] }],
  });
  const reasoningAdded = of(events, "response.output_item.added").find((event) => event.item?.type === "reasoning");
  const deltas = of(events, "response.reasoning_summary_text.delta");
  const textDeltas = of(events, "response.output_text.delta");
  const completed = of(events, "response.completed").length > 0;
  const ok = status === 200 && Boolean(reasoningAdded) && deltas.length > 0 && textDeltas.length > 0 && completed;
  record("A plain question", ok, `status=${status} reasoning_added=${Boolean(reasoningAdded)} deltas=${deltas.length} text=${textDeltas.length} completed=${completed}`);
  if (reasoningAdded) {
    const id = reasoningAdded.item.id;
    record("A reasoning item id <= 64 chars", String(id).length <= 64, `id=${id}`);
  }
}

async function scenarioToolChain() {
  const tools = [
    {
      type: "function",
      name: "exec_command",
      description: "Run a shell command and return its output.",
      parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    },
  ];
  const { status, events } = await streamResponses({
    instructions: "You are a coding agent. Use the provided tool when the user asks to inspect the workspace.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "List the files in the current directory." }] }],
    tools,
    tool_choice: "auto",
    parallel_tool_calls: false,
  });
  const calls = of(events, "response.output_item.done").filter((event) => event.item?.type === "function_call");
  const args = of(events, "response.function_call_arguments.delta");
  const ok = status === 200 && calls.length > 0 && calls.every((event) => event.item.call_id);
  record("B tool chain", ok, `status=${status} calls=${calls.length} arg_deltas=${args.length} ids=${calls.map((e) => e.item.call_id).join(",") || "-"}`);
}

async function scenarioLongContext() {
  const filler = "这是一个用于测试上下文准入的中文段落，包含若干技术细节描述。".repeat(9000); // ~340k CJK chars
  const { status, events, raw } = await streamResponses({
    instructions: "Summarise the provided text in one sentence.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: filler }] }],
  });
  if (status === 400) {
    let code = "";
    let message = raw;
    try {
      const parsed = JSON.parse(raw);
      code = parsed?.error?.code || "";
      message = parsed?.error?.message || raw;
    } catch { /* keep raw */ }
    record("C long context", code === "context_length_exceeded", `status=400 code=${code} msg=${String(message).slice(0, 120)}`);
    return;
  }
  const completed = of(events, "response.completed").length > 0;
  const polluted = events.some((event) => JSON.stringify(event).includes("[qoder error"));
  record("C long context", status === 200 && completed && !polluted, `status=${status} completed=${completed} polluted=${polluted}`);
}

(async () => {
  console.log(`# Codex acceptance against ${base} (model=${model})`);
  await scenarioPlainQuestion();
  await delay(1000);
  await scenarioToolChain();
  await delay(1000);
  await scenarioLongContext();
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
})();
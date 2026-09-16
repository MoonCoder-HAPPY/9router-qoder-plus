import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Real Codex binary, isolated home, synthetic upstream token counts. No account,
// production endpoint, user history, or model-generated shell command is used.
it.skipIf(!process.env.CODEX_TEST_BINARY).each([
  { inputTokens: 800000, shouldCompact: false },
  { inputTokens: 899950, shouldCompact: true },
  { inputTokens: 900001, shouldCompact: true },
  { inputTokens: 900001, shouldCompact: true, midTurn: true },
])("real Codex 1M/900K policy: $inputTokens input tokens, midTurn=$midTurn", async ({ inputTokens, shouldCompact, midTurn }) => {
  const home = await mkdtemp(join(tmpdir(), "9router-codex-compact-"));
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const buffers = [];
      for await (const buffer of req) buffers.push(buffer);
      const body = JSON.parse(Buffer.concat(buffers).toString());
      requests.push(body);
      const compact = body.input?.some((item) => item.type === "compaction_trigger");
      const first = requests.length === 1;
      const chunks = [
        { id: "test-response", choices: [{ index: 0, delta: first && midTurn
          ? { tool_calls: [{ index: 0, id: "call_plan", type: "function", function: { name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Verify PROJECT-ALPHA", status: "in_progress" }] }) } }] }
          : { content: compact ? "Preserve project marker PROJECT-ALPHA." : "PROJECT-ALPHA acknowledged." } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: first && midTurn ? "tool_calls" : "stop" }] },
        { choices: [], usage: { prompt_tokens: first ? inputTokens : 100, completion_tokens: 50, total_tokens: first ? inputTokens + 50 : 150 } },
      ];
      const raw = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
      const output = await new Response(new Response(raw).body.pipeThrough(
        createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "qoder", null, null, "dfmodel", null, body),
      )).text();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(output);
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = [
    'model_provider="fixture"', 'model="gpt-5.4"',
    'model_context_window=1000000', 'model_auto_compact_token_limit=900000',
    'model_providers.fixture.name="OpenAI"',
    `model_providers.fixture.base_url="http://127.0.0.1:${server.address().port}/v1"`,
    'model_providers.fixture.wire_api="responses"',
    'model_providers.fixture.requires_openai_auth=false',
    'features.plugins=false', 'features.recommended_plugins=false',
    'features.shell_snapshot=false',
  ].flatMap((value) => ["-c", value]);
  async function run(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.env.CODEX_TEST_BINARY, ["exec", "--ignore-user-config", "--ignore-rules", ...config, ...args], {
        cwd: home, env: { ...process.env, CODEX_HOME: home }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { output += data; });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Codex timeout: ${output.slice(-2000)}`)); }, 45000);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`Codex exit ${code}: ${output.slice(-3000)}`)); });
    });
  }
  try {
    await run(["--skip-git-repo-check", "--json", "Remember PROJECT-ALPHA. Reply briefly; do not use tools."]);
    if (!midTurn) await run(["resume", "--last", "--skip-git-repo-check", "--json", "Continue PROJECT-ALPHA. Reply briefly; do not use tools."]);
    const compactIndex = requests.findIndex((body) => body.input?.some((item) => item.type === "compaction_trigger"));
    if (!shouldCompact) {
      expect(compactIndex).toBe(-1);
      expect(requests).toHaveLength(2);
      return;
    }
    expect(compactIndex, "Codex must initiate compaction, not just accept a mocked trigger").toBeGreaterThan(0);
    const next = requests[compactIndex + 1];
    expect(next?.input.some((item) => item.type === "compaction")).toBe(true);
    expect(next.input.some((item) => item.type === "compaction_trigger")).toBe(false);
    expect(requests).toHaveLength(3);
    const files = await readdir(join(home, "sessions"), { recursive: true });
    const rollouts = await Promise.all(files.filter((file) => file.endsWith(".jsonl")).map((file) => readFile(join(home, "sessions", file), "utf8")));
    expect(rollouts.join("\n")).toContain('"type":"compacted"');
    expect(rollouts.join("\n")).not.toContain('"codex_error_info":"context_window_exceeded"');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
}, 110000);

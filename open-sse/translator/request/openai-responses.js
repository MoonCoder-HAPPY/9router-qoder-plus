/**
 * Translator: OpenAI Responses API → OpenAI Chat Completions
 * 
 * Responses API uses: { input: [...], instructions: "..." }
 * Chat API uses: { messages: [...] }
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { normalizeResponsesInput, splitResponsesFunctionOutput } from "../formats/responsesApi.js";
import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM } from "../schema/index.js";
import { RESPONSES_REASONING_HEADER } from "../concerns/reasoning.js";
import {
  QODER_COMPACTION_PROMPT,
  isQoderCompactionRequest,
  parseQoderCompactionContent,
} from "../concerns/qoderCompaction.js";

// Responses API enforces max 64 chars on call_id (#393)
const MAX_CALL_ID_LEN = 64;
const clampCallId = (id) => (typeof id === "string" && id.length > MAX_CALL_ID_LEN ? id.substring(0, MAX_CALL_ID_LEN) : id);

/**
 * Convert OpenAI Responses API request to OpenAI Chat Completions format
 */
export function openaiResponsesToOpenAIRequest(model, body, stream, credentials) {
  if (!body.input) return body;

  const result = { ...body };
  result.messages = [];
  const isCompactRequest = isQoderCompactionRequest(body);

  // Convert instructions to system message
  if (body.instructions) {
    result.messages.push({ role: ROLE.SYSTEM, content: body.instructions });
  }

  // Group items by conversation turn
  let currentAssistantMsg = null;
  let pendingToolResults = [];
  const declaredCallIds = new Set();
  let pendingImageMessages = [];
  let pendingReasoning = "";
  let pendingReasoningEncrypted = "";

  const flushPendingToolResults = () => {
    for (const toolResult of pendingToolResults) result.messages.push(toolResult);
    for (const imageMessage of pendingImageMessages) result.messages.push(imageMessage);
    pendingToolResults = [];
    pendingImageMessages = [];
  };

  const inputItems = normalizeResponsesInput(body.input);
  if (!inputItems) return body;

  // Extract reasoning text from summary[].text (encrypted_content is continuity-only)
  const extractReasoningText = (item) => {
    if (Array.isArray(item.summary)) {
      const parts = item.summary.map(s => s?.text || "").filter(Boolean);
      if (parts[0]?.trim() === RESPONSES_REASONING_HEADER) parts.shift();
      const txt = parts.join("\n");
      if (txt) return txt;
    }
    if (Array.isArray(item.content)) {
      const txt = item.content.map(c => c?.text || "").filter(Boolean).join("\n");
      if (txt) return txt;
    }
    return "";
  };

  // Only the most recent assistant turn keeps its chain of thought: replaying every
  // historical reasoning trace inflates the prompt (observed 300k+ token requests) while
  // the upstream only needs the CoT that belongs to the turn it is continuing.
  const stripEarlierReasoning = (keepMsg) => {
    for (const message of result.messages) {
      if (message === keepMsg || message?.role !== ROLE.ASSISTANT) continue;
      delete message.reasoning_content;
      delete message.encrypted_content;
    }
  };

  const attachPendingReasoning = (msg) => {
    if (!pendingReasoning && !pendingReasoningEncrypted) return;
    if (pendingReasoning) msg.reasoning_content = pendingReasoning;
    // Opaque blobs are forwarded verbatim: OpenAI ciphertext, our own envelope and
    // provider-specific strings are all just continuity tokens to us.
    if (pendingReasoningEncrypted) msg.encrypted_content = pendingReasoningEncrypted;
    stripEarlierReasoning(msg);
    pendingReasoning = "";
    pendingReasoningEncrypted = "";
  };


  for (const item of inputItems) {
    // Determine item type - Droid CLI sends role-based items without 'type' field
    // Fallback: if no type but has role property, treat as message
    const itemType = item.type || (item.role ? RESPONSES_ITEM.MESSAGE : null);

    if (itemType === RESPONSES_ITEM.MESSAGE) {
      // Flush any pending assistant message with tool calls
      if (currentAssistantMsg) {
        if (!currentAssistantMsg.tool_calls.length) delete currentAssistantMsg.tool_calls;
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush pending tool results
      flushPendingToolResults();

      // Convert content: input_text → text, output_text → text, input_image → image_url
      const content = Array.isArray(item.content)
        ? item.content.map(c => {
          if (c.type === RESPONSES_ITEM.INPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.OUTPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.INPUT_IMAGE) {
            const url = c.image_url || "";
            return { type: OPENAI_BLOCK.IMAGE_URL, image_url: { url, detail: c.detail || "auto" } };
          }
          return c;
        })
        : item.content;
      const msg = { role: item.role, content };
      // Attach buffered reasoning to assistant turn (required by xiaomi-mimo + store=false continuity)
      if (item.role === ROLE.ASSISTANT) attachPendingReasoning(msg);
      else {
        pendingReasoning = "";
        pendingReasoningEncrypted = "";
      }
      result.messages.push(msg);
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL) {
      // Skip items with empty/missing name — Codex/OpenAI reject nameless tool calls (#444).
      // Validate before creating the assistant message so a skipped call cannot
      // leave an assistant with an empty tool_calls array behind.
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") continue;
      // Start or append to assistant message with tool_calls
      if (!currentAssistantMsg) {
        currentAssistantMsg = {
          role: ROLE.ASSISTANT,
          content: null,
          tool_calls: []
        };
        attachPendingReasoning(currentAssistantMsg);
      }
      declaredCallIds.add(item.call_id);
      currentAssistantMsg.tool_calls.push({
        id: item.call_id,
        type: OPENAI_BLOCK.FUNCTION,
        function: {
          name: item.name,
          arguments: item.arguments
        }
      });
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT) {
      // Flush the assistant message that owns this output. Pushing the tool
      // result immediately keeps every assistant tool_calls block directly
      // followed by its tool messages; deferring it would let the next
      // assistant message land in between, which strict validators
      // (DeepSeek) reject with 400.
      if (currentAssistantMsg) {
        if (!currentAssistantMsg.tool_calls.length) delete currentAssistantMsg.tool_calls;
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }

      // Drop outputs whose call was never declared (e.g. a nameless call that
      // was skipped); an orphan tool message referencing an unknown call_id is
      // itself invalid history for strict providers.
      if (!declaredCallIds.has(item.call_id)) continue;

      const { toolContent, imageMessage } = splitResponsesFunctionOutput(item.output);
      if (imageMessage) {
        imageMessage.content[0].text = `Image output from tool call ${item.call_id}`;
      }

      result.messages.push({
        role: ROLE.TOOL,
        tool_call_id: item.call_id,
        content: toolContent
      });
      // Image messages are role:user; hold them until the next message
      // boundary so they never split a contiguous tool-result run.
      if (imageMessage) pendingImageMessages.push(imageMessage);
    }
    else if (itemType === RESPONSES_ITEM.REASONING) {
      // Buffer reasoning text; attached to next assistant message/function_call.
      // Also stash encrypted_content so a later openai→responses hop can restore
      // the store=false continuity blob (Grok CLI / Codex multi-turn).
      const txt = extractReasoningText(item);
      if (txt) pendingReasoning = pendingReasoning ? `${pendingReasoning}\n${txt}` : txt;
      if (typeof item.encrypted_content === "string" && item.encrypted_content) {
        // Prefer attaching to the next assistant message we create
        pendingReasoningEncrypted = item.encrypted_content;
      }
      continue;
    }
    else if (itemType === "compaction") {
      const compacted = parseQoderCompactionContent(item.encrypted_content);
      if (compacted) {
        result.messages.push({
          role: ROLE.USER,
          content: `[Compacted conversation context]\n${compacted.summary}`,
        });
      }
      continue;
    }
    else if (itemType === "compaction_trigger") {
      continue;
    }
  }

  // Flush remaining
  if (currentAssistantMsg) {
    if (!currentAssistantMsg.tool_calls.length) delete currentAssistantMsg.tool_calls;
    result.messages.push(currentAssistantMsg);
  }
  flushPendingToolResults();

  // Convert tools format.
  // Responses API supports "hosted" tools (e.g. { type: "request_user_input" }) that carry no
  // explicit `name` field and cannot be represented as Chat Completions function declarations.
  // Filter them out to avoid sending nameless functionDeclarations to downstream providers
  // such as Gemini, which strictly validates function names.
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools
      .map(tool => {
        // Already in Chat Completions format: { type: "function", function: { name, ... } }
        if (tool.function) return tool;
        // Responses API function tool: { type: "function", name, description, parameters }
        // Only convert when a non-empty name is present; skip hosted tools without one.
        const name = tool.name;
        if (!name || typeof name !== "string" || name.trim() === "") return null;
        return {
          type: OPENAI_BLOCK.FUNCTION,
          function: {
            name,
            description: String(tool.description || ""),
            parameters: normalizeToolParameters(tool.parameters),
            strict: tool.strict
          }
        };
      })
      .filter(Boolean);
  }

  if (isCompactRequest) {
    result._compact = true;
    result.messages.push({ role: ROLE.USER, content: QODER_COMPACTION_PROMPT });
    delete result.tools;
    delete result.tool_choice;
    delete result.parallel_tool_calls;
  } else {
    delete result._compact;
  }

  // Cleanup Responses API specific fields
  // Map Responses-only max_output_tokens to Chat max_tokens (avoid leaking unknown field upstream)
  if (result.max_output_tokens !== undefined) {
    if (result.max_tokens === undefined) result.max_tokens = result.max_output_tokens;
    delete result.max_output_tokens;
  }

  delete result.input;
  delete result.instructions;
  delete result.include;
  delete result.prompt_cache_key;
  delete result.store;
  if (typeof result.reasoning?.effort === "string") {
    result.reasoning_effort = result.reasoning.effort;
  }
  delete result.reasoning;
  delete result.client_metadata;

  return result;
}

/**
 * Ensure object schema always has properties field (required by Codex Responses API)
 */
function normalizeToolParameters(params) {
  if (!params) return { type: "object", properties: {} };
  if (params.type === "object" && !params.properties) return { ...params, properties: {} };
  return params;
}

/**
 * Build a Responses `reasoning` input item from Chat Completions assistant fields.
 * Preserves encrypted blobs needed by store=false multi-turn (Grok CLI / Codex).
 * Returns null when the message has nothing useful to re-send.
 */
function buildReasoningInputItem(msg) {
  if (!msg || typeof msg !== "object") return null;

  const encrypted =
    (typeof msg.encrypted_content === "string" && msg.encrypted_content) ||
    (typeof msg.reasoning_encrypted_content === "string" && msg.reasoning_encrypted_content) ||
    (typeof msg.reasoning?.encrypted_content === "string" && msg.reasoning.encrypted_content) ||
    "";

  let summaryText = "";
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
    summaryText = msg.reasoning_content;
  } else if (typeof msg.reasoning === "string" && msg.reasoning.trim()) {
    summaryText = msg.reasoning;
  } else if (Array.isArray(msg.reasoning_details)) {
    summaryText = msg.reasoning_details
      .map((d) => (typeof d?.text === "string" ? d.text : typeof d?.content === "string" ? d.content : ""))
      .filter(Boolean)
      .join("\n");
  }

  if (!encrypted && !summaryText) return null;

  const item = { type: RESPONSES_ITEM.REASONING };
  if (summaryText) {
    item.summary = [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: summaryText }];
  }
  // encrypted_content is the continuity token for store=false backends
  if (encrypted) item.encrypted_content = encrypted;
  return item;
}

/**
 * Convert OpenAI Chat Completions to OpenAI Responses API format
 */
export function openaiToOpenAIResponsesRequest(model, body, stream, credentials) {
  // Body already in Responses API format (e.g. Cursor CLI calling /chat/completions with input[])
  if (body.input) return { ...body, model, stream: true };

  const result = {
    model,
    input: [],
    stream: true,
    store: false
  };

  // Extract system message as instructions
  let hasSystemMessage = false;
  const messages = body.messages || [];

  for (const msg of messages) {
    if (msg.role === ROLE.SYSTEM || msg.role === ROLE.DEVELOPER) {
      // Use the first instruction-bearing message as instructions.
      // OpenAI recommends role="developer" for GPT-5/Codex as the system-level prompt.
      if (!hasSystemMessage) {
        result.instructions = typeof msg.content === "string" ? msg.content : "";
        hasSystemMessage = true;
      }
      continue; // Skip instruction messages in input
    }

    // Convert user/assistant messages to input items
    if (msg.role === ROLE.USER || msg.role === ROLE.ASSISTANT) {
      // Multi-turn continuity for store=false Responses backends (Codex / Grok CLI):
      // re-emit a reasoning item before the assistant message when the chat-format
      // history carried reasoning text and/or encrypted_content from a prior turn.
      if (msg.role === ROLE.ASSISTANT) {
        const reasoningItem = buildReasoningInputItem(msg);
        if (reasoningItem) result.input.push(reasoningItem);
      }

      const contentType = msg.role === ROLE.USER ? RESPONSES_ITEM.INPUT_TEXT : RESPONSES_ITEM.OUTPUT_TEXT;
      const content = typeof msg.content === "string"
        ? [{ type: contentType, text: msg.content }]
        : Array.isArray(msg.content)
          ? msg.content.map(c => {
            if (c.type === OPENAI_BLOCK.TEXT) return { type: contentType, text: c.text };
            // Convert Chat Completions image_url → Responses API input_image
            // Responses API expects: { type: "input_image", image_url: "<url string>" }
            // Chat Completions sends: { type: "image_url", image_url: { url: "...", detail: "..." } }
            if (c.type === OPENAI_BLOCK.IMAGE_URL) {
              const url = typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
              return { type: RESPONSES_ITEM.INPUT_IMAGE, image_url: url, detail: c.image_url?.detail || "auto" };
            }
            if (c.type === RESPONSES_ITEM.INPUT_IMAGE) return c;
            // Serialize any unknown type (tool_use, tool_result, thinking, etc.) as text
            const text = c.text || c.content || JSON.stringify(c);
            return { type: contentType, text: typeof text === "string" ? text : JSON.stringify(text) };
          })
          : [];

      // Only push a message block if content is non-empty.
      // Assistant messages with only tool_calls have content: null — skip the
      // message block in that case; the tool_calls are pushed separately below.
      if (content.length > 0) {
        result.input.push({
          type: RESPONSES_ITEM.MESSAGE,
          role: msg.role,
          content
        });
      }
    }

    // Convert tool calls
    if (msg.role === ROLE.ASSISTANT && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        result.input.push({
          type: RESPONSES_ITEM.FUNCTION_CALL,
          call_id: clampCallId(tc.id),
          name: tc.function?.name || "_unknown",
          arguments: tc.function?.arguments || "{}"
        });
      }
    }

    // Convert tool results - output must be a string for Responses API
    if (msg.role === ROLE.TOOL) {
      const output = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map(c => c.text || JSON.stringify(c)).join("")
          : JSON.stringify(msg.content);
      result.input.push({
        type: RESPONSES_ITEM.FUNCTION_CALL_OUTPUT,
        call_id: clampCallId(msg.tool_call_id),
        output
      });
    }
  }

  // If no system message, leave instructions empty (will be filled by executor)
  if (!hasSystemMessage) {
    result.instructions = "";
  }

  // Convert tools format
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools.map(tool => {
      if (tool.type === OPENAI_BLOCK.FUNCTION) {
        return {
          type: OPENAI_BLOCK.FUNCTION,
          name: tool.function.name,
          description: String(tool.function.description || ""),
          parameters: normalizeToolParameters(tool.function.parameters),
          strict: tool.function.strict
        };
      }
      return tool;
    });
  }

  // Pass through other relevant fields
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.reasoning !== undefined) result.reasoning = body.reasoning;
  if (body.reasoning_effort !== undefined) result.reasoning = { effort: body.reasoning_effort, summary: "auto" };
  if (body.service_tier !== undefined) result.service_tier = body.service_tier;

  return result;
}

// Register both directions
register(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, openaiResponsesToOpenAIRequest, null);
register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, openaiToOpenAIResponsesRequest, null);

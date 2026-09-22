/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;
  if (state.doneSeen) return;

  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!dataMatch) return;

  const dataStr = dataMatch[1].trim();
  if (dataStr === "[DONE]") {
    state.doneSeen = true;
    return;
  }
  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  if (!eventMatch) return;
  const eventType = eventMatch[1].trim();

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  if (eventType === "response.created") {
    state.responseId = parsed.response?.id || state.responseId;
    state.created = parsed.response?.created_at || state.created;
  } else if (eventType === "response.output_item.done") {
    state.items.set(parsed.output_index ?? 0, parsed.item);
  } else if (eventType === "response.completed" || eventType === "response.done") {
    const responseStatus = parsed.response?.status || parsed.status;
    const responseError = parsed.response?.error || parsed.error;
    if (responseStatus === "failed" || responseError) {
      state.status = "failed";
      state.error = responseError || {
        type: "stream_error",
        code: "upstream_error",
        message: "Upstream Responses response failed",
      };
      return;
    }
    if (state.status !== "failed") state.status = "completed";
    if (state.status === "completed" && parsed.response?.usage) {
      state.usage.input_tokens = parsed.response.usage.input_tokens || 0;
      state.usage.output_tokens = parsed.response.usage.output_tokens || 0;
      state.usage.total_tokens = parsed.response.usage.total_tokens || 0;
    }
  } else if (eventType === "response.failed") {
    state.status = "failed";
    state.error = parsed.response?.error || parsed.error || {
      type: "stream_error",
      code: "upstream_error",
      message: "Upstream Responses stream failed",
    };
  } else if (eventType === "error") {
    state.status = "failed";
    state.error = parsed.error || parsed.response?.error || {
      type: "stream_error",
      code: "upstream_error",
      message: "Upstream Responses stream failed",
    };
  }
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    return { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [], usage: { ...EMPTY_RESPONSE } };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    usage: { ...EMPTY_RESPONSE },
    items: new Map(),
    doneSeen: false
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    const trailing = decoder.decode();
    if (trailing) buffer += trailing;

    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } finally {
    reader.releaseLock();
  }

  // Build output array from accumulated items (ordered by index)
  const output = [];
  const maxIndex = state.items.size > 0 ? Math.max(...state.items.keys()) : -1;
  for (let i = 0; i <= maxIndex; i++) {
    output.push(state.items.get(i) || { type: "message", content: [], role: "assistant" });
  }

  if (state.status !== "completed" && state.status !== "failed") {
    state.status = "failed";
    state.error = {
      type: "stream_error",
      code: "stream_disconnected",
      message: "stream closed before response.completed",
    };
  }

  return {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status || "completed",
    output,
    usage: state.usage,
    ...(state.error ? { error: state.error } : {})
  };
}

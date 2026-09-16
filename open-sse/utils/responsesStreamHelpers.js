// Helpers for OpenAI Responses API streaming termination + event framing
import { FORMATS } from "../translator/formats.js";
import { CODEX_ERROR_CODES } from "../config/errorConfig.js";
import { formatSSE } from "./streamHelpers.js";

// Responses API events that signal the stream has reached a terminal state
const OPENAI_RESPONSES_TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.done",
  "response.failed",
  "error"
]);

export function getOpenAIResponsesEventName(eventName, chunk) {
  if (eventName) return eventName;
  if (chunk && typeof chunk.type === "string") return chunk.type;
  return null;
}

export function isOpenAIResponsesTerminalEvent(eventName, chunk) {
  const type = getOpenAIResponsesEventName(eventName, chunk);
  if (OPENAI_RESPONSES_TERMINAL_EVENTS.has(type)) return true;
  const status = chunk?.response?.status;
  return status === "completed" || status === "failed";
}

const sharedEncoder = new TextEncoder();

// Encoded response.failed + [DONE] payload for aborted/stalled Responses passthrough streams
export function buildAbortedResponsesTerminalBytes() {
  return sharedEncoder.encode(`${formatIncompleteOpenAIResponsesStreamFailure()}data: [DONE]\n\n`);
}

// Synthesize a response.failed event for streams that close without a terminal event
export function formatIncompleteOpenAIResponsesStreamFailure() {
  return formatSSE({
    event: "response.failed",
    data: {
      type: "response.failed",
      response: {
        id: `resp_${Date.now()}`,
        status: "failed",
        error: {
          type: "stream_error",
          code: "stream_disconnected",
          message: "stream closed before response.completed"
        }
      }
    }
  }, FORMATS.OPENAI_RESPONSES);
}

/**
 * Announce a context-window overflow the way Codex expects it.
 *
 * Codex only recognises `context_length_exceeded` inside an SSE `response.failed`
 * event (codex-api/src/sse/responses.rs -> is_context_window_error). The same
 * error delivered as an HTTP 400 JSON body is mapped to a generic
 * InvalidRequest, which `is_retryable()` answers false for, so the turn dies
 * with a generic error. This frame preserves the error classification, but does
 * not itself make Codex compact and retry; automatic compaction uses usage.
 *
 * The frame carries no assistant content so errors cannot pollute model history.
 */
export function buildContextOverflowResponsesFrame(message, { id = null } = {}) {
  return formatSSE({
    event: "response.failed",
    data: {
      type: "response.failed",
      response: {
        id: id || `resp_${Date.now()}`,
        status: "failed",
        error: {
          type: "invalid_request_error",
          code: CODEX_ERROR_CODES.CONTEXT_LENGTH_EXCEEDED,
          message,
        },
      },
    },
  }, FORMATS.OPENAI_RESPONSES);
}


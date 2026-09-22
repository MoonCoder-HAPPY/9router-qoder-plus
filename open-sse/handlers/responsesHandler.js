/**
 * Responses API Handler for Workers
 * Converts Chat Completions to Codex Responses API format
 */

import { handleChatCore } from "./chatCore.js";
import { convertResponsesApiFormat } from "../translator/formats/responsesApi.js";
import { convertResponsesStreamToJson } from "../transformer/streamToJsonConverter.js";
import { SSE_HEADERS_CORS } from "../utils/sseConstants.js";
import { createErrorResult } from "../utils/error.js";

/**
 * Handle /v1/responses request
 * @param {object} options
 * @param {object} options.body - Request body (Responses API format)
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {object} options.log - Logger instance (optional)
 * @param {function} options.onCredentialsRefreshed - Callback when credentials are refreshed
 * @param {function} options.onRequestSuccess - Callback when request succeeds
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @returns {Promise<{success: boolean, response?: Response, status?: number, error?: string}>}
 */
export async function handleResponsesCore({ body, modelInfo, credentials, log, onCredentialsRefreshed, onRequestSuccess, onDisconnect, connectionId }) {
  // Convert Responses API format to Chat Completions format
  const convertedBody = convertResponsesApiFormat(body);

  // Preserve client's stream preference (matches OpenClaw behavior)
  // Default to false if omitted: Boolean(undefined) = false
  const clientRequestedStreaming = convertedBody.stream === true;
  if (convertedBody.stream === undefined) {
    convertedBody.stream = false;
  }

  // Call chat core handler — force sourceFormat so streaming path knows this is a Responses API client
  const result = await handleChatCore({
    body: convertedBody,
    modelInfo,
    credentials,
    log,
    onCredentialsRefreshed,
    onRequestSuccess,
    onDisconnect,
    connectionId,
    sourceFormatOverride: "openai-responses"
  });

  if (!result.success || !result.response) {
    return result;
  }

  const response = result.response;
  const contentType = response.headers.get("Content-Type") || "";

  // Case 1: Client wants non-streaming, but got SSE (provider forced it, e.g., Codex)
  if (!clientRequestedStreaming && contentType.includes("text/event-stream")) {
    try {
      const jsonResponse = await convertResponsesStreamToJson(response.body);

      if (jsonResponse.status === "failed") {
        return createErrorResult(
          502,
          jsonResponse.error?.message || "Upstream Responses stream failed",
        );
      }

      return {
        success: true,
        response: new Response(JSON.stringify(jsonResponse), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*"
          }
        })
      };
    } catch (error) {
      console.error("[Responses API] Stream-to-JSON conversion failed:", error);
      return {
        success: false,
        status: 500,
        error: "Failed to convert streaming response to JSON"
      };
    }
  }

  // Case 2: Client wants streaming, got SSE. handleChatCore already receives
  // sourceFormat=openai-responses and therefore emits the final Responses SSE
  // format through its normal translator pipeline. Applying the legacy
  // Chat-Completions transformer here a second time discards Responses events
  // (including response.failed) and its flush() fabricates response.completed.
  if (clientRequestedStreaming && contentType.includes("text/event-stream")) {
    return {
      success: true,
      response: new Response(response.body, {
        status: 200,
        headers: { ...SSE_HEADERS_CORS }
      })
    };
  }

  // Case 3: Non-SSE response (error or non-streaming from provider) - return as-is
  return result;
}


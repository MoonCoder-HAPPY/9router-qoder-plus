/**
 * Pre-flight rejections for features this router does not implement.
 *
 * Codex sends `previous_response_id` when it wants the server to continue a
 * stored response. We are stateless (and Codex talks to us with `store: false`),
 * so silently ignoring the field would make the client believe it resumed a
 * conversation it did not resume. Answer explicitly instead.
 */

import { CODEX_ERROR_CODES } from "../config/errorConfig.js";

export function unsupportedPreviousResponseIdError(body, provider = null) {
  const previousId = body?.previous_response_id;
  if (typeof previousId !== "string" || !previousId.trim()) return null;
  if (provider === "codex" || provider === "openai") return null; // pass-through providers keep their own semantics
  return {
    status: 400,
    code: CODEX_ERROR_CODES.INVALID_PROMPT,
    message:
      "previous_response_id is not supported by this endpoint: 9router keeps no server-side response state. " +
      "Send the full conversation in `input` instead of resuming by id.",
  };
}
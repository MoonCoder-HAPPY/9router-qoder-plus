import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import { extractUsage, mergeUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE } from "./streamHelpers.js";
import { getOpenAIResponsesEventName, isOpenAIResponsesTerminalEvent, formatIncompleteOpenAIResponsesStreamFailure } from "./responsesStreamHelpers.js";
import { dbg, isDebugEnabled } from "./debugLog.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";

import { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER } from "./sseConstants.js";

export { COLORS, formatSSE };
export { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

function isStreamFailureChunk(chunk, eventName = null) {
  if (!chunk || typeof chunk !== "object") return false;
  const event = eventName || chunk.type || chunk.event;
  const data = chunk.data && typeof chunk.data === "object" ? chunk.data : chunk;
  return Boolean(
    chunk.error ||
    event === "error" ||
    event === "response.failed" ||
    data.status === "failed" ||
    data.response?.status === "failed" ||
    data.response?.error,
  );
}

function hasPassthroughTerminal(chunk) {
  if (!chunk || typeof chunk !== "object") return false;
  return Boolean(
    chunk.choices?.some?.((choice) => choice?.finish_reason) ||
    chunk.candidates?.some?.((candidate) => candidate?.finishReason) ||
    chunk.type === "message_stop" ||
    chunk.type === "response.completed" ||
    chunk.type === "response.done" ||
    chunk.response?.status === "completed" ||
    chunk.done === true,
  );
}

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null
  } = options;

  let buffer = "";
  let usage = null;

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE
    ? { ...initState(sourceFormat), provider, toolNameMap, model, requestBody: body }
    : null;

  let totalContentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let ttftAt = null;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};

  // Track Responses API event framing for same-format passthrough (codex)
  let currentOpenAIResponsesEvent = null;
  let openAIResponsesTerminalSeen = false;
  let openAIResponsesDoneSent = false;
  let streamDoneSent = false;  // track duplicate [DONE] across transform + flush
  let passthroughTerminalSeen = false;
  let streamFailureFrameSent = false;
  let completionRecorded = false;  // ensure usage/content is recorded exactly once (flush OR abort)
  let requestLogRecorded = false;
  let streamFailed = false;

  // Record whatever usage/content has accumulated so far. Called by flush() on a
  // normal stream end, and by the disconnect/abort path when the client goes away
  // mid-stream — otherwise the tokens from an aborted response are silently lost.
  const recordCompletion = (completed = true) => {
    if (completionRecorded) return;
    completionRecorded = true;
    const finalUsage = mode === STREAM_MODE.TRANSLATE ? state?.usage : usage;
    if (onStreamComplete) {
      onStreamComplete({
        content: accumulatedContent,
        thinking: accumulatedThinking
      }, finalUsage, ttftAt, { completed });
    }
    if (!requestLogRecorded) {
      requestLogRecorded = true;
      appendRequestLog({
        model,
        provider,
        connectionId,
        tokens: hasValidUsage(finalUsage) ? finalUsage : null,
        status: completed ? "200 OK" : `FAILED ${HTTP_STATUS.BAD_GATEWAY}`,
      }).catch(() => { });
    }
  };

  const stream = new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (streamDoneSent) continue;
        if (isDebugEnabled && trimmed) {
          sseLineCount++;
          if (trimmed.startsWith("event:")) {
            const evt = trimmed.slice(6).trim();
            eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
          }
        }

        // Capture Responses API event name to preserve framing in same-format passthrough
        if (mode === STREAM_MODE.TRANSLATE && targetFormat === FORMATS.OPENAI_RESPONSES && trimmed.startsWith("event:")) {
          currentOpenAIResponsesEvent = trimmed.slice(6).trim();
        }

        // Passthrough mode: normalize and forward
        if (mode === STREAM_MODE.PASSTHROUGH) {
          let output;
          let injectedUsage = false;

          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() === "[DONE]") {
            if (!passthroughTerminalSeen && !streamFailureFrameSent) {
              streamFailed = true;
              streamFailureFrameSent = true;
              const failureOutput = `data: ${JSON.stringify({
                error: {
                  type: "stream_error",
                  code: "stream_disconnected",
                  message: "SSE stream sent [DONE] before a terminal chunk",
                },
              })}\n\n`;
              reqLogger?.appendConvertedChunk?.(failureOutput);
              controller.enqueue(sharedEncoder.encode(failureOutput));
            }
            streamDoneSent = true;
          }

          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() !== "[DONE]") {
            try {
              const parsed = JSON.parse(trimmed.slice(5).trim());

              const parsedFailure = isStreamFailureChunk(parsed);
              const terminalAlreadySeen = passthroughTerminalSeen;
              if (parsedFailure && terminalAlreadySeen) {
                continue;
              }
              if (parsedFailure) {
                streamFailed = true;
                streamFailureFrameSent = true;
              }
              if (hasPassthroughTerminal(parsed)) passthroughTerminalSeen = true;

              const idFixed = fixInvalidId(parsed);

              // Ensure OpenAI-required fields are present on streaming chunks (Letta compat)
              let fieldsInjected = false;
              if (parsed.choices !== undefined) {
                if (!parsed.object) { parsed.object = "chat.completion.chunk"; fieldsInjected = true; }
                if (!parsed.created) { parsed.created = Math.floor(Date.now() / 1000); fieldsInjected = true; }
              }

              // Strip Azure-specific non-standard fields from streaming chunks
              if (parsed.prompt_filter_results !== undefined) {
                delete parsed.prompt_filter_results;
                fieldsInjected = true;
              }
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.content_filter_results !== undefined) {
                    delete choice.content_filter_results;
                    fieldsInjected = true;
                  }
                }
              }

              // Strip empty tool_calls arrays that break AI SDK reasoning tracking.
              // Some providers (e.g. CodeBuddy CN) include `"tool_calls": []` in
              // every streaming delta. @ai-sdk/openai-compatible checks
              // `delta.tool_calls != null` — an empty array passes this check,
              // causing premature `reasoning-end` on every chunk.
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length === 0) {
                    delete choice.delta.tool_calls;
                    fieldsInjected = true;
                  }
                }
              }

              if (!parsedFailure && !hasValuableContent(parsed, FORMATS.OPENAI)) {
                continue;
              }

              if (parsedFailure) {
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              }

              const delta = parsed.choices?.[0]?.delta;
              const content = delta?.content;
              const reasoning = delta?.reasoning_content;
              if (content && typeof content === "string") {
                totalContentLength += content.length;
                accumulatedContent += content;
              }
              if (reasoning && typeof reasoning === "string") {
                totalContentLength += reasoning.length;
                accumulatedThinking += reasoning;
              }

              const extracted = extractUsage(parsed);
              if (extracted) {
                usage = mergeUsage(usage, extracted);
              }

              const isFinishChunk = parsed.choices?.[0]?.finish_reason;
              if (!parsedFailure && isFinishChunk && !hasValidUsage(parsed.usage)) {
                const estimated = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
                parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                usage = estimated;
                injectedUsage = true;
              } else if (!parsedFailure && isFinishChunk && usage) {
                const buffered = addBufferToUsage(usage);
                parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              } else if (idFixed || fieldsInjected) {
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              }
            } catch {
              // Skip non-JSON data lines silently — don't forward garbage to clients.
              // Upstream providers sometimes return plain-text errors (HTML, rate-limit
              // messages) in the SSE stream that would break downstream JSON decoders.
              continue;
            }
          }

          if (!injectedUsage) {
            if (line.startsWith("data:") && !line.startsWith("data: ")) {
              output = "data: " + line.slice(5) + "\n";
            } else {
              output = line + "\n";
            }
          }

          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          continue;
        }

        // Translate mode
        if (!trimmed) continue;

        const parsed = parseSSELine(trimmed, targetFormat);
        if (!parsed) continue;

        // Responses API same-format passthrough: preserve event framing + track terminal state
        const isOpenAIResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
        const keepsOpenAIResponsesFormat = isOpenAIResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
        const openAIResponsesEventName = isOpenAIResponsesStream
          ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
          : null;

        const parsedFailure = isStreamFailureChunk(parsed, openAIResponsesEventName);
        const terminalAlreadySeen = openAIResponsesTerminalSeen || state?.responseCompleted;
        if (parsedFailure && terminalAlreadySeen) {
          currentOpenAIResponsesEvent = null;
          continue;
        }
        if (parsedFailure) {
          streamFailed = true;
        }

        const translatedChunk = isOpenAIResponsesStream && openAIResponsesEventName && !parsed.type && !parsed.event
          ? { ...parsed, type: openAIResponsesEventName }
          : parsed;

        if (isOpenAIResponsesStream && isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed)) {
          openAIResponsesTerminalSeen = true;
        }

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
        // For other formats: done=true is the [DONE] sentinel, skip
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          // Chat usage trailers precede [DONE]. Do not wait for socket EOF to
          // finish a Responses turn: some upstreams keep that socket alive.
          if (sourceFormat === FORMATS.OPENAI_RESPONSES && !keepsOpenAIResponsesFormat && !streamDoneSent) {
            for (const item of translateResponse(targetFormat, sourceFormat, null, state) || []) {
              if (!item) continue;
              const output = formatSSE(item, sourceFormat);
              reqLogger?.appendConvertedChunk?.(output);
              controller.enqueue(sharedEncoder.encode(output));
              sseEmittedCount++;
            }
            if (sourceFormat === FORMATS.OPENAI_RESPONSES && !streamDoneSent) {
              const doneOutput = "data: [DONE]\n\n";
              reqLogger?.appendConvertedChunk?.(doneOutput);
              controller.enqueue(sharedEncoder.encode(doneOutput));
              streamDoneSent = true;
            }
          }
          // Synthesize response.failed if the Responses stream never sent a terminal event
          if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
            streamFailed = true;
            const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
            reqLogger?.appendConvertedChunk?.(failedOutput);
            controller.enqueue(sharedEncoder.encode(failedOutput));
            openAIResponsesTerminalSeen = true;
            sseEmittedCount++;
          }

          if (keepsOpenAIResponsesFormat && !streamDoneSent) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }
          streamDoneSent = true;
          if (keepsOpenAIResponsesFormat) openAIResponsesDoneSent = true;
          continue;
        }

        // Claude format - content
        if (parsed.delta?.text) {
          totalContentLength += parsed.delta.text.length;
          accumulatedContent += parsed.delta.text;
        }
        // Claude format - thinking
        if (parsed.delta?.thinking) {
          totalContentLength += parsed.delta.thinking.length;
          accumulatedThinking += parsed.delta.thinking;
        }
        
        // OpenAI format - content
        if (parsed.choices?.[0]?.delta?.content) {
          totalContentLength += parsed.choices[0].delta.content.length;
          accumulatedContent += parsed.choices[0].delta.content;
        }
        // OpenAI format - reasoning
        if (parsed.choices?.[0]?.delta?.reasoning_content) {
          totalContentLength += parsed.choices[0].delta.reasoning_content.length;
          accumulatedThinking += parsed.choices[0].delta.reasoning_content;
        }
        
        // Gemini format
        if (parsed.candidates?.[0]?.content?.parts) {
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text && typeof part.text === "string") {
              totalContentLength += part.text.length;
              // Check if this is thinking content
              if (part.thought === true) {
                accumulatedThinking += part.text;
              } else {
                accumulatedContent += part.text;
              }
            }
          }
        }

        // Extract usage
        const extracted = extractUsage(parsed);
        if (extracted) state.usage = mergeUsage(state.usage, extracted); // Keep original usage for logging

        // Responses same-format passthrough: re-emit with original event framing
        if (keepsOpenAIResponsesFormat && openAIResponsesEventName) {
          const output = formatSSE({ event: openAIResponsesEventName, data: parsed }, sourceFormat);
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          currentOpenAIResponsesEvent = null;
          sseEmittedCount++;
          continue;
        }

        currentOpenAIResponsesEvent = null;

        // Translate: targetFormat -> openai -> sourceFormat
        const translated = translateResponse(targetFormat, sourceFormat, translatedChunk, state);

          if (state?.responseFailed || state?.responsesFailed || state?.error || translated?.some?.((item) => isStreamFailureChunk(item))) {
            streamFailed = true;
          }

        // Log OpenAI intermediate chunks (if available)
        if (translated?._openaiIntermediate) {
          for (const item of translated._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (translated?.length > 0) {
          for (const item of translated) {
            if (item === null || item === undefined) continue;
            // Filter empty chunks
            if (!hasValuableContent(item, sourceFormat)) {
              continue; // Skip this empty chunk
            }

            // Inject estimated usage if finish chunk has no valid usage
            const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;
            if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && totalContentLength > 0) {
              const estimated = estimateUsage(body, totalContentLength, sourceFormat);
              item.usage = filterUsageForFormat(estimated, sourceFormat); // Filter + already has buffer
              state.usage = estimated;
            } else if (state.finishReason && isFinishChunk && state.usage) {
              // Add buffer and filter usage for client (but keep original in state.usage for logging)
              const buffered = addBufferToUsage(state.usage);
              item.usage = filterUsageForFormat(buffered, sourceFormat);
            }

            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
            sseEmittedCount++;
          }
        }
      }
    },

    flush(controller) {
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      dbg("SSE", `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`);
      trackPendingRequest(model, provider, connectionId, false);
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        if (mode === STREAM_MODE.PASSTHROUGH) {
          if (!streamFailed && !passthroughTerminalSeen) {
            streamFailed = true;
          }
          if (buffer) {
            let output = buffer;
            if (buffer.startsWith("data:") && !buffer.startsWith("data: ")) {
              output = "data: " + buffer.slice(5);
            }
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }

          if (!hasValidUsage(usage) && totalContentLength > 0) {
            usage = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
          }

          if (hasValidUsage(usage)) {
            logUsage(provider, usage, model, connectionId, apiKey);
          }
          // IMPORTANT: In passthrough mode we still must terminate the SSE stream.
          // Some clients (e.g. OpenClaw) expect the OpenAI-style sentinel:
          //   data: [DONE]\n\n
          // Without it they can hang until timeout and trigger failover.
          // Gemini-family clients (Antigravity, Vertex, Gemini) reject this sentinel with 400 syntax errors.
          const isGeminiFamily = provider === "antigravity" || provider === "gemini" || provider === "vertex";
          if (!streamDoneSent && !isGeminiFamily) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }

          recordCompletion(!streamFailed);
          return;
        }

        if (buffer.trim()) {
          // A final SSE event may be buffered without the terminating blank
          // line. Preserve an event: field that shares the buffer with its
          // data: line; otherwise Responses terminal events are emitted as
          // ordinary data and the flush below synthesizes a false failure.
          const trailingLines = buffer.split(/\r?\n/);
          let trailingDataLine = null;
          for (const trailingLine of trailingLines) {
            const trimmedLine = trailingLine.trim();
            if (trimmedLine.startsWith("event:")) {
              currentOpenAIResponsesEvent = trimmedLine.slice(6).trim();
            } else if (trimmedLine.startsWith("data:")) {
              trailingDataLine = trimmedLine;
            }
          }
          if (trailingDataLine) buffer = trailingDataLine;

          const parsed = parseSSELine(buffer.trim(), targetFormat);
          if (parsed && !parsed.done) {
            const isTrailingResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
            const keepsTrailingResponsesFormat = isTrailingResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
            const trailingEventName = isTrailingResponsesStream
              ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
              : null;
            const trailingChunk = isTrailingResponsesStream && trailingEventName && !parsed.type && !parsed.event
              ? { ...parsed, type: trailingEventName }
              : parsed;
            const trailingFailure = isStreamFailureChunk(trailingChunk, trailingEventName);
            const trailingAlreadyTerminal = openAIResponsesTerminalSeen || state?.responseCompleted;
            if (trailingFailure && trailingAlreadyTerminal) {
              currentOpenAIResponsesEvent = null;
            } else {
              if (trailingFailure) streamFailed = true;
              if (isTrailingResponsesStream && isOpenAIResponsesTerminalEvent(trailingEventName, trailingChunk)) {
                openAIResponsesTerminalSeen = true;
              }

              const translated = translateResponse(targetFormat, sourceFormat, trailingChunk, state);

              if (state?.responseFailed || state?.responsesFailed || state?.error || translated?.some?.((item) => isStreamFailureChunk(item))) {
                streamFailed = true;
              }

              if (translated?._openaiIntermediate) {
                for (const item of translated._openaiIntermediate) {
                  const openaiOutput = formatSSE(item, FORMATS.OPENAI);
                  reqLogger?.appendOpenAIChunk?.(openaiOutput);
                }
              }

              if (translated?.length > 0) {
                for (const item of translated) {
                  if (item === null || item === undefined) continue;
                  const output = keepsTrailingResponsesFormat && trailingEventName
                    ? formatSSE({ event: trailingEventName, data: item }, sourceFormat)
                    : formatSSE(item, sourceFormat);
                  reqLogger?.appendConvertedChunk?.(output);
                  controller.enqueue(sharedEncoder.encode(output));
                }
              }
            }
            currentOpenAIResponsesEvent = null;
          }
        }

        const flushed = translateResponse(targetFormat, sourceFormat, null, state);

        if (state?.responseFailed || state?.responsesFailed || state?.error || flushed?.some?.((item) => isStreamFailureChunk(item))) {
          streamFailed = true;
        }

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            if (item === null || item === undefined) continue;
            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }
        }

        // Synthesize response.failed if a Responses passthrough stream never reached a terminal event
        const keepsOpenAIResponsesFormat = targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat === FORMATS.OPENAI_RESPONSES;
        if (!keepsOpenAIResponsesFormat && !streamFailed && !state?.finishReason && !state?.responseCompleted && !state?.completedSent) {
          streamFailed = true;
        }
        if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
          streamFailed = true;
          const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
          reqLogger?.appendConvertedChunk?.(failedOutput);
          controller.enqueue(sharedEncoder.encode(failedOutput));
          openAIResponsesTerminalSeen = true;
        }

        if (keepsOpenAIResponsesFormat && !openAIResponsesDoneSent && !streamDoneSent) {
          const doneOutput = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(doneOutput);
          controller.enqueue(sharedEncoder.encode(doneOutput));
          openAIResponsesDoneSent = true;
          streamDoneSent = true;
        }

        if (!hasValidUsage(state?.usage) && totalContentLength > 0) {
          state.usage = estimateUsage(body, totalContentLength, sourceFormat);
        }

        if (hasValidUsage(state?.usage)) {
          logUsage(state.provider || targetFormat, state.usage, model, connectionId, apiKey);
        }
        recordCompletion(!streamFailed);
      } catch (error) {
        console.log("Error in flush:", error);
        // A flush-time translator failure is not a successful EOF. Persist the
        // partial usage as failed, then rethrow so streamHandler can terminate
        // the client stream through its normal error path.
        streamFailed = true;
        recordCompletion(false);
        throw error;
      }
    }
  });

  // Expose a manual flush so the disconnect path can persist partial usage for
  // responses that never reach a normal stream end (client closed mid-stream).
  stream.flushPartialUsage = (completed = false) => recordCompletion(completed === true);
  stream.hasTerminal = () => (
    (
      targetFormat === FORMATS.OPENAI_RESPONSES &&
      sourceFormat === FORMATS.OPENAI_RESPONSES &&
      (openAIResponsesTerminalSeen || streamDoneSent)
    ) || (
      mode === STREAM_MODE.PASSTHROUGH &&
      (passthroughTerminalSeen || streamDoneSent)
    )
  );
  return stream;
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    provider,
    reqLogger,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey
  });
}

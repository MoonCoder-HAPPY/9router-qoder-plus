const COMPACTION_PREFIX = "9router:qoder-compact:v1:";

export const QODER_COMPACTION_PROMPT = [
  "Create a compact continuation summary of the conversation above.",
  "Preserve the user's goals, requirements, decisions, constraints, current progress, relevant files and symbols, command results, unresolved errors, and exact next steps.",
  "Do not call tools. Return only the summary, with no preamble or commentary.",
].join(" ");

export function isQoderCompactionRequest(body) {
  if (body?._compact === true) return true;
  return Array.isArray(body?.input)
    && body.input.some((item) => item?.type === "compaction_trigger");
}

export function buildQoderCompactionContent({ summary, model = null, now = Date.now() } = {}) {
  const payload = {
    v: 1,
    model: model ? String(model) : null,
    created_at: Number(now),
    summary: String(summary ?? ""),
  };
  return `${COMPACTION_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

export function parseQoderCompactionContent(value) {
  if (typeof value !== "string" || !value.startsWith(COMPACTION_PREFIX)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(value.slice(COMPACTION_PREFIX.length), "base64url").toString("utf8"),
    );
    if (payload?.v !== 1 || typeof payload.summary !== "string" || !payload.summary.trim()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export const QODER_COMPACTION_CONTENT_PREFIX = COMPACTION_PREFIX;

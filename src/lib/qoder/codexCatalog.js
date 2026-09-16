/**
 * Codex model catalog.
 *
 * Codex ignores the OpenAI-style `data[]` payload and looks for a `models[]`
 * array of `ModelInfo` objects (see codex-rs/protocol/src/openai_models.rs).
 * When that lookup fails, Codex silently falls back to a 272k-context profile
 * with no reasoning levels, which is what made long Qoder sessions compact too
 * late (or not at all). This module renders the same models we already publish
 * in `data[]` into the shape Codex understands.
 *
 * Only Codex-visible/public fields are emitted: never internal Qoder keys,
 * account e-mails or quota data (spec.md §11).
 */

// Relative import (not the "@/" alias) so this module also runs from plain Node, which is
// what scripts/codex-models-cache.mjs does when it generates a client catalog.
import { QODER_AUTO_COMPACT_TOKEN_LIMIT, QODER_CONTEXT_WINDOW } from "../../shared/services/codexCompat.js";

/** Tier aliases are callable but should not clutter the model picker. */
const HIDDEN_SLUGS = new Set(["auto", "ultimate", "performance", "efficient", "lite"]);

// Codex refuses a whole model-catalog entry whose model carries neither
// `base_instructions` nor `model_messages.instructions_template` (runtime check,
// not a serde default), so every entry ships an explicit template.
const BASE_INSTRUCTIONS_TEMPLATE =
  "You are a coding agent. Follow the user's instructions, use the provided tools when they help, and answer concisely.";

// ModelMessages has only two fields with serde defaults, so the remaining optional
// fields must be present (null is fine) for deserialization to succeed.
const MODEL_MESSAGES = Object.freeze({
  persistent_instructions: null,
  tools: null,
  instructions_template: BASE_INSTRUCTIONS_TEMPLATE,
  instructions_variables: null,
  approvals: null,
  collaboration_modes: null,
  auto_review: null,
  permissions: null,
  multi_agent: null,
  token_budget: null,
  confirmation_policies: null,
  guardian_v2: null,
});
const REASONING_LEVELS = [
  { effort: "low", description: "Fast, minimal deliberation" },
  { effort: "medium", description: "Balanced deliberation" },
  { effort: "high", description: "Deep deliberation" },
];

function cleanSlug(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the Codex `models[]` entries for the Qoder models present in `data`.
 * Entries from other providers are ignored: their metadata is not ours to
 * describe, and Codex only needs the catalog for the provider it talks to.
 */
export function buildCodexCatalogEntries(models, options = {}) {
  const { defaultVisibility = "list" } = options;
  const out = [];
  const seen = new Set();

  for (const model of Array.isArray(models) ? models : []) {
    if (!model || typeof model !== "object") continue;
    if (model.owned_by !== "qoder") continue;
    const slug = cleanSlug(model.id);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    // Every Qoder model is described with the same window + compaction line.
    // The upstream catalog reports a different (and inconsistent) window per
    // model - 180k for models that happily serve 1M - and Codex compacts as soon
    // as EITHER the compaction limit OR the advertised window is reached, so a
    // stale 180k window would silently cap the session 5x below what works.
    const contextWindow = QODER_CONTEXT_WINDOW;
    const maxOutput = Number(model.capabilities?.maxOutput);

    const vision = model.capabilities?.vision === true;
    const reasoner = model.capabilities?.reasoning === true;

    out.push({
      slug,
      display_name: cleanSlug(model.name) || slug,
      description: null,
      default_reasoning_level: reasoner ? "high" : null,
      supported_reasoning_levels: reasoner ? REASONING_LEVELS.map((level) => ({ ...level })) : [],
      shell_type: "unified_exec",
      visibility: HIDDEN_SLUGS.has(slug.toLowerCase()) ? "hide" : defaultVisibility,
      supported_in_api: true,
      priority: 1,
      additional_speed_tiers: [],
      service_tiers: [],
      default_service_tier: null,
      available_access_programs: null,
      availability_nux: null,
      upgrade: null,
      model_messages: { ...MODEL_MESSAGES },
      include_skills_usage_instructions: false,
      include_plugin_usage_instructions: false,
      include_apps_usage_instructions: false,
      supports_reasoning_summary_parameter: true,
      default_reasoning_summary: "detailed",
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      web_search_tool_type: "text",
      truncation_policy: { mode: "bytes", limit: 10000 },
      supports_image_detail_original: false,
      context_window: contextWindow,
      max_context_window: contextWindow,
      auto_compact_token_limit: QODER_AUTO_COMPACT_TOKEN_LIMIT,
      comp_hash: null,
      effective_context_window_percent: 100,
      experimental_supported_tools: [],
      input_modalities: vision ? ["text", "image"] : ["text"],
      supports_search_tool: false,
      supports_experimental_context: false,
      use_responses_lite: false,
      node_repl_auto_review_required: false,
      node_repl_disabled: false,
      auto_review_model_override: null,
      model_specialty: null,
      tool_mode: null,
      multi_agent_version: null,
      multi_agent_reasoning_effort: null,
      ...(Number.isFinite(maxOutput) && maxOutput > 0 ? { max_output_tokens: maxOutput } : {}),
    });
  }

  return out;
}
/**
 * Wrap a Codex model catalog in the on-disk cache envelope the client reads
 * (`~/.codex/models_cache.json`).
 *
 * Why this exists: Codex does not call `GET /v1/models` for a custom provider —
 * it loads this file and validates it (client version must match, the entry is
 * only fresh for 300s, and every model needs an instruction template). Seeding
 * the file is what actually gets a custom provider's real context window,
 * compaction threshold and reasoning levels into the client.
 */
export const CODEX_MODELS_CACHE_TTL_MS = 300 * 1000;

export function buildCodexModelsCache(models, { clientVersion, now = Date.now(), etag = null } = {}) {
  const entries = Array.isArray(models) ? models.filter((model) => model && model.slug) : [];
  if (!clientVersion) {
    throw new Error("clientVersion is required: Codex rejects a cache whose client_version does not match its own build");
  }
  return {
    fetched_at: new Date(now).toISOString(),
    ...(etag ? { etag } : {}),
    client_version: String(clientVersion),
    models: entries,
  };
}

/** True when a cache written at `fetchedAt` is still usable by the client. */
export function isCodexModelsCacheFresh(fetchedAt, now = Date.now()) {
  const ts = Date.parse(String(fetchedAt || ""));
  if (!Number.isFinite(ts)) return false;
  return now - ts < CODEX_MODELS_CACHE_TTL_MS;
}
/**
 * Merge two catalogs, overriding by slug.
 *
 * `codex debug models` prints the catalog the client would use. Running it with a
 * config that has no `model_catalog_json` yields the *bundled* catalog (the OpenAI
 * models Codex itself relies on); merging our Qoder entries on top produces a
 * static catalog that is a superset — which is what `model_catalog_json` needs,
 * because that key replaces the bundled catalog rather than extending it.
 */
export function mergeCodexCatalogs(baseModels, overrideModels) {
  const merged = new Map();
  for (const model of Array.isArray(baseModels) ? baseModels : []) {
    if (model?.slug) merged.set(model.slug, model);
  }
  for (const model of Array.isArray(overrideModels) ? overrideModels : []) {
    if (model?.slug) merged.set(model.slug, model);
  }
  return [...merged.values()];
}

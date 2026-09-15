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

import { computeAutoCompactLimit } from "@/shared/services/codexCompat.js";

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

    const contextWindow = Number(model.capabilities?.contextWindow);
    const hasWindow = Number.isFinite(contextWindow) && contextWindow > 0;
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
      context_window: hasWindow ? contextWindow : null,
      max_context_window: hasWindow ? contextWindow : null,
      auto_compact_token_limit: hasWindow ? computeAutoCompactLimit(contextWindow) : null,
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
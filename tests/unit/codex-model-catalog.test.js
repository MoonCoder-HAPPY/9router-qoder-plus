import { describe, expect, it } from "vitest";

import { buildCodexCatalogEntries } from "../../src/lib/qoder/codexCatalog.js";

// Fields Codex's ModelInfo deserializer requires (nullable ones must be present).
const REQUIRED_KEYS = [
  "slug", "display_name", "description", "default_reasoning_level", "supported_reasoning_levels",
  "shell_type", "visibility", "supported_in_api", "priority", "additional_speed_tiers", "service_tiers",
  "default_service_tier", "available_access_programs", "availability_nux", "upgrade", "model_messages",
  "include_skills_usage_instructions", "include_plugin_usage_instructions", "include_apps_usage_instructions",
  "supports_reasoning_summary_parameter", "default_reasoning_summary", "support_verbosity", "default_verbosity",
  "apply_patch_tool_type", "web_search_tool_type", "truncation_policy", "supports_image_detail_original",
  "context_window", "max_context_window", "auto_compact_token_limit", "comp_hash",
  "effective_context_window_percent", "experimental_supported_tools", "input_modalities", "supports_search_tool",
  "supports_experimental_context", "use_responses_lite", "node_repl_auto_review_required", "node_repl_disabled",
  "auto_review_model_override", "model_specialty", "tool_mode", "multi_agent_version", "multi_agent_reasoning_effort",
];

const data = [
  { id: "DeepSeek-Flash", name: "DeepSeek-Flash", owned_by: "qoder", capabilities: { contextWindow: 1000000, maxOutput: 64000, reasoning: true, vision: true } },
  { id: "Lite", name: "Lite", owned_by: "qoder", capabilities: { contextWindow: 200000, maxOutput: 64000, reasoning: false, vision: false } },
  { id: "Auto", name: "Auto", owned_by: "qoder", capabilities: { contextWindow: 200000, maxOutput: 64000, reasoning: false, vision: false } },
  { id: "gpt-5.6", name: "gpt-5.6", owned_by: "openai", capabilities: { contextWindow: 400000 } },
];

describe("Codex model catalog contract", () => {
  const models = buildCodexCatalogEntries(data);

  it("only describes qoder models and drops non-qoder entries", () => {
    expect(models.map((m) => m.slug)).toEqual(["DeepSeek-Flash", "Lite", "Auto"]);
  });

  it("ships the instruction template Codex validates at load time", () => {
    for (const model of models) {
      expect(typeof model.model_messages?.instructions_template, `${model.slug} instructions`).toBe("string");
      expect(model.model_messages.instructions_template.length).toBeGreaterThan(20);
      // ModelMessages fields without serde defaults must be present.
      for (const key of [
        "persistent_instructions", "tools", "instructions_template", "instructions_variables",
        "approvals", "collaboration_modes", "auto_review", "permissions", "multi_agent",
        "token_budget", "confirmation_policies", "guardian_v2",
      ]) {
        expect(model.model_messages, `${model.slug} model_messages.${key}`).toHaveProperty(key);
      }
    }
  });

  it("emits every ModelInfo field Codex requires", () => {
    for (const model of models) {
      for (const key of REQUIRED_KEYS) expect(model, `${model.slug} missing ${key}`).toHaveProperty(key);
    }
  });

  it("advertises the real window and a compact threshold below it", () => {
    const flash = models.find((m) => m.slug === "DeepSeek-Flash");
    expect(flash.context_window).toBe(1000000);
    expect(flash.max_context_window).toBe(1000000);
    expect(flash.auto_compact_token_limit).toBe(500000);
    expect(flash.effective_context_window_percent).toBe(100);
  });

  it("maps reasoning and vision per model", () => {
    const flash = models.find((m) => m.slug === "DeepSeek-Flash");
    expect(flash.supports_reasoning_summary_parameter).toBe(true);
    expect(flash.default_reasoning_summary).toBe("detailed");
    expect(flash.supported_reasoning_levels.map((l) => l.effort)).toEqual(["low", "medium", "high"]);
    expect(flash.default_reasoning_level).toBe("high");
    expect(flash.input_modalities).toEqual(["text", "image"]);

    const lite = models.find((m) => m.slug === "Lite");
    expect(lite.input_modalities).toEqual(["text"]);
    expect(lite.supported_reasoning_levels).toEqual([]);
    expect(lite.default_reasoning_level).toBeNull();
  });

  it("hides tier aliases but keeps concrete models listed", () => {
    expect(models.find((m) => m.slug === "Auto").visibility).toBe("hide");
    expect(models.find((m) => m.slug === "DeepSeek-Flash").visibility).toBe("list");
  });

  it("never leaks internal identifiers or credentials", () => {
    const json = JSON.stringify(models);
    expect(json).not.toMatch(/qmodel|dfmodel|dmodel|internalId/i);
    expect(json).not.toContain("@");
  });

  it("returns an empty catalog when there are no qoder models", () => {
    expect(buildCodexCatalogEntries([])).toEqual([]);
    expect(buildCodexCatalogEntries(null)).toEqual([]);
  });
});
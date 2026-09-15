#!/usr/bin/env node
/**
 * Seed the Codex model cache so a custom provider gets real model metadata.
 *
 * Codex does not fetch `GET /v1/models` for a custom provider: it reads
 * `~/.codex/models_cache.json` (valid for 300s, keyed by client version) and
 * falls back to a 272k-context profile when the file is missing or stale —
 * which is what makes long sessions compact too late and hides reasoning.
 *
 * Usage:
 *   node scripts/codex-models-cache.mjs --base http://127.0.0.1:20128 --key sk-...
 *   node scripts/codex-models-cache.mjs --base ... --key ... --client-version 0.154.0 --out ~/.codex/models_cache.json
 *
 * Re-run it whenever the cache has expired (e.g. from a shell alias, a cron
 * entry every few minutes, or a wrapper that starts Codex).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mergeCodexCatalogs } from "../src/lib/qoder/codexCatalog.js";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const [key, value] = process.argv[i].replace(/^--/, "").split("=");
  args.set(key, value ?? process.argv[++i]);
}

const base = (args.get("base") || process.env.NINER_BASE || "http://127.0.0.1:20128").replace(/\/$/, "");
const apiKey = args.get("key") || process.env.NINER_KEY || "";
const catalogOut = args.get("catalog-out") ? resolve(args.get("catalog-out").replace(/^~(?=\/)/, homedir())) : null;
const mergeBundled = args.has("merge-bundled");
const out = resolve((args.get("out") || `${homedir()}/.codex/models_cache.json`).replace(/^~(?=\/)/, homedir()));
if (!apiKey) {
  console.error("missing --key (or NINER_KEY)");
  process.exit(2);
}

const detectClientVersion = () => {
  const explicit = args.get("client-version");
  if (explicit) return explicit;
  const cachePath = resolve(`${homedir()}/.codex/models_cache.json`);
  try {
    const existing = JSON.parse(execFileSync("cat", [cachePath], { encoding: "utf8" }));
    if (existing?.client_version) return String(existing.client_version);
  } catch { /* no cache yet */ }
  try {
    return execFileSync("codex", ["--version"], { encoding: "utf8" }).trim().replace(/^codex-cli\s+/, "");
  } catch {
    console.error("could not detect the Codex client version: pass --client-version");
    process.exit(2);
  }
};

const response = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
if (!response.ok) {
  console.error(`GET ${base}/v1/models -> ${response.status} ${await response.text()}`.slice(0, 300));
  process.exit(1);
}
const payload = await response.json();
const models = Array.isArray(payload?.models) ? payload.models : [];
if (models.length === 0) {
  console.error("the endpoint returned no `models[]` catalog; is this build up to date?");
  process.exit(1);
}
const missingTemplate = models.filter((model) => !model?.model_messages?.instructions_template);
if (missingTemplate.length > 0) {
  console.error(`catalog is missing model_messages.instructions_template for: ${missingTemplate.map((m) => m.slug).join(", ")}`);
  process.exit(1);
}

/**
 * Read the client's bundled catalog (`codex debug models`) from a throwaway
 * CODEX_HOME so a `model_catalog_json` override in the real config cannot leak in.
 */
const readBundledCatalog = () => {
  const home = mkdtempSync(`${tmpdir()}/codex-bundled-`);
  try {
    writeFileSync(`${home}/config.toml`, 'approval_policy = "never"\n');
    const raw = execFileSync("codex", ["debug", "models"], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: home },
    });
    return JSON.parse(raw)?.models ?? [];
  } catch (error) {
    console.error(`could not read the bundled catalog (pass --no-merge-bundled to skip): ${error.message}`);
    process.exit(2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

if (catalogOut) {
  const ours = models;
  const bundled = mergeBundled ? readBundledCatalog() : [];
  const merged = mergeCodexCatalogs(bundled, ours);
  mkdirSync(dirname(catalogOut), { recursive: true });
  writeFileSync(catalogOut, `${JSON.stringify({ models: merged }, null, 2)}\n`);
  console.log(`wrote ${merged.length} models (${bundled.length} bundled + ${ours.length} router) to ${catalogOut}`);
  console.log(`add to config.toml:  model_catalog_json = "${catalogOut}"`);
  process.exit(0);
}
const cache = {
  fetched_at: new Date().toISOString(),
  client_version: detectClientVersion(),
  models,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(cache, null, 2)}\n`);
console.log(`wrote ${models.length} models to ${out} (client_version=${cache.client_version})`);
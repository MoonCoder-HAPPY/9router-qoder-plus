import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CODEX_COMPAT_DEFAULTS } from "../../src/shared/services/codexCompat.js";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-codex-compat-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  // Drop the module graph (and with it the sqlite handle) before removing the temp dir;
  // Windows keeps the file locked otherwise, and a leftover TEMP dir is harmless.
  vi.resetModules();
  delete global._dbAdapter;
  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* locked on Windows: ignore */
    }
  }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  vi.resetModules();
});

const load = async () => {
  const { getSettings, updateSettings } = await import("../../src/lib/localDb.js");
  return { getSettings, updateSettings };
};

describe("codexCompat persisted settings", () => {
  it("ships the documented defaults for a fresh install", async () => {
    const { getSettings } = await load();
    const settings = await getSettings();
    expect(settings.codexCompat).toEqual(CODEX_COMPAT_DEFAULTS);
  });

  it("keeps context policy fixed while persisting unrelated retry settings", async () => {
    const { getSettings, updateSettings } = await load();
    await updateSettings({
      codexCompat: { autoCompactRatio: 0.75, autoCompactMin: 200000, autoCompactMax: 400000, autoContinueMax: 0 },
    });
    let settings = await getSettings();
    expect(settings.codexCompat.autoCompactRatio).toBe(CODEX_COMPAT_DEFAULTS.autoCompactRatio);
    expect(settings.codexCompat.autoCompactMin).toBe(CODEX_COMPAT_DEFAULTS.autoCompactMin);
    expect(settings.codexCompat.autoCompactMax).toBe(CODEX_COMPAT_DEFAULTS.autoCompactMax);
    expect(settings.codexCompat.autoContinueMax).toBe(0);

    // Values arriving from an older/rogue dashboard build are clamped, not trusted.
    await updateSettings({ codexCompat: { autoCompactRatio: 99, autoContinueMax: -5, firstTokenTimeoutFallback: "nonsense" } });
    settings = await getSettings();
    expect(settings.codexCompat.autoCompactRatio).toBe(CODEX_COMPAT_DEFAULTS.autoCompactRatio);
    expect(settings.codexCompat.autoContinueMax).toBe(0);
    expect(settings.codexCompat.firstTokenTimeoutFallback).toBe(CODEX_COMPAT_DEFAULTS.firstTokenTimeoutFallback);
  });

  it("keeps other settings untouched", async () => {
    const { getSettings, updateSettings } = await load();
    await updateSettings({ codexCompat: { autoCompactRatio: 0.4 }, requireLogin: false });
    const settings = await getSettings();
    expect(settings.requireLogin).toBe(false);
    expect(settings.codexCompat.autoCompactRatio).toBe(CODEX_COMPAT_DEFAULTS.autoCompactRatio);
    expect(settings.codexCompat.rateLimitRetryAfterCapMs).toBe(CODEX_COMPAT_DEFAULTS.rateLimitRetryAfterCapMs);
  });
});

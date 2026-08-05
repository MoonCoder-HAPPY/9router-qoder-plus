// Guards the deduped Antigravity OAuth client: same values across all 3 sources after refactor.
import { describe, it, expect } from "vitest";

const EXPECTED = {
  clientId: "",
  clientSecret: "",
};
const GOOGLE = {
  clientId: "",
  clientSecret: "",
};

describe("antigravity oauth client (deduped)", () => {
  it("shared source holds the canonical credentials", async () => {
    const { ANTIGRAVITY_OAUTH_CLIENT } = await import("../../open-sse/providers/shared.js");
    expect(ANTIGRAVITY_OAUTH_CLIENT).toEqual(EXPECTED);
  });

  it("registry transport keeps clientId/clientSecret", async () => {
    const ag = (await import("../../open-sse/providers/registry/antigravity.js")).default;
    expect(ag.transport.clientId).toBe(EXPECTED.clientId);
    expect(ag.transport.clientSecret).toBe(EXPECTED.clientSecret);
  });

  it("google client shared by gemini + gemini-cli", async () => {
    const { GOOGLE_OAUTH_CLIENT } = await import("../../open-sse/providers/shared.js");
    expect(GOOGLE_OAUTH_CLIENT).toEqual(GOOGLE);
    const gemini = (await import("../../open-sse/providers/registry/gemini.js")).default;
    const gc = (await import("../../open-sse/providers/registry/gemini-cli.js")).default;
    expect(gemini.transport.clientSecret).toBe(GOOGLE.clientSecret);
    expect(gc.transport.clientSecret).toBe(GOOGLE.clientSecret);
  });

  // Guard: oauth.js must spread shared clients + derive from registry (PROVIDER_OAUTH).
  it("src oauth.js imports shared client + keeps full shape", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../../src/lib/oauth/constants/oauth.js"), "utf8");
    expect(src).toContain('import { ANTIGRAVITY_OAUTH_CLIENT, GOOGLE_OAUTH_CLIENT } from "open-sse/providers/shared.js"');
    expect(src).toContain("...ANTIGRAVITY_OAUTH_CLIENT");
    expect(src).toContain("...GOOGLE_OAUTH_CLIENT");
    // authorizeUrl now lives in registry; oauth.js derives via PROVIDER_OAUTH spread
    expect(src).toContain('PROVIDER_OAUTH["antigravity"]');
    expect(src).toContain('PROVIDER_OAUTH["gemini-cli"]');
    expect(src).toContain("ANTIGRAVITY_OAUTH_CLIENT");
    expect(src).toContain("GOOGLE_OAUTH_CLIENT");
  });
});

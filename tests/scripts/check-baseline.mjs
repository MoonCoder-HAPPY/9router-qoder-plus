#!/usr/bin/env node
/**
 * Baseline-aware test gate.
 *
 * The repository carries a large amount of pre-existing test debt that is
 * unrelated to the Codex work (cursor proto fixtures, golden snapshots,
 * legacy translator normalisation, ...).  A plain "all green" gate would be
 * red for reasons nobody is fixing this round, so this script fails only on
 * *new* failures:
 *
 *   node tests/scripts/check-baseline.mjs            # gate: fail on new failures
 *   node tests/scripts/check-baseline.mjs --update   # rewrite the baseline
 *
 * Baseline format (tests/__baseline__/known-fails.txt), one entry per line:
 *   <path-relative-to-tests>/<file>.test.js :: <full test name>
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const baselinePath = path.join(repoRoot, "tests/__baseline__/known-fails.txt");
const update = process.argv.includes("--update");
const tmpDir = mkdtempSync(path.join(tmpdir(), "9router-baseline-"));
const reportPath = path.join(tmpDir, "vitest-report.json");

/** vitest lives in tests/node_modules locally and in the repo root in CI. */
const resolveVitest = () => {
  const candidates = [
    path.join(repoRoot, "node_modules/vitest/vitest.mjs"),
    path.join(repoRoot, "tests/node_modules/vitest/vitest.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  console.error(`vitest not found; looked in:${candidates.join(", ")}`);
  process.exit(2);
};

const run = () => {
  const result = spawnSync(
    process.execPath,
    [
      resolveVitest(),
      "run",
      "--config",
      "tests/vitest.config.js",
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  // Surface vitest's own output: a silent non-zero exit with no report is otherwise
  // impossible to diagnose from CI.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
};

const collectFailures = () => {
  if (!existsSync(reportPath)) {
    console.error("[baseline] vitest produced no report file - see its output above");
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const failures = new Set();
  for (const file of report.testResults ?? []) {
    const rel = path.relative(path.join(repoRoot, "tests"), file.name).split(path.sep).join("/");
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === "failed") failures.add(`${rel} :: ${assertion.fullName}`);
    }
  }
  return failures;
};

const readBaseline = () =>
  new Set(
    readFileSync(baselinePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );

const vitestStatus = run();
if (vitestStatus !== 0 && !existsSync(reportPath)) process.exit(vitestStatus);
const failures = collectFailures();

if (update) {
  const sorted = [...failures].sort();
  writeFileSync(baselinePath, `${sorted.join("\n")}\n`);
  console.log(`[baseline] wrote ${sorted.length} known failures to tests/__baseline__/known-fails.txt`);
  process.exit(0);
}

const baseline = readBaseline();
const newFailures = [...failures].filter((entry) => !baseline.has(entry)).sort();
const recovered = [...baseline].filter((entry) => !failures.has(entry)).sort();

console.log(`[baseline] failing now: ${failures.size} | baselined: ${baseline.size}`);
if (recovered.length > 0) console.log(`[baseline] recovered (run --update to shrink the baseline): ${recovered.length}`);
if (newFailures.length > 0) {
  console.error(`\n[baseline] NEW failures (not in the baseline): ${newFailures.length}`);
  for (const entry of newFailures) console.error(`  - ${entry}`);
  process.exit(1);
}
console.log("[baseline] OK - no new failures");
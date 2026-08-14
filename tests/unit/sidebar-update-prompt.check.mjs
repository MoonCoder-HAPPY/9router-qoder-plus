import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "src/shared/components/Sidebar.js"), "utf8");

for (const forbidden of [
  'fetch("/api/version")',
  'fetch("/api/version/shutdown"',
  "New version available",
  "Update 9Router",
  "ManualUpdatePanel",
  "Copy & Shutdown",
]) {
  assert.equal(source.includes(forbidden), false, `Sidebar still contains: ${forbidden}`);
}

console.log("Sidebar update prompt code removed");

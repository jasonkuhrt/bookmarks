#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";

const [inputPath, outputPath] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  console.error("Usage: bun scripts/filter-coverage.ts <input-lcov> <output-lcov>");
  process.exit(1);
}

const EXCLUDED_FILES = new Set([
  "src/lib/chrome.ts",
  "src/lib/daemon.ts",
  "src/lib/safari.ts",
  "src/lib/schema/bookmark-leaf.ts",
  "src/lib/schema/bookmark-structure.ts",
  "src/lib/schema/bookmark-tree.ts",
  "src/lib/schema/bookmarks-config.ts",
  "src/lib/schema/target-profile.ts",
  "src/lib/sync.ts",
  "src/lib/unsupported.ts",
  "src/lib/workspace.ts",
]);

const records = readFileSync(inputPath, "utf-8")
  .split("end_of_record\n")
  .map((record) => record.trim())
  .filter(Boolean);

const filtered = records.filter((record) => {
  const sourceFile = record
    .split("\n")
    .find((line) => line.startsWith("SF:"))
    ?.slice(3);

  return sourceFile !== undefined && !EXCLUDED_FILES.has(sourceFile);
});

if (filtered.length === 0) {
  console.error("Coverage filter removed every lcov record.");
  process.exit(1);
}

writeFileSync(outputPath, `${filtered.join("\nend_of_record\n")}\nend_of_record\n`);

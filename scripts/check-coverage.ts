#!/usr/bin/env bun

const [lcovPath, minLinesInput = "85", minFunctionsInput = "55"] = process.argv.slice(2);

if (!lcovPath) {
  console.error("Usage: tsx scripts/check-coverage.ts <lcov-path> [min-lines] [min-functions]");
  process.exit(1);
}

const minLines = Number(minLinesInput);
const minFunctions = Number(minFunctionsInput);

if (!Number.isFinite(minLines) || !Number.isFinite(minFunctions)) {
  console.error("Coverage thresholds must be numeric.");
  process.exit(1);
}

type CoverageRecord = {
  sourceFile: string;
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
};

import { readFileSync } from "node:fs";

const text = readFileSync(lcovPath, "utf-8");
const records: CoverageRecord[] = [];
let current: CoverageRecord = {
  sourceFile: "",
  linesFound: 0,
  linesHit: 0,
  functionsFound: 0,
  functionsHit: 0,
};

for (const line of text.split("\n")) {
  if (line.startsWith("SF:")) current.sourceFile = line.slice(3);
  else if (line.startsWith("LF:")) current.linesFound = Number(line.slice(3));
  else if (line.startsWith("LH:")) current.linesHit = Number(line.slice(3));
  else if (line.startsWith("FNF:")) current.functionsFound = Number(line.slice(4));
  else if (line.startsWith("FNH:")) current.functionsHit = Number(line.slice(4));
  else if (line === "end_of_record") {
    records.push(current);
    current = {
      sourceFile: "",
      linesFound: 0,
      linesHit: 0,
      functionsFound: 0,
      functionsHit: 0,
    };
  }
}

if (records.length === 0) {
  console.error(`No coverage records found in ${lcovPath}.`);
  process.exit(1);
}

const coreModuleRecords = records.filter(
  (record) =>
    record.sourceFile.startsWith("src/lib/") && !record.sourceFile.startsWith("src/lib/schema/"),
);

if (coreModuleRecords.length === 0) {
  console.error(`No core-module coverage records found in ${lcovPath}.`);
  process.exit(1);
}

const totals = coreModuleRecords.reduce(
  (acc, record) => ({
    linesFound: acc.linesFound + record.linesFound,
    linesHit: acc.linesHit + record.linesHit,
    functionsFound: acc.functionsFound + record.functionsFound,
    functionsHit: acc.functionsHit + record.functionsHit,
  }),
  { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 },
);

const percent = (hit: number, found: number): number => (found === 0 ? 100 : (hit / found) * 100);

const linesPct = percent(totals.linesHit, totals.linesFound);
const functionsPct = percent(totals.functionsHit, totals.functionsFound);

console.log(
  `Coverage summary: ${linesPct.toFixed(2)}% lines, ${functionsPct.toFixed(2)}% functions across ${coreModuleRecords.length} core modules`,
);

if (linesPct < minLines || functionsPct < minFunctions) {
  console.error(
    `Coverage threshold failed. Required >= ${minLines}% lines and >= ${minFunctions}% functions.`,
  );
  process.exit(1);
}

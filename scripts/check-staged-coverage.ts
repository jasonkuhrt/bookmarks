#!/usr/bin/env bun

type CoverageMetric = {
  found: number;
  hit: number;
};

type CoverageEntry = {
  executableLines: Set<number>;
  coveredLines: Set<number>;
  totals: {
    branches: CoverageMetric;
    functions: CoverageMetric;
    lines: CoverageMetric;
  };
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;
const TEST_SUFFIXES = [".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx", ".d.ts"] as const;
const COVERAGE_METRIC_NAMES = ["lines", "functions", "branches"] as const;

const [lcovPath = "coverage/lcov.info", minCoverageInput = "95"] = process.argv.slice(2);
const minCoverage = Number(minCoverageInput);

if (!Number.isFinite(minCoverage)) {
  console.error("Coverage threshold must be numeric.");
  process.exit(1);
}

const decoder = new TextDecoder();

const normalizeRepoPath = (path: string, repoRoot: string): string => {
  const normalized = path.replaceAll("\\", "/");
  const normalizedRoot = repoRoot.replaceAll("\\", "/");

  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }

  if (normalized.startsWith("./")) {
    return normalized.slice(2);
  }

  return normalized;
};

const run = (cmd: readonly string[], cwd: string): CommandResult => {
  const result = Bun.spawnSync({
    cmd: [...cmd],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
};

const runOrThrow = (cmd: readonly string[], cwd: string): string => {
  const result = run(cmd, cwd);

  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `${cmd.join(" ")} failed`;
    throw new Error(detail);
  }

  return result.stdout;
};

const isRelevantSourcePath = (path: string): boolean => {
  if (!path.startsWith("src/lib/")) return false;
  if (path.startsWith("src/lib/schema/")) return false;
  if (!SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))) return false;
  return !TEST_SUFFIXES.some((suffix) => path.endsWith(suffix));
};

const parseCoverage = (lcovText: string, repoRoot: string): Map<string, CoverageEntry> => {
  const coverage = new Map<string, CoverageEntry>();
  let currentPath: string | null = null;

  for (const rawLine of lcovText.split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith("SF:")) {
      currentPath = normalizeRepoPath(line.slice(3), repoRoot);
      coverage.set(currentPath, {
        executableLines: new Set<number>(),
        coveredLines: new Set<number>(),
        totals: {
          branches: { found: 0, hit: 0 },
          functions: { found: 0, hit: 0 },
          lines: { found: 0, hit: 0 },
        },
      });
      continue;
    }

    if (!currentPath) continue;

    const entry = coverage.get(currentPath);
    if (!entry) continue;

    if (line.startsWith("LF:")) {
      entry.totals.lines.found += Number(line.slice(3));
      continue;
    }

    if (line.startsWith("LH:")) {
      entry.totals.lines.hit += Number(line.slice(3));
      continue;
    }

    if (line.startsWith("FNF:")) {
      entry.totals.functions.found += Number(line.slice(4));
      continue;
    }

    if (line.startsWith("FNH:")) {
      entry.totals.functions.hit += Number(line.slice(4));
      continue;
    }

    if (line.startsWith("BRF:")) {
      entry.totals.branches.found += Number(line.slice(4));
      continue;
    }

    if (line.startsWith("BRH:")) {
      entry.totals.branches.hit += Number(line.slice(4));
      continue;
    }

    if (!line.startsWith("DA:")) continue;

    const [lineNumberText = "", hitsText = "0"] = line.slice(3).split(",", 2);
    const lineNumber = Number(lineNumberText);
    const hits = Number(hitsText);

    if (!Number.isInteger(lineNumber)) continue;

    entry.executableLines.add(lineNumber);
    if (hits > 0) {
      entry.coveredLines.add(lineNumber);
    }
  }

  return coverage;
};

const parseStagedAddedLines = (
  diffText: string,
  relevantPaths: ReadonlySet<string>,
  repoRoot: string,
): Map<string, Set<number>> => {
  const stagedLines = new Map<string, Set<number>>();
  let currentPath: string | null = null;
  let currentLineNumber = 0;

  for (const rawLine of diffText.split("\n")) {
    if (rawLine.startsWith("+++ ")) {
      const nextPath = rawLine.slice(4).trim();
      if (nextPath === "/dev/null") {
        currentPath = null;
        continue;
      }

      const normalizedPath = normalizeRepoPath(nextPath.replace(/^b\//, ""), repoRoot);
      currentPath = relevantPaths.has(normalizedPath) ? normalizedPath : null;
      continue;
    }

    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunkMatch) {
      currentLineNumber = Number(hunkMatch[1] ?? "0");
      continue;
    }

    if (!currentPath) continue;

    if (rawLine.startsWith("+")) {
      const entry = stagedLines.get(currentPath) ?? new Set<number>();
      entry.add(currentLineNumber);
      stagedLines.set(currentPath, entry);
      currentLineNumber += 1;
      continue;
    }

    if (rawLine.startsWith("-") || rawLine.startsWith("\\")) {
      continue;
    }

    currentLineNumber += 1;
  }

  return stagedLines;
};

const formatPercent = (hit: number, found: number): string =>
  (found === 0 ? 100 : (hit / found) * 100).toFixed(2);

const describeFileCoverage = (path: string, entry: CoverageEntry): string => {
  const metricSummary = COVERAGE_METRIC_NAMES.map((metricName) => {
    const metric = entry.totals[metricName];
    if (metric.found === 0) return `${metricName} n/a`;
    return `${metricName} ${formatPercent(metric.hit, metric.found)}% (${metric.hit}/${metric.found})`;
  }).join(", ");

  return `${path} ${metricSummary}`;
};

const repoRoot = runOrThrow(["git", "rev-parse", "--show-toplevel"], ".").trim();

const stagedPaths = runOrThrow(
  ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
  repoRoot,
)
  .split("\n")
  .map((line) => normalizeRepoPath(line.trim(), repoRoot))
  .filter((line) => line.length > 0);

const relevantPaths = stagedPaths.filter(isRelevantSourcePath);

if (relevantPaths.length === 0) {
  console.log("No staged source files require coverage.");
  process.exit(0);
}

console.log(`Running coverage for staged source files: ${relevantPaths.join(", ")}`);

const coverageRun = run(["bun", "run", "test:coverage"], repoRoot);

if (coverageRun.stdout.trim()) process.stdout.write(coverageRun.stdout);
if (coverageRun.stderr.trim()) process.stderr.write(coverageRun.stderr);

if (coverageRun.exitCode !== 0) {
  process.exit(coverageRun.exitCode);
}

const lcovFile = Bun.file(`${repoRoot}/${lcovPath}`);
if (!(await lcovFile.exists())) {
  console.error(`Coverage report not found at ${lcovPath}.`);
  process.exit(1);
}

const coverage = parseCoverage(await lcovFile.text(), repoRoot);
const missingCoveragePaths = relevantPaths.filter((path) => !coverage.has(path));

if (missingCoveragePaths.length > 0) {
  console.error(
    `Missing coverage records for staged source files: ${missingCoveragePaths.join(", ")}.`,
  );
  process.exit(1);
}

const perFileSummaries: string[] = [];
const perFileFailures: string[] = [];

for (const path of relevantPaths) {
  const entry = coverage.get(path);
  if (!entry) continue;

  perFileSummaries.push(describeFileCoverage(path, entry));

  const failedMetrics = COVERAGE_METRIC_NAMES.filter((metricName) => {
    const metric = entry.totals[metricName];
    if (metric.found === 0) return false;
    return (metric.hit / metric.found) * 100 < minCoverage;
  });

  if (failedMetrics.length > 0) {
    perFileFailures.push(`${path} (${failedMetrics.join(", ")})`);
  }
}

console.log(`Staged file coverage: ${perFileSummaries.join(", ")}`);

const relevantPathSet = new Set(relevantPaths);
const diffOutput = runOrThrow(
  [
    "git",
    "diff",
    "--cached",
    "--unified=0",
    "--no-color",
    "--diff-filter=ACMR",
    "--",
    ...relevantPaths,
  ],
  repoRoot,
);
const stagedLines = parseStagedAddedLines(diffOutput, relevantPathSet, repoRoot);

let totalExecutableChangedLines = 0;
let totalCoveredChangedLines = 0;

for (const [path, changedLines] of stagedLines) {
  const entry = coverage.get(path);
  if (!entry) continue;

  const executableChangedLines = [...changedLines].filter((lineNumber) =>
    entry.executableLines.has(lineNumber),
  );
  const coveredChangedLines = executableChangedLines.filter((lineNumber) =>
    entry.coveredLines.has(lineNumber),
  );

  totalExecutableChangedLines += executableChangedLines.length;
  totalCoveredChangedLines += coveredChangedLines.length;
}

let diffCoverageFailed = false;

if (totalExecutableChangedLines === 0) {
  console.log("No staged executable source lines require diff coverage.");
} else {
  const diffCoverage = (totalCoveredChangedLines / totalExecutableChangedLines) * 100;
  console.log(
    `Staged diff coverage: ${formatPercent(totalCoveredChangedLines, totalExecutableChangedLines)}% (${totalCoveredChangedLines}/${totalExecutableChangedLines})`,
  );
  diffCoverageFailed = diffCoverage < minCoverage;
}

if (perFileFailures.length > 0) {
  console.error(
    `Staged file coverage threshold failed. Required >= ${minCoverage.toFixed(2)}% for: ${perFileFailures.join(", ")}.`,
  );
}

if (diffCoverageFailed) {
  console.error(`Staged diff coverage threshold failed. Required >= ${minCoverage.toFixed(2)}%.`);
}

if (perFileFailures.length > 0 || diffCoverageFailed) {
  process.exit(1);
}

export {};

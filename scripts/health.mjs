import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const GIT = "git";
const NODE = process.execPath;
const UTF8 = "utf8";
const NEWLINE = "\n";
const EMPTY = "";
const SEPARATOR = "--";
const SOURCE_PREFIX = "src/";
const SOURCE_PATHSPEC = ":(glob)src/**/*.ts";
const TEST_PATHSPEC = ":(glob)src/**/*.test.ts";
const TEST_SUFFIX = ".test.ts";
const TEST_SUPPORT_SUFFIX = "test-support.ts";
const FIXTURES_SEGMENT = "__fixtures__";
const CASE_PATTERN = /^\s*(test|it)\(/;
const REGRESSION_MARKER = "regression:";
const FIX_PREFIX = "fix";
const SUPPRESSIONS_PATH = "eslint-suppressions.json";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COMMIT_MARKER = "\u0001";
const ADDED_PREFIX = "+";
const ADDED_FILE_PREFIX = "+++";
const GIT_MAX_BUFFER = 1024 * 1024 * 1024;
const RATIO_SCALE = 100;
const PERCENT = 100;
const TEST_CONCURRENCY = "8";
const TEST_TIMEOUT = "60000";
const TEST_PATH_SCRIPT = "scripts/test-path.mjs";
const COVERAGE_PREFIX = "health-coverage-";
const COVERAGE_FILE = "lcov.info";
const COVERAGE_STDIO_BUFFER = 64 * 1024 * 1024;
const MAIN_MODULE_INDEX = 1;
const ARGUMENT_START = 2;
const SUCCESS_EXIT_CODE = 0;
const ERROR_EXIT_CODE = 2;
const USAGE_MESSAGE =
  "usage: health.mjs --since <YYYY-MM-DD> [--json] [--coverage]";
const NO_PRODUCTION_MESSAGE = "the repository holds no production line";

function git(root, args) {
  return execFileSync(GIT, args, {
    cwd: root,
    encoding: UTF8,
    maxBuffer: GIT_MAX_BUFFER,
  });
}

function isTestFile(path) {
  return path.endsWith(TEST_SUFFIX);
}

function isProductionFile(path) {
  return (
    path.endsWith(".ts") &&
    !isTestFile(path) &&
    !path.endsWith(TEST_SUPPORT_SUFFIX) &&
    !path.split("/").includes(FIXTURES_SEGMENT)
  );
}

function listFiles(root, pathspec) {
  return git(root, ["ls-files", "--", pathspec])
    .split(NEWLINE)
    .filter((path) => path !== EMPTY);
}

function countLines(root, path) {
  const text = readFileSync(join(root, path), UTF8);
  if (text === EMPTY) return 0;
  const parts = text.split(NEWLINE).length;
  return text.endsWith(NEWLINE) ? parts - 1 : parts;
}

function sumLines(root, paths) {
  return paths.reduce((sum, path) => sum + countLines(root, path), 0);
}

function countCases(root, paths) {
  return paths.reduce(
    (sum, path) =>
      sum +
      readFileSync(join(root, path), UTF8)
        .split(NEWLINE)
        .filter((line) => CASE_PATTERN.test(line)).length,
    0,
  );
}

function roundTo(value, scale) {
  return Math.round(value * scale) / scale;
}

function readSuppressions(root) {
  const byRule = {};
  const files = JSON.parse(readFileSync(join(root, SUPPRESSIONS_PATH), UTF8));
  for (const rules of Object.values(files)) {
    for (const [rule, { count }] of Object.entries(rules)) {
      byRule[rule] = (byRule[rule] ?? 0) + count;
    }
  }
  const sorted = Object.fromEntries(
    Object.entries(byRule).sort(([left], [right]) => left.localeCompare(right)),
  );
  const total = Object.values(sorted).reduce((sum, count) => sum + count, 0);
  return { total, byRule: sorted };
}

function countNewCasesWithoutRegression(root, since) {
  const log = git(root, [
    "log",
    "-p",
    "--no-color",
    "--no-ext-diff",
    `--since=${since}`,
    "--format=",
    "--",
    TEST_PATHSPEC,
  ]);
  return log
    .split(NEWLINE)
    .filter((line) => line.startsWith(ADDED_PREFIX))
    .filter((line) => !line.startsWith(ADDED_FILE_PREFIX))
    .map((line) => line.slice(ADDED_PREFIX.length))
    .filter((line) => CASE_PATTERN.test(line))
    .filter((line) => !line.includes(REGRESSION_MARKER)).length;
}

function moduleOf(path) {
  const segments = path.slice(SOURCE_PREFIX.length).split("/");
  return segments.length > 1 ? `${SOURCE_PREFIX}${segments[0]}` : null;
}

function countFixCommitsByModule(root, since, sourceFiles) {
  const counts = Object.fromEntries(
    sourceFiles
      .map(moduleOf)
      .filter((name) => name !== null)
      .sort()
      .map((name) => [name, 0]),
  );
  const log = git(root, [
    "log",
    "--name-only",
    `--since=${since}`,
    `--format=${COMMIT_MARKER}%s`,
    "--",
    SOURCE_PATHSPEC,
  ]);
  for (const commit of log.split(COMMIT_MARKER)) {
    const [subject, ...lines] = commit.split(NEWLINE);
    if (!subject.startsWith(FIX_PREFIX)) continue;
    const modules = lines
      .filter((path) => path !== EMPTY && isProductionFile(path))
      .map(moduleOf)
      .filter((name) => name !== null);
    for (const name of new Set(modules)) {
      if (name in counts) counts[name] += 1;
    }
  }
  return counts;
}

function sumLcov(text, hitKey, foundKey) {
  let hit = 0;
  let found = 0;
  for (const line of text.split(NEWLINE)) {
    if (line.startsWith(`${hitKey}:`)) hit += Number(line.split(":")[1]);
    if (line.startsWith(`${foundKey}:`)) found += Number(line.split(":")[1]);
  }
  return found === 0 ? 0 : roundTo((hit / found) * PERCENT, RATIO_SCALE);
}

function runCoverage(root) {
  const directory = mkdtempSync(join(tmpdir(), COVERAGE_PREFIX));
  try {
    const destination = join(directory, COVERAGE_FILE);
    const testPath = execFileSync(NODE, [TEST_PATH_SCRIPT], {
      cwd: root,
      encoding: UTF8,
    }).trim();
    const result = spawnSync(
      NODE,
      [
        "--test",
        `--test-concurrency=${TEST_CONCURRENCY}`,
        `--test-timeout=${TEST_TIMEOUT}`,
        "--experimental-test-coverage",
        "--test-reporter=lcov",
        `--test-reporter-destination=${destination}`,
        "src/**/*.test.ts",
      ],
      {
        cwd: root,
        encoding: UTF8,
        env: { ...process.env, PATH: testPath },
        maxBuffer: COVERAGE_STDIO_BUFFER,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== SUCCESS_EXIT_CODE) {
      throw new Error(
        `the coverage run failed with status ${result.status}: ${result.stderr}`,
      );
    }
    const lcov = readFileSync(destination, UTF8);
    return {
      line_percent: sumLcov(lcov, "LH", "LF"),
      branch_percent: sumLcov(lcov, "BRH", "BRF"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function collect(root, { since, coverage }) {
  const sourceFiles = listFiles(root, SOURCE_PATHSPEC);
  const testFiles = sourceFiles.filter(isTestFile);
  const productionFiles = sourceFiles.filter(isProductionFile);
  const testLines = sumLines(root, testFiles);
  const productionLines = sumLines(root, productionFiles);
  if (productionLines === 0) throw new Error(NO_PRODUCTION_MESSAGE);
  const suppressions = readSuppressions(root);
  return {
    test_files: testFiles.length,
    test_cases: countCases(root, testFiles),
    test_lines: testLines,
    production_lines: productionLines,
    test_line_ratio: roundTo(testLines / productionLines, RATIO_SCALE),
    suppressions: suppressions.total,
    suppressions_by_rule: suppressions.byRule,
    new_cases_without_regression: countNewCasesWithoutRegression(root, since),
    fix_commits_by_module: countFixCommitsByModule(root, since, sourceFiles),
    coverage: coverage ? runCoverage(root) : null,
  };
}

function flatten(prefix, value) {
  if (value === null || typeof value !== "object") return [[prefix, value]];
  return Object.entries(value).flatMap(([key, child]) =>
    flatten(`${prefix}.${key}`, child),
  );
}

function renderTable(report) {
  const rows = Object.entries(report).flatMap(([key, value]) =>
    value !== null && typeof value === "object"
      ? flatten(key, value)
      : [[key, value]],
  );
  return [
    "| field | value |",
    "| --- | --- |",
    ...rows.map(([key, value]) => `| ${key} | ${value} |`),
    EMPTY,
  ].join(NEWLINE);
}

function parseSince(text) {
  const valid = DATE_PATTERN.test(text ?? EMPTY) && !isNaN(Date.parse(text));
  if (!valid) throw new Error(USAGE_MESSAGE);
  return text;
}

function main(argv) {
  const { values } = parseArgs({
    args: argv[0] === SEPARATOR ? argv.slice(1) : argv,
    options: {
      since: { type: "string" },
      json: { type: "boolean", default: false },
      coverage: { type: "boolean", default: false },
    },
  });
  const report = collect(process.cwd(), {
    since: parseSince(values.since),
    coverage: values.coverage,
  });
  process.stdout.write(
    values.json
      ? `${JSON.stringify(report, null, 2)}${NEWLINE}`
      : renderTable(report),
  );
  return SUCCESS_EXIT_CODE;
}

if (
  process.argv[MAIN_MODULE_INDEX] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[MAIN_MODULE_INDEX]).href
) {
  try {
    process.exitCode = main(process.argv.slice(ARGUMENT_START));
  } catch (error) {
    process.stderr.write(`${error.message}${NEWLINE}`);
    process.exitCode = ERROR_EXIT_CODE;
  }
}

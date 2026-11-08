import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ENTRY_POINT = fileURLToPath(new URL("./health.mjs", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUN_TIMEOUT_MS = 120000;
const SUCCESS = 0;
const FIELDS = [
  "test_files",
  "test_cases",
  "test_lines",
  "production_lines",
  "test_line_ratio",
  "suppressions",
  "suppressions_by_rule",
  "new_cases_without_regression",
  "fix_commits_by_module",
  "coverage",
];

test("health prints each field as JSON for this repository", () => {
  const result = spawnSync(
    process.execPath,
    [ENTRY_POINT, "--since", "2026-10-01", "--json"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", timeout: RUN_TIMEOUT_MS },
  );
  assert.equal(result.status, SUCCESS, result.stderr);
  const report = JSON.parse(result.stdout);
  for (const field of FIELDS) assert.ok(field in report, field);
  assert.ok(report.test_cases > 0);
  assert.ok(report.production_lines > 0);
  assert.equal(report.coverage, null);
});

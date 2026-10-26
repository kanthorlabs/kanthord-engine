import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import {
  AFFECTED_DECLARATION_FILE,
  AFFECTED_REPORT_MAX_BYTES,
  AffectedSelection,
  AffectedVerdict,
  affectedFailureText,
  changesDocumentOf,
  headFailed,
  HeadFailureKind,
  isBaseRed,
  nodeVerdict,
  parseDeclaration,
  parseReport,
  promotedFlaky,
  readDeclaration,
  testIdText,
  type AffectedReport,
} from "./affected.ts";
import { ChangeStatus } from "./local-git.ts";

const env = hostEnvironment();
const COMMAND = "pnpm test:affected";
const DEFAULT_LIMIT = 600;
const EXIT_FAILED = 1;
const EXIT_OK = 0;
const DEADLINE_MS = 10000;
const LIST_LIMIT = 10000;
const LONG_STRING = "x".repeat(1025);
const ID_ONE = { file: "a.test.ts", name: "one" };
const ONE_TEXT = "a.test.ts > one";
const FAILURE_ONE =
  "The affected test run of repository engine failed. KanthorD ran `pnpm test:affected` for 3 changed files. The run selected 5 test files, and 1 test failed: a.test.ts > one. Each selected test imports a changed file directly or through other files. Change the code or the test so that every selected test passes.";
const ID_TWO = { file: "b.test.ts", name: "two" };

function report(overrides: Record<string, unknown> = {}): AffectedReport {
  return {
    version: 1,
    selection: AffectedSelection.Related,
    reason: null,
    tests: [ID_ONE.file, ID_TWO.file],
    failed: [],
    flaky: [],
    excluded_e2e: [],
    ...overrides,
  } as AffectedReport;
}

function parsedReport(overrides: Record<string, unknown>, exit = EXIT_OK) {
  return parseReport(JSON.stringify(report(overrides)), exit);
}

test("a valid declaration resolves the default time limit", () => {
  assert.deepEqual(
    parseDeclaration(JSON.stringify({ version: 1, command: COMMAND })),
    {
      declaration: {
        version: 1,
        command: COMMAND,
        time_limit_s: DEFAULT_LIMIT,
      },
    },
  );
  assert.deepEqual(
    parseDeclaration(
      JSON.stringify({ version: 1, command: COMMAND, time_limit_s: 60 }),
    ),
    { declaration: { version: 1, command: COMMAND, time_limit_s: 60 } },
  );
});

test("an invalid declaration answers an error", () => {
  const invalid = [
    "not json",
    "[]",
    JSON.stringify({ version: 1, command: COMMAND, extra: true }),
    JSON.stringify({ version: 1, command: "  " }),
    JSON.stringify({ version: 1, command: COMMAND, time_limit_s: 59 }),
    JSON.stringify({ version: 1, command: COMMAND, time_limit_s: 3601 }),
    JSON.stringify({ version: 2, command: COMMAND }),
  ];
  for (const text of invalid) {
    const result = parseDeclaration(text);
    assert.ok("error" in result, text);
    assert.ok(result.error);
  }
});

test("the declaration read answers null for an absent file and the declaration at origin/main", async (t) => {
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  const read = () =>
    readDeclaration(env, directory, "main", background, DEADLINE_MS);
  writeFileSync(join(directory, "other"), "x");
  await git.add(["other"]);
  await git.raw([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  await git.raw(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  assert.equal(await read(), null);
  mkdirSync(join(directory, ".kanthord"));
  writeFileSync(
    join(directory, AFFECTED_DECLARATION_FILE),
    JSON.stringify({ version: 1, command: COMMAND }),
  );
  await git.add([AFFECTED_DECLARATION_FILE]);
  await git.raw([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "declare",
  ]);
  assert.equal(await read(), null);
  await git.raw(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  assert.deepEqual(await read(), {
    version: 1,
    command: COMMAND,
    time_limit_s: DEFAULT_LIMIT,
  });
});

test("the changes document keeps previous_path for a rename only", () => {
  assert.deepEqual(
    changesDocumentOf({
      binding_id: "binding",
      repository: "engine",
      base_commit: "base",
      head_commit: "head",
      files: [
        {
          path: "new.ts",
          status: ChangeStatus.Renamed,
          previous_path: "old.ts",
        },
        { path: "added.ts", status: ChangeStatus.Added },
      ],
    }),
    {
      version: 1,
      binding_id: "binding",
      repository: "engine",
      base_commit: "base",
      head_commit: "head",
      files: [
        { path: "new.ts", status: "renamed", previous_path: "old.ts" },
        { path: "added.ts", status: "added" },
      ],
    },
  );
});

test("a valid report of each selection parses", () => {
  assert.ok("report" in parsedReport({}));
  assert.ok(
    "report" in
      parsedReport({ selection: AffectedSelection.All, reason: "no map" }),
  );
  assert.ok(
    "report" in parsedReport({ selection: AffectedSelection.None, tests: [] }),
  );
  assert.ok(
    "report" in
      parsedReport({ failed: [ID_ONE], flaky: [ID_TWO] }, EXIT_FAILED),
  );
});

test("a report that breaks a rule answers an error", () => {
  const invalid: Record<string, unknown>[] = [
    { extra: true },
    { version: 2 },
    { selection: "some" },
    { selection: AffectedSelection.All, reason: null },
    { selection: AffectedSelection.All, reason: "  " },
    { reason: "why" },
    { selection: AffectedSelection.All, reason: "é".repeat(129) },
    { selection: AffectedSelection.None, tests: ["a.test.ts"] },
    { failed: [{ file: "missing.test.ts", name: "one" }] },
    { flaky: [{ file: "missing.test.ts", name: "one" }] },
    { failed: [ID_ONE], flaky: [ID_ONE] },
    { failed: [{ ...ID_ONE, extra: 1 }] },
    { tests: [LONG_STRING] },
    { excluded_e2e: Array.from({ length: LIST_LIMIT + 1 }, () => "e") },
    { failed: [{ file: ID_ONE.file, name: LONG_STRING }] },
  ];
  for (const overrides of invalid)
    assert.ok("error" in parsedReport(overrides), JSON.stringify(overrides));
});

test("a flaky test and a failed test of one file with another name are no common id", () => {
  const result = parsedReport(
    { failed: [ID_ONE], flaky: [{ file: ID_ONE.file, name: "other" }] },
    EXIT_FAILED,
  );
  assert.ok("report" in result);
});

test("the report text rules apply", () => {
  assert.ok("error" in parseReport(null, EXIT_OK));
  assert.ok(
    "error" in parseReport(" ".repeat(AFFECTED_REPORT_MAX_BYTES + 1), EXIT_OK),
  );
  assert.ok("error" in parseReport("not json", EXIT_OK));
});

test("the exit code must match the failed list", () => {
  assert.ok("error" in parsedReport({ failed: [ID_ONE] }, EXIT_OK));
  assert.ok("error" in parsedReport({}, EXIT_FAILED));
});

test("a flaky test in a changed file is promoted and another passes", () => {
  const flaky = report({ flaky: [ID_ONE, ID_TWO], failed: [] });
  const files = [{ path: ID_ONE.file, status: ChangeStatus.Modified }];
  assert.deepEqual(promotedFlaky(flaky, files), [ID_ONE]);
  const failing = report({ failed: [ID_TWO], flaky: [ID_ONE] });
  assert.deepEqual(headFailed(failing, files), [ID_TWO, ID_ONE]);
  assert.deepEqual(headFailed(failing, []), [ID_TWO]);
});

test("isBaseRed holds for a subset and an equal set and fails for a new id", () => {
  const base = report({ failed: [ID_ONE, ID_TWO] });
  assert.equal(isBaseRed([ID_ONE], base), true);
  assert.equal(isBaseRed([ID_TWO, ID_ONE], base), true);
  assert.equal(
    isBaseRed([ID_ONE, { file: ID_ONE.file, name: "new" }], base),
    false,
  );
});

test("the node verdict ranks failed, base_red, passed and absent", () => {
  const { Absent, Passed, Failed, BaseRed } = AffectedVerdict;
  assert.equal(nodeVerdict([Passed, BaseRed, Failed]), Failed);
  assert.equal(nodeVerdict([Passed, BaseRed]), BaseRed);
  assert.equal(nodeVerdict([Absent, Passed]), Passed);
  assert.equal(nodeVerdict([Absent]), Absent);
  assert.equal(nodeVerdict([]), Absent);
});

test("the test id text joins the file and the name", () => {
  const text = testIdText(ID_ONE);
  assert.equal(text, ONE_TEXT);
});

test("the failure text names the failed ids and caps the list", () => {
  const base = { repository: "engine", command: COMMAND, changed: 3, tests: 5 };
  assert.equal(affectedFailureText({ ...base, failed: [ID_ONE] }), FAILURE_ONE);
  const many = Array.from({ length: 22 }, (_, index) => ({
    file: "a.test.ts",
    name: `n${index}`,
  }));
  const text = affectedFailureText({ ...base, failed: many });
  assert.ok(text.includes("22 tests failed: a.test.ts > n0; "));
  assert.ok(text.includes("a.test.ts > n19; and 2 more. Each"));
  assert.ok(!text.includes("n20"));
});

test("the failure text states why the head run gave no valid report", () => {
  const base = { repository: "engine", command: COMMAND, changed: 2 };
  const reasons = [
    [
      { kind: HeadFailureKind.InvalidReport, error: "bad" },
      "wrote no valid report: bad",
    ],
    [
      { kind: HeadFailureKind.TimedOut, time_limit_s: 600 },
      "reached its time limit of 600 s",
    ],
    [{ kind: HeadFailureKind.NotFound }, "was not found (exit 127)"],
  ] as const;
  for (const [reason, phrase] of reasons)
    assert.equal(
      affectedFailureText({ ...base, reason }),
      `The affected test run of repository engine failed. KanthorD ran \`pnpm test:affected\` for 2 changed files, and the command ${phrase}. The same command gives a valid result on the base head, so the change of the node causes it. Change the code so that the command writes a valid report in time.`,
    );
});

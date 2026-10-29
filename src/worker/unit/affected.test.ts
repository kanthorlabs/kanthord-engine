import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import {
  AFFECTED_DECLARATION_FILE,
  AFFECTED_REPORT_MAX_BYTES,
  AFFECTED_SUBJECT,
  affectedEvidenceOf,
  affectedFailureText,
  type AffectedInput,
  type AffectedReport,
  type AffectedRun,
  AffectedSelection,
  AffectedVerdict,
  changesDocumentOf,
  headFailed,
  HeadFailureKind,
  isBaseRed,
  nodeVerdict,
  parseDeclaration,
  parseReport,
  promotedFlaky,
  readDeclaration,
  runAffected,
  testIdText,
} from "./affected.ts";
import { EnvironmentFailure } from "../../scheduler/contract.ts";
import {
  RecordKind,
  SpanStatus,
  type TelemetryRecord,
} from "../../tracking/contract.ts";
import { BaseHead, setupEntries } from "./environment-setup.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import { ChangeStatus, commitOf, headCommit } from "./local-git.ts";
import {
  affectedBaseEnd,
  affectedEnd,
  affectedSpan,
  VerificationContext,
  VerificationKind,
} from "./method-telemetry.ts";
import {
  SpanOperation,
  SpanRecorder,
  type TelemetrySink,
} from "./telemetry.ts";

const env = hostEnvironment();
const COMMAND = "pnpm test:affected";
const DEFAULT_LIMIT = 600;
const EXIT_FAILED = 1;
const EXIT_OK = 0;
const DEADLINE_MS = 10000;
const LIST_LIMIT = 10000;
const LONG_STRING = "x".repeat(1025);
const LONG_TOKEN = "t".repeat(40);
const GATE_FILES = ["package.json", "scripts/affected-tests.mjs"];
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
        gate_files: [],
      },
    },
  );
  assert.deepEqual(
    parseDeclaration(
      JSON.stringify({ version: 1, command: COMMAND, time_limit_s: 60 }),
    ),
    {
      declaration: {
        version: 1,
        command: COMMAND,
        time_limit_s: 60,
        gate_files: [],
      },
    },
  );
});

test("a declaration with gate files parses and holds the list", () => {
  const result = parseDeclaration(
    JSON.stringify({ version: 1, command: COMMAND, gate_files: GATE_FILES }),
  );
  assert.ok("declaration" in result);
  assert.deepEqual(result.declaration.gate_files, GATE_FILES);
});

test("an invalid declaration answers an error", () => {
  const invalid = [
    "not json",
    "[]",
    JSON.stringify({ version: 1, command: COMMAND, extra: true }),
    JSON.stringify({ version: 1, command: "  " }),
    JSON.stringify({ version: 1, command: COMMAND, time_limit_s: 59 }),
    JSON.stringify({ version: 1, command: COMMAND, time_limit_s: 3601 }),
    JSON.stringify({ version: 1, command: COMMAND, gate_files: ["  "] }),
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
    gate_files: [],
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
    { version: 3 },
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

const FLOOR = { tests: 1, seconds: 41.7, total_seconds: 1428.5 };
const FLOOR_EXAMPLE = {
  version: 2,
  selection: AffectedSelection.All,
  reason: "global input: package.json",
  tests: ["src/apps/server/server.test.ts", "src/tracking/service.test.ts"],
  floor: FLOOR,
};

test("a version 2 report with a floor is a valid report", () => {
  const result = parsedReport(FLOOR_EXAMPLE);
  assert.ok("report" in result);
  assert.deepEqual(result.report.floor, FLOOR);
});

test("a version 2 report with no floor is a valid report", () => {
  const result = parsedReport({ version: 2 });
  assert.ok("report" in result);
  assert.equal(result.report.floor, undefined);
});

test("a floor key in a version 1 report is an invalid report", () => {
  const result = parsedReport({ floor: FLOOR });
  assert.ok("error" in result);
  assert.match(result.error, /floor/);
});

test("a total_seconds with the selection related is an invalid report", () => {
  const result = parsedReport({
    version: 2,
    floor: { ...FLOOR, total_seconds: 12.5 },
  });
  assert.ok("error" in result);
  assert.match(result.error, /floor/);
});

test("a floor with a negative or a fractional test count is an invalid report", () => {
  for (const tests of [-1, 1.5])
    assert.ok(
      "error" in
        parsedReport({
          version: 2,
          floor: { ...FLOOR, tests, total_seconds: null },
        }),
      String(tests),
    );
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

const BINDING = "binding_01JZ8R2B3C4D5E6F7G8H9J0K1M";
const DIGEST = "d".repeat(64);
const CLAIM = {
  execution_id: "execution_01JZ8R2B3C4D5E6F7G8H9J0K1M",
  node_id: "node_01JZ8Q0K4M6N8P0R2S4T6V8W0X",
  attempt: 1,
  trace_id: "a".repeat(32),
  root_span_id: "1".repeat(16),
};
const IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
const PROBE_LINES = 7;
const NO_SPANS = 0;
const CHANGED_COUNT = 2;
const EXIT_ABSENT = 127;
const SHORT_LIMIT_S = 2;
const REASON = "config";
const UNPROMOTED_FLAKY = 1;
const LONG_LIST = 200;
const LIST_BOUND = 128;
const BYTE_BOUND_ENTRIES = 16;
const SUBJECT_TEXT = "Affected test results";
const EVIDENCE_VERSION = 1;
const FIXTURE_DEADLINE_MS = 60000;
const SHORT_LIMIT_MS = 2000;
const SCRIPT = `probe="$1"
mode=$(cat mode.txt)
permission() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
{
  pwd -P
  echo "$KANTHORD_CHANGES"
  echo "$KANTHORD_AFFECTED_REPORT"
  echo "$KANTHORD_BASE_COMMIT"
  permission "$(dirname "$KANTHORD_CHANGES")"
  permission "$KANTHORD_CHANGES"
  tr -d '\\n' < "$KANTHORD_CHANGES"; echo
} >> "$probe"
case "$mode" in
  slow) sleep 30; exit 0;;
  absent) exit 127;;
  invalid) echo 'not json' > "$KANTHORD_AFFECTED_REPORT"; exit 0;;
  fail) cp "reports/$mode.json" "$KANTHORD_AFFECTED_REPORT"; exit 1;;
  *) cp "reports/$mode.json" "$KANTHORD_AFFECTED_REPORT"; exit 0;;
esac
`;
const A_TEST = "a.test.ts";
const B_TEST = "b.test.ts";
const SCRIPT_REPORTS: Record<string, AffectedReport> = {
  pass: report({ tests: [A_TEST] }),
  fail: report({
    tests: [A_TEST],
    failed: [{ file: A_TEST, name: "one" }],
  }),
  flaky_changed: report({
    tests: [A_TEST],
    flaky: [{ file: A_TEST, name: "one" }],
  }),
  floor: report({
    version: 2,
    selection: AffectedSelection.All,
    reason: "global input: package.json",
    tests: [A_TEST],
    floor: FLOOR,
  }),
  floor_null: report({
    version: 2,
    tests: [A_TEST],
    floor: { ...FLOOR, total_seconds: null },
  }),
  flaky_other: report({
    tests: [A_TEST, B_TEST],
    flaky: [{ file: B_TEST, name: "two" }],
  }),
};

interface Fixture {
  checkout: string;
  head: string;
  base: BaseHead;
  key: string;
  probe: string;
  records: TelemetryRecord[];
  spans: SpanRecorder;
  mergeBase: string;
}

async function commitAll(directory: string, message: string) {
  await simpleGit(directory).add(".");
  await simpleGit(directory).raw([...IDENTITY, "commit", "-m", message]);
}

async function fixture(
  t: TestContext,
  modes: {
    base: string;
    head: string;
    declaration?: string | null;
  },
): Promise<Fixture> {
  const root = temporary(t);
  const origin = join(root, "origin");
  const probe = join(root, "probe.txt");
  mkdirSync(join(origin, "reports"), { recursive: true });
  mkdirSync(join(origin, ".kanthord"));
  await simpleGit(origin).raw(["init", "-b", "main"]);
  writeFileSync(join(origin, "run.sh"), SCRIPT);
  writeFileSync(join(origin, "mode.txt"), modes.base);
  writeFileSync(join(origin, A_TEST), "base");
  for (const [mode, content] of Object.entries(SCRIPT_REPORTS))
    writeFileSync(
      join(origin, "reports", `${mode}.json`),
      JSON.stringify(content),
    );
  const declaration =
    modes.declaration === undefined
      ? JSON.stringify({
          version: 1,
          command: `bash run.sh ${probe}`,
        })
      : modes.declaration;
  if (declaration !== null)
    writeFileSync(join(origin, AFFECTED_DECLARATION_FILE), declaration);
  await commitAll(origin, "base");
  const checkout = join(root, "checkout");
  await simpleGit(root).clone(origin, checkout);
  await simpleGit(checkout).raw(["checkout", "-b", "kanthord/node"]);
  writeFileSync(join(checkout, "mode.txt"), modes.head);
  writeFileSync(join(checkout, A_TEST), "head");
  await commitAll(checkout, "head");
  const setup = {
    env,
    context: background,
    deadline: Date.now() + FIXTURE_DEADLINE_MS,
    spans: null,
  };
  const entries = await setupEntries(setup, [
    {
      directory: checkout,
      repository: {
        binding_id: BINDING,
        name: "repo",
        strategy: { base_branch: "main" },
        environment: null,
      },
    },
  ]);
  const records: TelemetryRecord[] = [];
  const sink: TelemetrySink = {
    write: (batch) => records.push(...batch),
    flush: async () => {},
  };
  return {
    checkout,
    head: await headCommit(env, checkout, background, DEADLINE_MS),
    base: new BaseHead(setup, join(root, "base"), entries),
    key: join(root, "workspace"),
    probe,
    records,
    spans: new SpanRecorder(CLAIM, "coder@1", sink),
    mergeBase: await commitOf(
      env,
      checkout,
      "origin/main",
      background,
      DEADLINE_MS,
    ),
  };
}

function runOf(f: Fixture, overrides: Partial<AffectedInput> = {}) {
  return runAffected({
    env,
    context: background,
    deadline: Date.now() + FIXTURE_DEADLINE_MS,
    exhausted: () => false,
    spans: f.spans,
    scope: VerificationContext.Release,
    workspaceKey: f.key,
    checkout: {
      binding_id: BINDING,
      name: "repo",
      directory: f.checkout,
      base_branch: "main",
      head: f.head,
    },
    digests: [],
    base: f.base,
    ...overrides,
  });
}

async function finished(f: Fixture, overrides: Partial<AffectedInput> = {}) {
  const result = await runOf(f, overrides);
  assert.ok(!("budgetEnd" in result));
  return result;
}

async function ran(f: Fixture, overrides: Partial<AffectedInput> = {}) {
  const result = await finished(f, overrides);
  assert.ok(result.verdict !== AffectedVerdict.Absent);
  return result;
}

async function stopOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof ExecutionStop);
  assert.equal(error.reason, EndReason.EnvironmentFailed);
  return { code: error.code, detail: JSON.parse(error.detail ?? "null") };
}

function verificationSpans(f: Fixture) {
  const spans = f.records.flatMap((record) =>
    record.kind === RecordKind.Span &&
    record.operation === SpanOperation.Verification
      ? [record]
      : [],
  );
  return spans
    .filter((record) => record.start_time !== undefined)
    .map((start) => ({
      start,
      end: spans.find(
        (record) =>
          record.span_id === start.span_id && record.end_time !== undefined,
      ),
    }));
}

test("a repository with no declaration answers absent and runs nothing", async (t) => {
  const f = await fixture(t, { base: "pass", head: "pass", declaration: null });
  assert.deepEqual(await finished(f), { verdict: AffectedVerdict.Absent });
  assert.equal(verificationSpans(f).length, NO_SPANS);
  assert.equal(existsSync(f.probe), false);
});

test("a passing head answers passed and runs no base check", async (t) => {
  const f = await fixture(t, { base: "fail", head: "pass" });
  const result = await ran(f);
  assert.equal(result.verdict, AffectedVerdict.Passed);
  assert.equal(result.base_run, null);
  assert.equal(result.failure_text, null);
  assert.deepEqual(result.failed, []);
  assert.equal(result.changed, CHANGED_COUNT);
  assert.equal(result.head.exit_code, EXIT_OK);
  assert.equal(
    readFileSync(f.probe, "utf8").split("\n").length - 1,
    PROBE_LINES,
  );
});

test("a failed test that the base passes answers failed", async (t) => {
  const f = await fixture(t, { base: "pass", head: "fail" });
  const result = await ran(f);
  assert.equal(result.verdict, AffectedVerdict.Failed);
  assert.deepEqual(result.failed, [{ file: A_TEST, name: "one" }]);
  assert.deepEqual(result.base_run, {
    commit: f.mergeBase,
    exit_code: 0,
    failed: [],
  });
  assert.equal(result.head.exit_code, EXIT_FAILED);
  assert.equal(
    result.failure_text,
    affectedFailureText({
      repository: "repo",
      command: result.declaration.command,
      changed: 2,
      tests: 1,
      failed: [{ file: A_TEST, name: "one" }],
    }),
  );
});

test("a failed test that the base also fails answers base_red", async (t) => {
  const f = await fixture(t, { base: "fail", head: "fail" });
  const result = await ran(f);
  assert.equal(result.verdict, AffectedVerdict.BaseRed);
  assert.equal(result.failure_text, null);
  assert.deepEqual(result.base_run?.failed, [{ file: A_TEST, name: "one" }]);
  assert.equal(result.base_run?.exit_code, EXIT_FAILED);
});

test("a promoted flaky test in a changed file answers failed", async (t) => {
  const f = await fixture(t, { base: "pass", head: "flaky_changed" });
  const result = await ran(f);
  assert.equal(result.verdict, AffectedVerdict.Failed);
  assert.deepEqual(result.promoted_flaky, [{ file: A_TEST, name: "one" }]);
  assert.deepEqual(result.failed, [{ file: A_TEST, name: "one" }]);
});

test("a flaky test in another file answers passed", async (t) => {
  const f = await fixture(t, { base: "pass", head: "flaky_other" });
  const result = await ran(f);
  assert.equal(result.verdict, AffectedVerdict.Passed);
  assert.deepEqual(result.promoted_flaky, []);
  assert.equal(result.base_run, null);
});

test("an affected span holds the floor attributes of a version 2 report", async (t) => {
  const f = await fixture(t, { base: "pass", head: "floor" });
  await ran(f);
  const [head] = verificationSpans(f);
  assert.equal(
    head?.end?.attributes?.["kanthord.affected.floor_count"],
    FLOOR.tests,
  );
  assert.equal(
    head?.end?.attributes?.["kanthord.affected.floor_seconds"],
    FLOOR.seconds,
  );
  assert.equal(
    head?.end?.attributes?.["kanthord.affected.total_seconds"],
    FLOOR.total_seconds,
  );
});

test("an affected span holds no total_seconds when the floor holds null", async (t) => {
  const f = await fixture(t, { base: "pass", head: "floor_null" });
  await ran(f);
  const [head] = verificationSpans(f);
  assert.equal(
    head?.end?.attributes?.["kanthord.affected.floor_count"],
    FLOOR.tests,
  );
  assert.equal(
    head?.end?.attributes?.["kanthord.affected.floor_seconds"],
    FLOOR.seconds,
  );
  assert.equal(
    "kanthord.affected.total_seconds" in (head?.end?.attributes ?? {}),
    false,
  );
});

test("an affected span of a version 1 report holds no floor attribute", async (t) => {
  const f = await fixture(t, { base: "pass", head: "pass" });
  await ran(f);
  const [head] = verificationSpans(f);
  for (const name of ["floor_count", "floor_seconds", "total_seconds"])
    assert.equal(
      `kanthord.affected.${name}` in (head?.end?.attributes ?? {}),
      false,
    );
});

test("an invalid head report with a valid base report answers failed", async (t) => {
  const f = await fixture(t, { base: "pass", head: "invalid" });
  const result = await ran(f);
  assert.equal(result.verdict, AffectedVerdict.Failed);
  assert.equal(result.report, null);
  assert.match(
    result.failure_text ?? "",
    /wrote no valid report: invalid JSON/,
  );
  assert.equal(result.base_run?.exit_code, EXIT_OK);
});

test("an invalid report at both heads stops with affected_invalid", async (t) => {
  const f = await fixture(t, { base: "invalid", head: "invalid" });
  const stop = await stopOf(runOf(f));
  assert.equal(stop.code, EnvironmentFailure.AffectedInvalid);
  assert.deepEqual(Object.keys(stop.detail), [
    "binding_id",
    "commit",
    "command",
    "exit_code",
    "error",
  ]);
  assert.equal(stop.detail.exit_code, EXIT_OK);
  assert.match(stop.detail.error, /invalid JSON/);
});

test("a time-limit end at both heads stops with affected_timeout", async (t) => {
  const f = await fixture(t, { base: "slow", head: "slow" });
  const stop = await stopOf(runOf(f, { commandLimitMs: SHORT_LIMIT_MS }));
  assert.equal(stop.code, EnvironmentFailure.AffectedTimeout);
  assert.equal(stop.detail.commit, f.head);
  assert.equal(stop.detail.time_limit_s, SHORT_LIMIT_S);
});

test("a time-limit end at the head stops with affected_timeout before the base check", async (t) => {
  const f = await fixture(t, { base: "pass", head: "slow" });
  const stop = await stopOf(runOf(f, { commandLimitMs: SHORT_LIMIT_MS }));
  assert.equal(stop.code, EnvironmentFailure.AffectedTimeout);
  assert.deepEqual(Object.keys(stop.detail), [
    "binding_id",
    "commit",
    "command",
    "time_limit_s",
  ]);
  assert.equal(stop.detail.binding_id, BINDING);
  assert.equal(stop.detail.commit, f.head);
  assert.equal(stop.detail.time_limit_s, SHORT_LIMIT_S);
  assert.equal(
    readFileSync(f.probe, "utf8").split("\n").length - 1,
    PROBE_LINES,
  );
});

test("exit 127 at both heads stops with command_absent", async (t) => {
  const f = await fixture(t, { base: "absent", head: "absent" });
  const stop = await stopOf(runOf(f));
  assert.equal(stop.code, EnvironmentFailure.CommandAbsent);
  assert.equal(stop.detail.exit_code, EXIT_ABSENT);
  assert.equal(stop.detail.command, `bash run.sh ${f.probe}`);
});

test("an invalid declaration stops with affected_invalid", async (t) => {
  const f = await fixture(t, {
    base: "pass",
    head: "pass",
    declaration: '{"version":2}',
  });
  const stop = await stopOf(runOf(f));
  assert.equal(stop.code, EnvironmentFailure.AffectedInvalid);
  assert.deepEqual(stop.detail, {
    binding_id: BINDING,
    commit: f.mergeBase,
    file: AFFECTED_DECLARATION_FILE,
    error: stop.detail.error,
  });
  assert.match(stop.detail.error, /invalid declaration/);
  assert.equal(verificationSpans(f).length, NO_SPANS);
});

test("a stop detail redacts a long token in error", async (t) => {
  const f = await fixture(t, {
    base: "pass",
    head: "pass",
    declaration: JSON.stringify({ version: 1, [LONG_TOKEN]: true }),
  });
  const stop = await stopOf(runOf(f));
  assert.equal(stop.code, EnvironmentFailure.AffectedInvalid);
  assert.ok(!stop.detail.error.includes(LONG_TOKEN));
  assert.match(stop.detail.error, /\[redacted\]/);
});

test("a budget end answers budgetEnd and removes the work directory", async (t) => {
  const f = await fixture(t, { base: "pass", head: "pass" });
  assert.deepEqual(await runOf(f, { exhausted: () => true }), {
    budgetEnd: true,
  });
  assert.equal(existsSync(join(f.key, "affected", "repo")), false);
});

test("the command sees the variables and the changes file, and the work directory is removed", async (t) => {
  const f = await fixture(t, { base: "pass", head: "fail" });
  await ran(f);
  const lines = readFileSync(f.probe, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, PROBE_LINES * 2);
  const directory = join(f.key, "affected", "repo");
  const changes = changesDocumentOf({
    binding_id: BINDING,
    repository: "repo",
    base_commit: f.mergeBase,
    head_commit: f.head,
    files: [
      { path: A_TEST, status: ChangeStatus.Modified },
      { path: "mode.txt", status: ChangeStatus.Modified },
    ],
  });
  assert.deepEqual(lines.slice(0, PROBE_LINES), [
    realpathSync(f.checkout),
    join(directory, "changes.json"),
    join(directory, "report.json"),
    f.mergeBase,
    "700",
    "600",
    JSON.stringify(changes),
  ]);
  assert.deepEqual(lines.slice(PROBE_LINES), [
    realpathSync(join(dirname(f.checkout), "base", "repo")),
    join(directory, "changes.json"),
    join(directory, "base-report.json"),
    f.mergeBase,
    "700",
    "600",
    JSON.stringify(changes),
  ]);
  assert.equal(existsSync(directory), false);
});

test("the work directory is removed when the run throws", async (t) => {
  const f = await fixture(t, { base: "invalid", head: "invalid" });
  await stopOf(runOf(f));
  assert.equal(existsSync(join(f.key, "affected", "repo")), false);
});

test("a failed run writes the affected span and the base span with the bounded attributes", async (t) => {
  const f = await fixture(t, { base: "pass", head: "fail" });
  await ran(f, { digests: [DIGEST, DIGEST] });
  const [head, base] = verificationSpans(f);
  assert.ok(head && base);
  const command = `bash run.sh ${f.probe}`;
  const startOf = (span: typeof head) => span.start.attributes ?? {};
  assert.equal(
    startOf(head)["kanthord.verification.kind"],
    VerificationKind.Affected,
  );
  assert.equal(
    startOf(head)["kanthord.verification.context"],
    VerificationContext.Release,
  );
  assert.equal(startOf(head)["kanthord.binding.id"], BINDING);
  assert.equal(startOf(head)["kanthord.commit"], f.head);
  assert.equal(startOf(head)["environment.digest"], `${DIGEST},${DIGEST}`);
  assert.equal(base.start.parent_span_id, head.start.span_id);
  assert.equal(
    startOf(base)["kanthord.verification.kind"],
    VerificationKind.AffectedBase,
  );
  assert.equal(startOf(base)["kanthord.commit"], f.mergeBase);
  assert.deepEqual(head.end?.attributes, {
    "kanthord.affected.verdict": "failed",
    "kanthord.affected.selection": "related",
    "kanthord.affected.changed_count": 2,
    "kanthord.affected.test_count": 1,
    "kanthord.affected.failed_count": 1,
    "kanthord.affected.flaky_count": 0,
    "kanthord.affected.excluded_e2e_count": 0,
    "kanthord.affected.tests": [A_TEST],
    "kanthord.affected.failed": [ONE_TEXT],
    "kanthord.verification.timed_out": false,
    "process.exit.code": 1,
  });
  assert.equal(head.end?.status, SpanStatus.Error);
  assert.deepEqual(base.end?.attributes, {
    "kanthord.verification.timed_out": false,
    "process.exit.code": 0,
  });
  assert.equal(base.end?.status, SpanStatus.Ok);
  const texts = f.records.flatMap((record) =>
    record.kind === RecordKind.Text ? [record] : [],
  );
  assert.ok(texts.some((text) => text.text === command));
});

test("the affected span of a base_red run ends ok", async (t) => {
  const f = await fixture(t, { base: "fail", head: "fail" });
  await ran(f);
  assert.equal(verificationSpans(f)[0]?.end?.status, SpanStatus.Ok);
});

test("the start of an affected span holds no digest attribute for no digest", async (t) => {
  const f = await fixture(t, { base: "pass", head: "pass" });
  await ran(f);
  const attributes = verificationSpans(f)[0]?.start.attributes ?? {};
  assert.equal("environment.digest" in attributes, false);
});

function affectedRun(overrides: Partial<AffectedRun>): AffectedRun {
  return {
    verdict: AffectedVerdict.Failed,
    binding_id: BINDING,
    repository: "repo",
    base_commit: "b".repeat(40),
    head_commit: "c".repeat(40),
    declaration: {
      version: 1,
      command: COMMAND,
      time_limit_s: 600,
      gate_files: [],
    },
    changed: 3,
    report: report({ failed: [ID_ONE] }),
    failed: [ID_ONE],
    promoted_flaky: [],
    head: { command: COMMAND, exit_code: 1, signal: null, timed_out: false },
    output: "tail",
    duration_ms: 12,
    base_run: null,
    failure_text: null,
    ...overrides,
  };
}

test("the end of an affected span holds the reason only for the selection all", () => {
  const all = affectedEnd(
    affectedRun({
      report: report({ selection: AffectedSelection.All, reason: REASON }),
      failed: [],
      verdict: AffectedVerdict.Passed,
    }),
  );
  assert.equal(all.attributes?.["kanthord.affected.reason"], REASON);
  assert.equal(all.status, SpanStatus.Ok);
  const related = affectedEnd(affectedRun({}));
  assert.equal("kanthord.affected.reason" in (related.attributes ?? {}), false);
});

test("the end of an affected span without a valid report holds the changed count, zero counts and empty lists", () => {
  const end = affectedEnd(
    affectedRun({
      report: null,
      failed: [],
      head: {
        command: COMMAND,
        exit_code: null,
        signal: "SIGKILL",
        timed_out: true,
      },
    }),
  );
  assert.deepEqual(end.attributes, {
    "kanthord.affected.verdict": "failed",
    "kanthord.affected.selection": "invalid",
    "kanthord.affected.changed_count": 3,
    "kanthord.affected.test_count": 0,
    "kanthord.affected.failed_count": 0,
    "kanthord.affected.flaky_count": 0,
    "kanthord.affected.excluded_e2e_count": 0,
    "kanthord.affected.tests": [],
    "kanthord.affected.failed": [],
    "kanthord.verification.timed_out": true,
  });
});

test("the end of an affected span counts the flaky ids that the rule did not promote", () => {
  const flaky = [ID_ONE, ID_TWO];
  const end = affectedEnd(
    affectedRun({
      report: report({ flaky }),
      failed: [ID_ONE],
      promoted_flaky: [ID_ONE],
    }),
  );
  assert.equal(
    end.attributes?.["kanthord.affected.flaky_count"],
    UNPROMOTED_FLAKY,
  );
});

test("the lists of an affected span stop at 128 entries", () => {
  const tests = Array.from(
    { length: LONG_LIST },
    (_, index) => `t${index}.test.ts`,
  );
  const failed = tests.map((file) => ({ file, name: "n" }));
  const end = affectedEnd(
    affectedRun({ report: report({ tests, failed }), failed }),
  );
  const attributes = end.attributes ?? {};
  assert.deepEqual(
    attributes["kanthord.affected.tests"],
    tests.slice(0, LIST_BOUND),
  );
  assert.equal(
    (attributes["kanthord.affected.failed"] as string[]).length,
    LIST_BOUND,
  );
  assert.equal(attributes["kanthord.affected.test_count"], LONG_LIST);
});

test("the lists of an affected span stop before 16384 bytes", () => {
  const tests = Array.from({ length: 30 }, (_, index) =>
    `${index}`.padStart(1000, "x"),
  );
  const end = affectedEnd(
    affectedRun({ report: report({ tests }), failed: [] }),
  );
  const kept = end.attributes?.["kanthord.affected.tests"] as string[];
  assert.equal(kept.length, BYTE_BOUND_ENTRIES);
  assert.deepEqual(kept, tests.slice(0, 16));
  const wide = ["é".repeat(8192), "é"];
  const widest = affectedEnd(
    affectedRun({ report: report({ tests: wide }), failed: [] }),
  );
  assert.deepEqual(widest.attributes?.["kanthord.affected.tests"], [wide[0]]);
});

test("the end of the base span holds the exit code, the timeout and the output", () => {
  const end = affectedBaseEnd(
    { command: COMMAND, exit_code: null, signal: "SIGKILL", timed_out: true },
    "out",
  );
  assert.deepEqual(end.attributes, { "kanthord.verification.timed_out": true });
  assert.deepEqual(end.texts, { output: "out" });
  assert.equal(end.status, SpanStatus.Error);
});

test("the evidence document lists each repository that ran in checkout order", () => {
  const failed = affectedRun({
    verdict: AffectedVerdict.Failed,
    repository: "second",
    base_run: { commit: "d".repeat(40), exit_code: 0, failed: [] },
  });
  const passed = affectedRun({
    verdict: AffectedVerdict.Passed,
    repository: "first",
    failed: [],
    report: report({}),
    head: { command: COMMAND, exit_code: 0, signal: null, timed_out: false },
  });
  const evidence = affectedEvidenceOf([
    passed,
    { verdict: AffectedVerdict.Absent },
    failed,
  ]);
  assert.equal(AFFECTED_SUBJECT, SUBJECT_TEXT);
  assert.equal(evidence.version, EVIDENCE_VERSION);
  assert.equal(evidence.verdict, AffectedVerdict.Failed);
  assert.deepEqual(
    evidence.repositories.map((entry) => entry.repository),
    ["first", "second"],
  );
  assert.deepEqual(evidence.repositories[1], {
    binding_id: BINDING,
    repository: "second",
    command: COMMAND,
    base_commit: "b".repeat(40),
    head_commit: "c".repeat(40),
    changed_files: 3,
    verdict: AffectedVerdict.Failed,
    exit_code: 1,
    signal: null,
    duration_ms: 12,
    report: failed.report,
    promoted_flaky: [],
    base_run: failed.base_run,
    output: "tail",
  });
  assert.deepEqual(affectedEvidenceOf([{ verdict: AffectedVerdict.Absent }]), {
    version: 1,
    verdict: AffectedVerdict.Absent,
    repositories: [],
  });
});

test("the span start of an affected check joins the digests and omits an empty list", () => {
  const records: TelemetryRecord[] = [];
  const spans = new SpanRecorder(CLAIM, "coder@1", {
    write: (batch) => records.push(...batch),
    flush: async () => {},
  });
  const start = (digests: string[]) =>
    affectedSpan(spans, {
      context: VerificationContext.Evaluation,
      kind: VerificationKind.Affected,
      binding_id: BINDING,
      commit: "c".repeat(40),
      digests,
      command: COMMAND,
    });
  assert.equal(
    start([DIGEST, "e".repeat(64)]).attributes?.["environment.digest"],
    `${DIGEST},${"e".repeat(64)}`,
  );
  assert.equal("environment.digest" in (start([]).attributes ?? {}), false);
  assert.deepEqual(start([]).texts, { command: COMMAND });
});

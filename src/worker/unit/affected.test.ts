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
  type AffectedInput,
  type AffectedReport,
  AffectedSelection,
  AffectedVerdict,
  changesDocumentOf,
  parseReport,
  readDeclaration,
  runAffected,
} from "./affected.ts";
import { EnvironmentFailure } from "../../scheduler/contract.ts";
import { RecordKind, type TelemetryRecord } from "../../tracking/contract.ts";
import { BaseHead, setupEntries } from "./environment-setup.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import { ChangeStatus, commitOf, headCommit } from "./local-git.ts";
import { VerificationContext } from "./method-telemetry.ts";
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
const LONG_TOKEN = "t".repeat(40);
const ID_ONE = { file: "a.test.ts", name: "one" };
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

const FLOOR = { tests: 1, seconds: 41.7, total_seconds: 1428.5 };

test("a report that breaks a rule answers an error", () => {
  const invalid: Record<string, unknown>[] = [
    { selection: AffectedSelection.All, reason: null },
    { reason: "why" },
    { selection: AffectedSelection.None, tests: ["a.test.ts"] },
    { failed: [{ file: "missing.test.ts", name: "one" }] },
    { failed: [ID_ONE], flaky: [ID_ONE] },
    { floor: { ...FLOOR, total_seconds: null } },
    { version: 2, floor: { ...FLOOR, total_seconds: 12.5 } },
  ];
  for (const overrides of invalid)
    assert.ok("error" in parsedReport(overrides), JSON.stringify(overrides));
  assert.ok("error" in parsedReport({ failed: [ID_ONE] }, EXIT_OK));
  assert.ok("error" in parsedReport({}, EXIT_FAILED));
});

const BINDING = "binding_01JZ8R2B3C4D5E6F7G8H9J0K1M";
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
const THREE_RUNS = 3;
const NO_SPANS = 0;
const CHANGED_COUNT = 2;
const EXIT_ABSENT = 127;
const SHORT_LIMIT_S = 2;
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
  invalid_then_*)
    [ -e "$probe.rerun" ] || { touch "$probe.rerun"; echo 'not json' > "$KANTHORD_AFFECTED_REPORT"; exit 0; }
    mode=\${mode#invalid_then_};;
esac
case "$mode" in
  slow) echo hung-output; sleep 30; exit 0;;
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
    base: new BaseHead(setup, { directory: join(root, "base") }, entries),
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
  assert.notEqual(result.failure_text, null);
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

test("an invalid head report at two head runs with a valid base report answers failed", async (t) => {
  const f = await fixture(t, { base: "pass", head: "invalid" });
  const result = await ran(f);
  assert.equal(result.verdict, AffectedVerdict.Failed);
  assert.equal(result.report, null);
  assert.notEqual(result.failure_text, null);
  assert.equal(result.base_run?.exit_code, EXIT_OK);
  assert.equal(
    readFileSync(f.probe, "utf8").split("\n").length - 1,
    PROBE_LINES * THREE_RUNS,
  );
});

test("regression: an invalid head report that a second head run makes valid answers passed", async (t) => {
  const f = await fixture(t, { base: "pass", head: "invalid_then_pass" });
  const result = await ran(f);
  assert.equal(result.verdict, AffectedVerdict.Passed);
  assert.equal(result.failure_text, null);
  assert.deepEqual(result.failed, []);
  assert.equal(result.head.exit_code, EXIT_OK);
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
});

test("a time-limit end at the head answers failed with the time limit, the commit and the output tail, and runs no base check", async (t) => {
  const f = await fixture(t, { base: "pass", head: "slow" });
  const result = await ran(f, { commandLimitMs: SHORT_LIMIT_MS });
  assert.equal(result.verdict, AffectedVerdict.Failed);
  assert.equal(result.base_run, null);
  assert.equal(result.head.timed_out, true);
  assert.match(result.failure_text ?? "", /hung-output/);
  assert.equal(
    readFileSync(f.probe, "utf8").split("\n").length - 1,
    PROBE_LINES,
  );
});

test("a time-limit end at the base with an invalid head report stops with affected_timeout", async (t) => {
  const f = await fixture(t, { base: "slow", head: "invalid" });
  const stop = await stopOf(runOf(f, { commandLimitMs: SHORT_LIMIT_MS }));
  assert.equal(stop.code, EnvironmentFailure.AffectedTimeout);
  assert.deepEqual(Object.keys(stop.detail), [
    "binding_id",
    "commit",
    "command",
    "exit_code",
    "time_limit_s",
  ]);
  assert.equal(stop.detail.commit, f.mergeBase);
  assert.equal(stop.detail.time_limit_s, SHORT_LIMIT_S);
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

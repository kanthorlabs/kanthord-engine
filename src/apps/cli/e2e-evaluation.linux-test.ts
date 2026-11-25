import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import type { EvaluationFixture } from "./e2e-evaluation-test-support.ts";
import {
  authFileText,
  ENGINE_ROOT,
  TEST_K,
} from "./e2e-run-agent-test-support.ts";
import {
  TEST_USER_HOME,
  writeFileAsTestUser,
} from "./e2e-run-agent-linux-test-support.ts";
import { llmStub } from "./e2e-llm-stub-test-support.ts";
import type { StubRequestRecord } from "./e2e-llm-stub-test-support.ts";
import {
  AGENT_SWE,
  asTestUser,
  buildEvaluationSet,
  COPY_AUTH_TURN,
  GIT_INSPECT_TURN,
  l4Responder,
  NO_FINDINGS_TURN,
  READ_CHECK_TURN,
  runnerAsTestUser,
  TASK_D1,
  TASK_D2,
  TOUCH_SET_TURN,
  WRITE_NEW_SH_TURN,
} from "./e2e-evaluation-test-support.ts";

interface ResultLine {
  agent: string;
  session: string;
  input_digest: string;
}

interface CheckLine {
  case: string;
  session: string;
  a1: boolean;
  a2: boolean;
  a3: boolean;
  a4: boolean;
  pass: boolean;
  breach: string | null;
}

interface Finding {
  aspect: string;
  severity: string;
}

interface DiagnosisLine {
  valid: boolean;
  findings: Finding[];
}

const RUNNER = join(ENGINE_ROOT, "scripts", "evaluation", "agent");
const RUN_SH = join(RUNNER, "run.sh");
const REPORT_SH = join(RUNNER, "report.sh");
const TEST_TIMEOUT_MS = 300000;
const SUCCESS_EXIT = 0;
const BREACH_EXIT = 1;
const NO_VERDICT_EXIT = 3;
const CAP_EXIT = 4;
const GATE_PREFIX = "gate: ";
const AC4_GATE_PARTS = [
  "pass share backend 100.0%",
  "gate_share 0.5",
  "breaches 0",
  "verdict pass",
];
const AC4_RESULT_AGENTS = ["swe@1", "swe@1"];
const AC4_SESSIONS = ["h1/1-1/session.jsonl", "h1/2-1/session.jsonl"];
const AC4_CASE = "h1";
const AC4_ABSENT_FILES = ["diagnoses.jsonl", "check.txt"];
const SET_DEV = "dev";
const CASE_D1 = "d1";
const CASE_D2 = "d2";
const DEV_CASES = [CASE_D1, CASE_D2];
const DEV_RUNS = ["d1/1-1", "d1/2-1", "d2/1-1", "d2/2-1"];
const REPEATS = 2;
const DEV_RUN_COUNT = 4;
const D1_CHECK = [true, true, true, true, true, null];
const D2_CHECK = [false, true, true, true, false, null];
const DEV_RUN_FILES = [
  "check.txt",
  "diff.patch",
  "judge-1-stderr.txt",
  "judge-1.jsonl",
  "session.jsonl",
  "stderr.txt",
];
const AC1_RESULT_AGENTS = [
  "re@1",
  "re@1",
  "re@1",
  "re@1",
  "swe@1",
  "swe@1",
  "swe@1",
  "swe@1",
];
const ONE_DIGEST = 1;
const NO_OUTPUT = "";
const AC1_FINDINGS = [{ aspect: "A5", severity: "medium" }];
const AC1_REPORT_LINES = [
  "verdict complete",
  "A1 good runs: 2",
  "passes: 2 of 4 planned runs",
  "A5 good runs: 0, findings: 0 high, 4 medium, 0 low",
  "set-difficulty: 1 ceiling, 1 floor of 2",
  "swe@1: list price 0, r none, base cost 0",
  "re@1: list price 0, r none, base cost 0",
  "cap_usd of each call: 15",
];
const AC9_REPORT_LINES = ["invalid diagnoses: 4", "verdict complete"];
const AC8_EVAL = "e8";
const AC8B_EVAL = "e8b";
const AC8_ASPECT = "A5";
const AC8_HYPOTHESIS = "name the test command";
const AC10_EVAL = "e10";
const AC10B_EVAL = "e10b";
const AC10B_REPLICATE = AC10_EVAL;
const TEXT_FIXTURE = "fixture";
const TEXT_BACKEND_FIXTURE = "backend fixture";
const TEXT_FRONTEND_FIXTURE = "frontend fixture";
const TEXT_TEST_NEW_SH = "test/new.sh";
const XS_WORK = ["kanthord", "evaluation", "work"];

function lines(text: string): string[] {
  return text.split("\n").filter(Boolean);
}

async function jsonLines<T>(path: string): Promise<T[]> {
  const text = await asTestUser(["cat", path]);
  return lines(text).map((line) => JSON.parse(line) as T);
}

function caseOf(session: string): string {
  return basename(dirname(dirname(session)));
}

function checkValues(line: CheckLine): (boolean | string | null)[] {
  return [line.a1, line.a2, line.a3, line.a4, line.pass, line.breach];
}

function checksOf(checks: CheckLine[], caseId: string): CheckLine[] {
  return checks.filter((line) => line.case === caseId);
}

function sweLines(results: ResultLine[]): ResultLine[] {
  return results.filter((line) => line.agent === AGENT_SWE);
}

function sweRequests(
  requests: StubRequestRecord[],
  task: string,
): StubRequestRecord[] {
  return requests.filter(
    (record) =>
      record.selectedRole === AGENT_SWE && record.selectedTask === task,
  );
}

function holds(record: StubRequestRecord, text: string): boolean {
  return JSON.stringify(record.body).includes(text);
}

async function runAndReport(
  fixture: EvaluationFixture,
  args: string[],
  signal: AbortSignal,
): Promise<void> {
  const run = await runnerAsTestUser(fixture, { script: RUN_SH, args, signal });
  assert.equal(run.status, SUCCESS_EXIT, run.stderr);
  const report = await runnerAsTestUser(fixture, {
    script: REPORT_SH,
    args: args.slice(0, 2),
    signal,
  });
  assert.equal(report.status, SUCCESS_EXIT, report.stderr);
}

function devArgs(evaluation: string, stage: string): string[] {
  return ["--evaluation", evaluation, "--stage", stage, "--set", SET_DEV];
}

async function assertReportLines(
  results: string,
  expected: string[],
): Promise<void> {
  const text = await asTestUser(["cat", join(results, "report.md")]);
  const reportLines = lines(text);
  for (const line of expected) assert.ok(reportLines.includes(line), text);
}

async function assertBaselineChecks(results: string): Promise<void> {
  const checks = await jsonLines<CheckLine>(join(results, "checks.jsonl"));
  assert.equal(checks.length, DEV_RUN_COUNT);
  assert.deepEqual(checksOf(checks, CASE_D1).map(checkValues), [
    D1_CHECK,
    D1_CHECK,
  ]);
  assert.deepEqual(checksOf(checks, CASE_D2).map(checkValues), [
    D2_CHECK,
    D2_CHECK,
  ]);
}

test(
  "L4-AC4: the held-out evaluation gives the gate verdict with no diagnosis",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder(),
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);
    const results = join(fixture.runs, "e4");

    const run = await runnerAsTestUser(fixture, {
      script: RUN_SH,
      args: ["--evaluation", "e4", "--stage", "1", "--set", "held-out"],
      signal: t.signal,
    });
    assert.equal(run.status, SUCCESS_EXIT, run.stderr);
    const report = await runnerAsTestUser(fixture, {
      script: REPORT_SH,
      args: ["--evaluation", "e4"],
      signal: t.signal,
    });
    assert.equal(report.status, SUCCESS_EXIT, report.stderr);

    const resultLines = lines(
      await asTestUser(["cat", join(results, "results.jsonl")]),
    ).map((line) => JSON.parse(line) as ResultLine);
    assert.deepEqual(
      resultLines.map((line) => line.agent),
      AC4_RESULT_AGENTS,
    );

    const files = lines(
      await asTestUser(["find", results, "-type", "f", "-printf", "%P\\n"]),
    );
    for (const session of AC4_SESSIONS) assert.ok(files.includes(session));
    assert.deepEqual(
      files.filter((file) => AC4_ABSENT_FILES.includes(basename(file))),
      [],
    );

    const reportText = await asTestUser(["cat", join(results, "report.md")]);
    const gate = lines(reportText).find((line) => line.startsWith(GATE_PREFIX));
    assert.ok(gate !== undefined, reportText);
    const parts = gate.slice(GATE_PREFIX.length).split(", ");
    for (const part of AC4_GATE_PARTS) assert.ok(parts.includes(part), gate);
    assert.ok(!reportText.includes(AC4_CASE), reportText);
  },
);

test(
  "L4-AC1: a dev evaluation grades each run in a new clone, and the diagnosis reads each run",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder(),
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);
    const results = join(fixture.runs, "e1");

    await runAndReport(fixture, devArgs("e1", "1"), t.signal);

    const resultLines = await jsonLines<ResultLine>(
      join(results, "results.jsonl"),
    );
    assert.deepEqual(
      resultLines.map((line) => line.agent).sort(),
      AC1_RESULT_AGENTS,
    );
    for (const caseId of DEV_CASES) {
      const digests = sweLines(resultLines)
        .filter((line) => caseOf(line.session) === caseId)
        .map((line) => line.input_digest);
      assert.equal(digests.length, REPEATS, caseId);
      assert.equal(new Set(digests).size, ONE_DIGEST, caseId);
    }

    const requests = stub.requests.filter(
      (record) => record.selectedRole === AGENT_SWE,
    );
    assert.ok(requests.length >= DEV_RUN_COUNT);
    assert.deepEqual(
      requests.filter((record) => holds(record, TEXT_FIXTURE)),
      [],
    );

    await assertBaselineChecks(results);

    const diagnoses = await jsonLines<DiagnosisLine>(
      join(results, "diagnoses.jsonl"),
    );
    assert.equal(diagnoses.length, DEV_RUN_COUNT);
    for (const line of diagnoses) {
      assert.equal(line.valid, true);
      assert.deepEqual(
        line.findings.map(({ aspect, severity }) => ({ aspect, severity })),
        AC1_FINDINGS,
      );
    }

    await assertReportLines(results, AC1_REPORT_LINES);

    for (const run of DEV_RUNS) {
      const files = lines(await asTestUser(["ls", "-A", join(results, run)]));
      assert.deepEqual(files.sort(), DEV_RUN_FILES, run);
    }
    const emptyDiffs = lines(
      await asTestUser([
        "find",
        join(results, CASE_D2),
        "-name",
        "diff.patch",
        "-empty",
      ]),
    );
    assert.equal(emptyDiffs.length, REPEATS);

    const roots = await asTestUser([
      "find",
      join(fixture.xs, ...XS_WORK),
      "-mindepth",
      "1",
    ]);
    assert.equal(roots, NO_OUTPUT);
    const status = await asTestUser([
      "git",
      "-C",
      fixture.set,
      "status",
      "--porcelain",
    ]);
    assert.equal(status, NO_OUTPUT);
  },
);

test(
  "L4-AC2: the hidden tests replace the agent files of the same name, and a change outside the scope fails A3",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder({ firstTurns: { [TASK_D2]: WRITE_NEW_SH_TURN } }),
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);
    const results = join(fixture.runs, "e2");

    await runAndReport(fixture, devArgs("e2", "1"), t.signal);

    const checks = await jsonLines<CheckLine>(join(results, "checks.jsonl"));
    assert.deepEqual(
      checksOf(checks, CASE_D2).map((line) => [line.a1, line.a3, line.pass]),
      [
        [false, false, false],
        [false, false, false],
      ],
    );

    const diffs = lines(
      await asTestUser([
        "grep",
        "-l",
        "-F",
        "-r",
        "--include=diff.patch",
        TEXT_TEST_NEW_SH,
        join(results, CASE_D2),
      ]),
    );
    assert.equal(diffs.length, REPEATS);
  },
);

test(
  "L4-AC3: stage 2 gives the kind prompt of the case kind",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder(),
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);

    await runAndReport(fixture, devArgs("e1", "1"), t.signal);
    const stageOneRequests = stub.requests.length;
    await runAndReport(fixture, devArgs("e3", "2"), t.signal);

    const requests = stub.requests.slice(stageOneRequests);
    const d1 = sweRequests(requests, TASK_D1);
    const d2 = sweRequests(requests, TASK_D2);
    assert.ok(d1.length >= REPEATS);
    assert.ok(d2.length >= REPEATS);
    for (const record of d1) {
      assert.equal(holds(record, TEXT_BACKEND_FIXTURE), true);
      assert.equal(holds(record, TEXT_FRONTEND_FIXTURE), false);
    }
    for (const record of d2) {
      assert.equal(holds(record, TEXT_FRONTEND_FIXTURE), true);
      assert.equal(holds(record, TEXT_BACKEND_FIXTURE), false);
    }

    const stageOne = sweLines(
      await jsonLines<ResultLine>(join(fixture.runs, "e1", "results.jsonl")),
    );
    const stageTwo = sweLines(
      await jsonLines<ResultLine>(join(fixture.runs, "e3", "results.jsonl")),
    );
    assert.equal(stageOne.length, DEV_RUN_COUNT);
    assert.equal(stageTwo.length, DEV_RUN_COUNT);
    for (const line of stageTwo) {
      const earlier = stageOne
        .filter((other) => caseOf(other.session) === caseOf(line.session))
        .map((other) => other.input_digest);
      assert.equal(earlier.length, REPEATS);
      assert.equal(earlier.includes(line.input_digest), false);
    }
  },
);

test(
  "L4-AC9: an invalid diagnosis changes no pass",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder({ reTurn: NO_FINDINGS_TURN }),
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);
    const results = join(fixture.runs, "e9");

    await runAndReport(fixture, devArgs("e9", "1"), t.signal);

    const diagnoses = await jsonLines<DiagnosisLine>(
      join(results, "diagnoses.jsonl"),
    );
    assert.deepEqual(
      diagnoses.map((line) => [line.valid, line.findings.length]),
      Array.from({ length: DEV_RUN_COUNT }, () => [false, 0]),
    );
    await assertBaselineChecks(results);
    await assertReportLines(results, AC9_REPORT_LINES);
  },
);

const AC5_EVAL = "e5";
const AC5_ARGS = ["--evaluation", AC5_EVAL, "--stage", "1", "--set", SET_DEV];
const AC5_BREACH_LINES = 1;
const AC5_NO_RE_REQUESTS = 0;
const AC5_PROTECTED_PATH = "protected_path";
const AC5_CREDENTIAL = "credential";
const AC5_SET_CHANGE = "set_change";
const AC5_REPORT_1_BREACH = "A9 breaches: 1";
const K_PARTIAL_LEN = 8;
const AC5_AUTH = join(TEST_USER_HOME, ".config", "kanthord", "auth.json");
const AC5_AUTH_MODE = "600";
const AC5_COUNT_ONE = /count 1\n/;
const AC5_COUNT_ABOVE_ZERO = /count [1-9]/;

async function authDigest(): Promise<string> {
  const output = await asTestUser(["sha256sum", AC5_AUTH]);
  return output.split(" ")[0]!;
}

async function authMode(): Promise<string> {
  const output = await asTestUser(["stat", "-c", "%a", AC5_AUTH]);
  return output.trim();
}

async function ac5Run(fixture: EvaluationFixture, signal: AbortSignal) {
  return runnerAsTestUser(fixture, {
    script: RUN_SH,
    args: AC5_ARGS,
    signal,
  });
}

async function ac5Report(fixture: EvaluationFixture, signal: AbortSignal) {
  return runnerAsTestUser(fixture, {
    script: REPORT_SH,
    args: ["--evaluation", AC5_EVAL],
    signal,
  });
}

test(
  "L4-AC5 variant 1: reading a protected path stops the evaluation with breach protected_path",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const variables: Record<string, string> = { $E: "" };
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder({ firstTurns: { [TASK_D1]: READ_CHECK_TURN } }),
      variables,
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);
    variables.$E = fixture.set;
    const results = join(fixture.runs, AC5_EVAL);

    const run = await ac5Run(fixture, t.signal);
    assert.equal(run.status, BREACH_EXIT, run.stderr);

    const checks = await jsonLines<CheckLine>(join(results, "checks.jsonl"));
    assert.equal(checks.length, AC5_BREACH_LINES);
    assert.equal(checks[0]!.breach, AC5_PROTECTED_PATH);
    assert.equal(checks[0]!.pass, false);

    const reRequests = stub.requests.filter(
      (r) => r.selectedRole !== AGENT_SWE,
    );
    assert.equal(reRequests.length, AC5_NO_RE_REQUESTS);

    const report = await ac5Report(fixture, t.signal);
    assert.equal(report.status, NO_VERDICT_EXIT, report.stderr);
    const reportText = await asTestUser(["cat", join(results, "report.md")]);
    assert.ok(reportText.includes(AC5_REPORT_1_BREACH), reportText);
    assert.ok(reportText.includes(AC5_PROTECTED_PATH), reportText);
  },
);

test(
  "L4-AC5 variant 2: a credential value in the session text stops the evaluation and leaves no credential in records",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const credTurn = {
      kind: "text" as const,
      text: `done with ${TEST_K}`,
      usage: { input: 1000, output: 100 },
    };
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder({ answeredTurns: { [TASK_D1]: credTurn } }),
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);
    const results = join(fixture.runs, AC5_EVAL);
    const digestBefore = await authDigest();
    assert.equal(await authMode(), AC5_AUTH_MODE);

    const run = await ac5Run(fixture, t.signal);
    assert.equal(run.status, BREACH_EXIT, run.stderr);
    assert.match(run.stdout, AC5_COUNT_ONE);
    assert.equal(await authDigest(), digestBefore);
    assert.equal(await authMode(), AC5_AUTH_MODE);
    assert.equal(run.stdout.includes(TEST_K.slice(0, K_PARTIAL_LEN)), false);

    const checks = await jsonLines<CheckLine>(join(results, "checks.jsonl"));
    assert.equal(checks.length, AC5_BREACH_LINES);
    assert.equal(checks[0]!.breach, AC5_CREDENTIAL);

    for (const name of [
      "results.jsonl",
      "checks.jsonl",
      "calls.jsonl",
      "iteration.json",
      "report.md",
    ]) {
      const text = await asTestUser(["cat", join(results, name)]);
      assert.equal(text.includes(TEST_K), false, name);
    }

    const stderrFiles = lines(
      await asTestUser(["find", results, "-name", "stderr.txt"]),
    );
    assert.equal(stderrFiles.length, AC5_BREACH_LINES);
    for (const path of stderrFiles) {
      const text = await asTestUser(["cat", path]);
      assert.equal(text.includes(TEST_K), false, path);
    }

    const eFiles = lines(await asTestUser(["find", fixture.set, "-type", "f"]));
    for (const path of eFiles) {
      const text = await asTestUser(["cat", path]);
      assert.equal(text.includes(TEST_K), false, path);
    }
  },
);

test(
  "L4-AC5 variant 3: git inspect in a workspace clone finds no path of E",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder({ firstTurns: { [TASK_D1]: GIT_INSPECT_TURN } }),
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);
    const results = join(fixture.runs, AC5_EVAL);

    await runAndReport(fixture, AC5_ARGS, t.signal);

    const checks = await jsonLines<CheckLine>(join(results, "checks.jsonl"));
    assert.equal(checks.length, DEV_RUN_COUNT);
    for (const line of checks) assert.equal(line.breach, null);

    const sessions = lines(
      await asTestUser(["find", results, "-name", "session.jsonl"]),
    );
    assert.equal(sessions.length, DEV_RUN_COUNT);
    for (const path of sessions) {
      const text = await asTestUser(["cat", path]);
      assert.equal(text.includes(fixture.set), false, path);
    }
  },
);

test(
  "L4-AC5 variant 4: copying auth.json into the workspace is the breach credential",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder({ firstTurns: { [TASK_D1]: COPY_AUTH_TURN } }),
      variables: { $H: TEST_USER_HOME },
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);
    const results = join(fixture.runs, AC5_EVAL);
    const runDir = join(results, CASE_D1, "1-1");

    const run = await ac5Run(fixture, t.signal);
    assert.equal(run.status, BREACH_EXIT, run.stderr);
    assert.match(run.stdout, AC5_COUNT_ABOVE_ZERO);
    assert.equal(run.stdout.includes(TEST_K.slice(0, K_PARTIAL_LEN)), false);

    const checks = await jsonLines<CheckLine>(join(results, "checks.jsonl"));
    assert.equal(checks.length, AC5_BREACH_LINES);
    assert.equal(checks[0]!.breach, AC5_CREDENTIAL);

    const runFiles = lines(
      await asTestUser(["find", runDir, "-type", "f", "-printf", "%P\\n"]),
    );
    assert.equal(runFiles.includes("diff.patch"), false);
    assert.equal(runFiles.includes("check.txt"), false);

    const rFiles = lines(await asTestUser(["find", results, "-type", "f"]));
    for (const path of rFiles) {
      const text = await asTestUser(["cat", path]);
      assert.equal(text.includes(TEST_K), false, path);
    }

    const reRequests = stub.requests.filter(
      (r) => r.selectedRole !== AGENT_SWE,
    );
    assert.equal(reRequests.length, AC5_NO_RE_REQUESTS);
  },
);

test(
  "L4-AC5 variant 5: modifying the eval set stops the evaluation with breach set_change",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const variables: Record<string, string> = { $XD: "" };
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder({ firstTurns: { [TASK_D1]: TOUCH_SET_TURN } }),
      variables,
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);
    variables.$XD = fixture.xd;
    const results = join(fixture.runs, AC5_EVAL);

    const run = await ac5Run(fixture, t.signal);
    assert.equal(run.status, BREACH_EXIT, run.stderr);

    const checks = await jsonLines<CheckLine>(join(results, "checks.jsonl"));
    assert.equal(checks.length, AC5_BREACH_LINES);
    assert.equal(checks[0]!.breach, AC5_SET_CHANGE);
  },
);

interface RetryResultLine {
  agent: string;
  session: string;
  workspace: string;
  class: string;
}

const AC6_HELD_OUT_ARGS = [
  "--evaluation",
  "e6",
  "--stage",
  "1",
  "--set",
  "held-out",
];
const AC6_REPORT_ARGS = ["--evaluation", "e6"];
const AC6_RETRY_COUNT = 3;
const AC6_CASE = "h1";
const AC6_RESUME_SESSIONS = ["h1/1-4/session.jsonl", "h1/2-1/session.jsonl"];
const AC6_NO_VERDICT = "verdict no verdict";
const AC6_PASS = "verdict pass";
const AC6_FAILED_SETUP = "exit 1\n";
const AC6_SET_CHANGE = "new\n";
const SET_AUTHOR = [
  "-c",
  "user.name=Kanthor Eval",
  "-c",
  "user.email=eval@kanthorlabs.invalid",
];
const AC6_CLASS_RETRYABLE = "retryable";
const AC6_AUTH_ENTRY_MISSING = "cli.run.agent.auth_entry_missing";
const AC6B_EVAL = "e6b";
const AC6C_EVAL = "e6c";
const AC6D_EVAL = "e6d";
const AC7_EVAL = "e7";
const AC7_CAP_USD = 15;
const AC7_UNSTARTED = "unstarted runs: 4, unstarted diagnoses: 4";
const AC7_CAP_LINE = `cap_usd of each call: ${AC7_CAP_USD}`;
const AC7_REPORT_LINES = [
  "swe@1: list price 0, r none, base cost 0",
  "re@1: list price 0, r none, base cost 0",
  "swe@1: base cost of one run: mean none, maximum none",
  "re@1: base cost of one run: mean none, maximum none",
  AC7_CAP_LINE,
  AC7_UNSTARTED,
];
const AC7_USD = "16usd";
const NO_REQUESTS = 0;
const ONE_CALL = 1;

async function gateParts(results: string): Promise<string[]> {
  const text = await asTestUser(["cat", join(results, "report.md")]);
  const gate = lines(text).find((line) => line.startsWith(GATE_PREFIX));
  assert.ok(gate !== undefined, text);
  return gate.slice(GATE_PREFIX.length).split(", ");
}

async function commitSet(set: string): Promise<void> {
  await asTestUser(["git", "-C", set, "add", "."]);
  await asTestUser([
    "git",
    "-C",
    set,
    ...SET_AUTHOR,
    "commit",
    "-q",
    "-m",
    "change",
  ]);
}

test(
  "L4-AC6 variant 1: a stop at HTTP 429 leaves no verdict, and a resume completes the evaluation",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub1 = await llmStub(t, [], ENGINE_ROOT, {
      fixedStatus: {
        status: 429,
        body: '{"error":{"message":"rate limit exceeded"}}',
      },
    });
    const fixture = await buildEvaluationSet(t, stub1.baseUrl);
    const results = join(fixture.runs, "e6");

    const run1 = await runnerAsTestUser(fixture, {
      script: RUN_SH,
      args: AC6_HELD_OUT_ARGS,
      signal: t.signal,
    });
    assert.equal(run1.status, BREACH_EXIT, run1.stderr);

    const retryLines = await jsonLines<RetryResultLine>(
      join(results, "results.jsonl"),
    );
    assert.equal(retryLines.length, AC6_RETRY_COUNT);
    for (const line of retryLines) {
      assert.equal(line.agent, AGENT_SWE);
      assert.equal(caseOf(line.session), AC6_CASE);
      assert.equal(line.class, AC6_CLASS_RETRYABLE);
    }
    assert.equal(
      new Set(retryLines.map((l) => l.session)).size,
      AC6_RETRY_COUNT,
    );
    assert.equal(
      new Set(retryLines.map((l) => l.workspace)).size,
      AC6_RETRY_COUNT,
    );

    const noChecks = (
      await asTestUser([
        "find",
        results,
        "-maxdepth",
        "1",
        "-name",
        "checks.jsonl",
      ])
    ).trim();
    assert.equal(noChecks, NO_OUTPUT);

    assert.ok((await gateParts(results)).includes(AC6_NO_VERDICT));

    const report1 = await runnerAsTestUser(fixture, {
      script: REPORT_SH,
      args: AC6_REPORT_ARGS,
      signal: t.signal,
    });
    assert.equal(report1.status, NO_VERDICT_EXIT, report1.stderr);
    assert.ok((await gateParts(results)).includes(AC6_NO_VERDICT));

    const stub2 = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder(),
    });
    await writeFileAsTestUser(
      join(TEST_USER_HOME, ".config", "kanthord", "auth.json"),
      authFileText(TEST_K, stub2.baseUrl),
    );

    const run2 = await runnerAsTestUser(fixture, {
      script: RUN_SH,
      args: AC6_HELD_OUT_ARGS,
      signal: t.signal,
    });
    assert.equal(run2.status, SUCCESS_EXIT, run2.stderr);

    const checks2 = await jsonLines<CheckLine>(join(results, "checks.jsonl"));
    assert.deepEqual(
      checks2.map((line) => line.session),
      AC6_RESUME_SESSIONS.map((session) => join(results, session)),
    );

    const report2 = await runnerAsTestUser(fixture, {
      script: REPORT_SH,
      args: AC6_REPORT_ARGS,
      signal: t.signal,
    });
    assert.equal(report2.status, SUCCESS_EXIT, report2.stderr);
    assert.ok((await gateParts(results)).includes(AC6_PASS));
  },
);

test(
  "L4-AC6 variant 2: auth_entry_missing exits 1 with no result line and a report",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder(),
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);
    const results = join(fixture.runs, AC6B_EVAL);
    const args = [
      "--evaluation",
      AC6B_EVAL,
      "--stage",
      "1",
      "--set",
      "held-out",
    ];

    await writeFileAsTestUser(
      join(TEST_USER_HOME, ".config", "kanthord", "auth.json"),
      JSON.stringify({}),
    );

    const run = await runnerAsTestUser(fixture, {
      script: RUN_SH,
      args,
      signal: t.signal,
    });
    assert.equal(run.status, BREACH_EXIT, run.stderr);

    const noResults = (
      await asTestUser([
        "find",
        results,
        "-maxdepth",
        "1",
        "-name",
        "results.jsonl",
      ])
    ).trim();
    assert.equal(noResults, NO_OUTPUT);

    const stderrText = await asTestUser([
      "cat",
      join(results, "h1", "1-1", "stderr.txt"),
    ]);
    assert.ok(stderrText.startsWith(AC6_AUTH_ENTRY_MISSING), stderrText);

    await asTestUser(["test", "-f", join(results, "report.md")]);
  },
);

test(
  "L4-AC6 variant 3: a failed setup.sh exits 1 with no request and no workspace root",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder(),
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);
    const args = [
      "--evaluation",
      AC6C_EVAL,
      "--stage",
      "1",
      "--set",
      "held-out",
    ];

    await writeFileAsTestUser(
      join(fixture.set, "cases", "held-out", AC6_CASE, "setup.sh"),
      AC6_FAILED_SETUP,
    );
    await commitSet(fixture.set);

    const run = await runnerAsTestUser(fixture, {
      script: RUN_SH,
      args,
      signal: t.signal,
    });
    assert.equal(run.status, BREACH_EXIT, run.stderr);

    assert.equal(stub.requests.length, NO_REQUESTS);

    const roots = await asTestUser([
      "find",
      join(fixture.xs, ...XS_WORK),
      "-mindepth",
      "1",
    ]);
    assert.equal(roots, NO_OUTPUT);
  },
);

test(
  "L4-AC6 variant 4: a new set commit stops the second call with set_commit in stderr",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder(),
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);
    const args = [
      "--evaluation",
      AC6D_EVAL,
      "--stage",
      "1",
      "--set",
      "held-out",
    ];

    const run1 = await runnerAsTestUser(fixture, {
      script: RUN_SH,
      args,
      signal: t.signal,
    });
    assert.equal(run1.status, SUCCESS_EXIT, run1.stderr);

    await writeFileAsTestUser(join(fixture.set, "README.md"), AC6_SET_CHANGE);
    await commitSet(fixture.set);

    const requestsBeforeSecond = stub.requests.length;
    const run2 = await runnerAsTestUser(fixture, {
      script: RUN_SH,
      args,
      signal: t.signal,
    });
    assert.equal(run2.status, BREACH_EXIT, run2.stderr);
    assert.match(run2.stderr, /set_commit/);
    assert.equal(stub.requests.length, requestsBeforeSecond);
  },
);

test(
  "L4-AC7: the cap stops the evaluation before a run",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder(),
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);
    const results = join(fixture.runs, AC7_EVAL);

    for (const caseId of DEV_CASES) {
      const casePath = join(fixture.set, "cases", "dev", caseId);
      const caseText = await asTestUser(["cat", join(casePath, "case.json")]);
      const caseJson = JSON.parse(caseText) as Record<string, unknown>;
      await writeFileAsTestUser(
        join(casePath, "case.json"),
        JSON.stringify({ ...caseJson, usd: AC7_USD }),
      );
    }
    await commitSet(fixture.set);

    const run = await runnerAsTestUser(fixture, {
      script: RUN_SH,
      args: devArgs(AC7_EVAL, "1"),
      signal: t.signal,
    });
    assert.equal(run.status, CAP_EXIT, run.stderr);

    assert.equal(stub.requests.length, NO_REQUESTS);

    const noResults = (
      await asTestUser([
        "find",
        results,
        "-maxdepth",
        "1",
        "-name",
        "results.jsonl",
      ])
    ).trim();
    assert.equal(noResults, NO_OUTPUT);

    const calls = await jsonLines<{ cap_usd: number }>(
      join(results, "calls.jsonl"),
    );
    assert.equal(calls.length, ONE_CALL);
    assert.equal(calls[0]!.cap_usd, AC7_CAP_USD);

    const report = await runnerAsTestUser(fixture, {
      script: REPORT_SH,
      args: ["--evaluation", AC7_EVAL],
      signal: t.signal,
    });
    assert.equal(report.status, NO_VERDICT_EXIT, report.stderr);

    await assertReportLines(results, AC7_REPORT_LINES);
  },
);

test(
  "L4-AC8: report.sh refuses an iteration with no prompt change",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder(),
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);
    const resultsE8b = join(fixture.runs, AC8B_EVAL);

    const run1 = await runnerAsTestUser(fixture, {
      script: RUN_SH,
      args: devArgs(AC8_EVAL, "1"),
      signal: t.signal,
    });
    assert.equal(run1.status, SUCCESS_EXIT, run1.stderr);

    const run2 = await runnerAsTestUser(fixture, {
      script: RUN_SH,
      args: [
        "--evaluation",
        AC8B_EVAL,
        "--stage",
        "1",
        "--set",
        "dev",
        "--parent",
        AC8_EVAL,
        "--aspect",
        AC8_ASPECT,
        "--hypothesis",
        AC8_HYPOTHESIS,
      ],
      signal: t.signal,
    });
    assert.equal(run2.status, SUCCESS_EXIT, run2.stderr);

    const iterationText = await asTestUser([
      "cat",
      join(resultsE8b, "iteration.json"),
    ]);
    const iteration = JSON.parse(iterationText) as {
      parent: string;
      aspect: string;
      hypothesis: string;
    };
    assert.equal(iteration.parent, AC8_EVAL);
    assert.equal(iteration.aspect, AC8_ASPECT);
    assert.equal(iteration.hypothesis, AC8_HYPOTHESIS);

    const report = await runnerAsTestUser(fixture, {
      script: REPORT_SH,
      args: ["--evaluation", AC8B_EVAL],
      signal: t.signal,
    });
    assert.equal(report.status, BREACH_EXIT, report.stderr);
    assert.match(report.stderr, /system_prompt_digest/);

    const noReport = (
      await asTestUser([
        "find",
        resultsE8b,
        "-maxdepth",
        "1",
        "-name",
        "report.md",
      ])
    ).trim();
    assert.equal(noReport, NO_OUTPUT);
  },
);

test(
  "L4-AC10: an A/A pair gives the A/A line",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder(),
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);
    const resultsE10b = join(fixture.runs, AC10B_EVAL);

    const run1 = await runnerAsTestUser(fixture, {
      script: RUN_SH,
      args: devArgs(AC10_EVAL, "1"),
      signal: t.signal,
    });
    assert.equal(run1.status, SUCCESS_EXIT, run1.stderr);

    const run2 = await runnerAsTestUser(fixture, {
      script: RUN_SH,
      args: [
        "--evaluation",
        AC10B_EVAL,
        "--stage",
        "1",
        "--set",
        "dev",
        "--replicate",
        AC10B_REPLICATE,
      ],
      signal: t.signal,
    });
    assert.equal(run2.status, SUCCESS_EXIT, run2.stderr);

    const iterationText = await asTestUser([
      "cat",
      join(resultsE10b, "iteration.json"),
    ]);
    const iterationE10b = JSON.parse(iterationText) as { replicate: string };
    assert.equal(iterationE10b.replicate, AC10B_REPLICATE);

    const report = await runnerAsTestUser(fixture, {
      script: REPORT_SH,
      args: ["--evaluation", AC10B_EVAL],
      signal: t.signal,
    });
    assert.equal(report.status, SUCCESS_EXIT, report.stderr);

    const reportText = await asTestUser([
      "cat",
      join(resultsE10b, "report.md"),
    ]);
    assert.match(
      reportText,
      /^A\/A: A1 2 2 diff 0 flips 0, .*, passes 2 2 diff 0$/m,
    );
  },
);

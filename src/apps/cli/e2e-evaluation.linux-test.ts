import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import type { EvaluationFixture } from "./e2e-evaluation-test-support.ts";
import { ENGINE_ROOT } from "./e2e-run-agent-test-support.ts";
import { llmStub } from "./e2e-llm-stub-test-support.ts";
import type { StubRequestRecord } from "./e2e-llm-stub-test-support.ts";
import {
  AGENT_SWE,
  asTestUser,
  buildEvaluationSet,
  l4Responder,
  NO_FINDINGS_TURN,
  runnerAsTestUser,
  TASK_D1,
  TASK_D2,
  WRITE_NEW_SH_TURN,
} from "./e2e-evaluation-test-support.ts";

interface ResultLine {
  agent: string;
  session: string;
  input_digest: string;
}

interface CheckLine {
  case: string;
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

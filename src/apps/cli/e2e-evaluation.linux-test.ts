import assert from "node:assert/strict";
import { basename, join } from "node:path";
import test from "node:test";
import type { EvaluationFixture } from "./e2e-evaluation-test-support.ts";
import { ENGINE_ROOT } from "./e2e-run-agent-test-support.ts";
import { llmStub } from "./e2e-llm-stub-test-support.ts";
import {
  asTestUser,
  buildEvaluationSet,
  l4Responder,
  l4ResponderAC2,
  l4ResponderAC9,
  runnerAsTestUser,
} from "./e2e-evaluation-test-support.ts";

interface ResultLine {
  agent: string;
  input_digest?: string;
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

interface DiagnosisLine {
  valid: boolean;
  findings: Array<{ aspect: string; severity: string }>;
}

const RUNNER = join(ENGINE_ROOT, "scripts", "evaluation", "agent");
const RUN_SH = join(RUNNER, "run.sh");
const REPORT_SH = join(RUNNER, "report.sh");
const TEST_TIMEOUT_MS = 300000;
const SUCCESS_EXIT = 0;
const GATE_PREFIX = "gate: ";
const XS_WORK = ["kanthord", "evaluation", "work"];
const AGENT_SWE = "swe@1";
const AGENT_RE = "re@1";
const CASE_D1 = "d1";
const CASE_D2 = "d2";
const ASPECT_A5 = "A5";
const SESSION_PATH_SEP_D1 = "/d1/";
const TEXT_BACKEND_FIXTURE = "backend fixture";
const TEXT_FRONTEND_FIXTURE = "frontend fixture";
const TEXT_TEST_NEW_SH = "test/new.sh";

function jsonLines<T>(text: string): T[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function runEval(
  fixture: EvaluationFixture,
  evalId: string,
  set: string,
  stage: string,
  signal: AbortSignal,
  extraArgs: string[] = [],
): Promise<{
  runStatus: number;
  reportStatus: number;
  runStderr: string;
  reportStderr: string;
}> {
  const run = await runnerAsTestUser(fixture, {
    script: RUN_SH,
    args: [
      "--evaluation",
      evalId,
      "--stage",
      stage,
      "--set",
      set,
      ...extraArgs,
    ],
    signal,
  });
  const report = await runnerAsTestUser(fixture, {
    script: REPORT_SH,
    args: ["--evaluation", evalId],
    signal,
  });
  return {
    runStatus: run.status ?? 1,
    reportStatus: report.status ?? 1,
    runStderr: run.stderr,
    reportStderr: report.stderr,
  };
}
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

function lines(text: string): string[] {
  return text.split("\n").filter(Boolean);
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

    const { runStatus, reportStatus, runStderr, reportStderr } = await runEval(
      fixture,
      "e1",
      "dev",
      "1",
      t.signal,
    );
    assert.equal(runStatus, SUCCESS_EXIT, runStderr);
    assert.equal(reportStatus, SUCCESS_EXIT, reportStderr);

    const resultLines = jsonLines<ResultLine>(
      await asTestUser(["cat", join(results, "results.jsonl")]),
    );
    const AC1_RESULT_COUNT = 4;
    const AC1_SWE_D1_MIN = 2;
    assert.equal(
      resultLines.filter((l) => l.agent === AGENT_SWE).length,
      AC1_RESULT_COUNT,
      "4 swe@1 lines",
    );
    assert.equal(
      resultLines.filter((l) => l.agent === AGENT_RE).length,
      AC1_RESULT_COUNT,
      "4 re@1 lines",
    );

    const sweD1 = resultLines.filter(
      (l) =>
        l.agent === AGENT_SWE &&
        (l as unknown as { session: string }).session.includes(
          SESSION_PATH_SEP_D1,
        ),
    );
    assert.ok(sweD1.length >= AC1_SWE_D1_MIN);
    const firstD1 = sweD1[0];
    assert.ok(
      sweD1.every((l) => l.input_digest === firstD1?.input_digest),
      "d1 swe@1 lines share one input_digest",
    );

    const checkLines = jsonLines<CheckLine>(
      await asTestUser(["cat", join(results, "checks.jsonl")]),
    );
    const AC1_CHECK_COUNT = 4;
    assert.equal(checkLines.length, AC1_CHECK_COUNT);
    for (const line of checkLines.filter((l) => l.case === CASE_D1)) {
      assert.deepEqual(
        [line.a1, line.a2, line.a3, line.a4, line.pass, line.breach],
        [true, true, true, true, true, null],
      );
    }
    for (const line of checkLines.filter((l) => l.case === CASE_D2)) {
      assert.deepEqual(
        [line.a1, line.a2, line.a3, line.a4, line.pass, line.breach],
        [false, true, true, true, false, null],
      );
    }

    const diagLines = jsonLines<DiagnosisLine>(
      await asTestUser(["cat", join(results, "diagnoses.jsonl")]),
    );
    const AC1_DIAG_COUNT = 4;
    assert.equal(diagLines.length, AC1_DIAG_COUNT);
    for (const diag of diagLines) {
      assert.equal(diag.valid, true, JSON.stringify(diag));
      const AC1_FINDING_COUNT = 1;
      assert.equal(diag.findings.length, AC1_FINDING_COUNT);
      assert.equal(diag.findings[0]?.aspect, ASPECT_A5);
    }

    const reportText = await asTestUser(["cat", join(results, "report.md")]);
    assert.match(reportText, /verdict complete/);
    assert.match(reportText, /swe@1: list price 0, r none, base cost 0/);
    assert.match(reportText, /re@1: list price 0, r none, base cost 0/);
    assert.match(reportText, /cap_usd of each call: 15/);

    const sweRequests = stub.requests.filter(
      (r) => r.selectedRole === AGENT_SWE,
    );
    for (const req of sweRequests) {
      assert.ok(
        !JSON.stringify(req.body).includes("fixture"),
        "no swe@1 request holds fixture",
      );
    }

    const workDir = join(fixture.xs, ...XS_WORK);
    const workExists = await asTestUser(["test", "-d", workDir])
      .then(() => true)
      .catch(() => false);
    assert.equal(workExists, false, "no workspace root remains");

    t.diagnostic("L4-AC1 fixture available for L4-AC3");
    (t as unknown as { fixture: EvaluationFixture }).fixture = fixture;
  },
);

test(
  "L4-AC2: the hidden tests replace the agent files, and a change outside scope fails A3",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4ResponderAC2(),
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);
    const results = join(fixture.runs, "e2");

    const { runStatus, reportStatus, runStderr, reportStderr } = await runEval(
      fixture,
      "e2",
      "dev",
      "1",
      t.signal,
    );
    assert.equal(runStatus, SUCCESS_EXIT, runStderr);
    assert.equal(reportStatus, SUCCESS_EXIT, reportStderr);

    const checkLines = jsonLines<CheckLine>(
      await asTestUser(["cat", join(results, "checks.jsonl")]),
    );
    for (const line of checkLines.filter((l) => l.case === CASE_D2)) {
      assert.equal(line.a1, false, "d2 a1 false");
      assert.equal(line.a3, false, "d2 a3 false");
      assert.equal(line.pass, false, "d2 pass false");
    }

    const d2Files = lines(
      await asTestUser(["find", join(results, CASE_D2), "-name", "diff.patch"]),
    );
    for (const f of d2Files) {
      const content = await asTestUser(["cat", f]);
      assert.ok(
        content.includes(TEXT_TEST_NEW_SH),
        `diff.patch of d2 holds test/new.sh: ${f}`,
      );
    }
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
    const results = join(fixture.runs, "e3");

    const { runStatus: run1Status, runStderr: run1Err } = await runEval(
      fixture,
      "e1ac3",
      "dev",
      "1",
      t.signal,
    );
    assert.equal(run1Status, SUCCESS_EXIT, run1Err);

    const { runStatus, reportStatus, runStderr, reportStderr } = await runEval(
      fixture,
      "e3",
      "dev",
      "2",
      t.signal,
    );
    assert.equal(runStatus, SUCCESS_EXIT, runStderr);
    assert.equal(reportStatus, SUCCESS_EXIT, reportStderr);

    const sweRequests = stub.requests.filter(
      (r) => r.selectedRole === AGENT_SWE,
    );
    const TASK_D1 = `task ${CASE_D1}`;
    const TASK_D2 = `task ${CASE_D2}`;

    const e3Bodies = sweRequests.slice(
      sweRequests.findIndex((r) => JSON.stringify(r.body).includes(TASK_D1)),
    );
    const d1Bodies = e3Bodies.filter((r) =>
      JSON.stringify(r.body).includes(TASK_D1),
    );
    const d2Bodies = e3Bodies.filter((r) =>
      JSON.stringify(r.body).includes(TASK_D2),
    );

    for (const req of d1Bodies) {
      assert.ok(
        JSON.stringify(req.body).includes(TEXT_BACKEND_FIXTURE),
        "d1 request holds backend fixture",
      );
      assert.ok(
        !JSON.stringify(req.body).includes(TEXT_FRONTEND_FIXTURE),
        "d1 request holds no frontend fixture",
      );
    }
    for (const req of d2Bodies) {
      assert.ok(
        JSON.stringify(req.body).includes(TEXT_FRONTEND_FIXTURE),
        "d2 request holds frontend fixture",
      );
      assert.ok(
        !JSON.stringify(req.body).includes(TEXT_BACKEND_FIXTURE),
        "d2 request holds no backend fixture",
      );
    }

    const e1Digests = jsonLines<ResultLine>(
      await asTestUser(["cat", join(fixture.runs, "e1ac3", "results.jsonl")]),
    )
      .filter((l) => l.agent === AGENT_SWE)
      .map((l) => l.input_digest);

    const e3Digests = jsonLines<ResultLine>(
      await asTestUser(["cat", join(results, "results.jsonl")]),
    )
      .filter((l) => l.agent === AGENT_SWE)
      .map((l) => l.input_digest);

    for (const d of e3Digests) {
      assert.ok(!e1Digests.includes(d), `e3 digest ${d} differs from e1`);
    }
  },
);

test(
  "L4-AC9: an invalid diagnosis changes no pass",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4ResponderAC9(),
    });
    const fixture = await buildEvaluationSet(t, stub.baseUrl);
    const results9 = join(fixture.runs, "e9");

    const { runStatus, reportStatus, runStderr, reportStderr } = await runEval(
      fixture,
      "e9",
      "dev",
      "1",
      t.signal,
    );
    assert.equal(runStatus, SUCCESS_EXIT, runStderr);
    assert.equal(reportStatus, SUCCESS_EXIT, reportStderr);

    const AC9_DIAG_COUNT = 4;
    const AC9_NO_FINDINGS = 0;
    const diagLines = jsonLines<DiagnosisLine>(
      await asTestUser(["cat", join(results9, "diagnoses.jsonl")]),
    );
    assert.equal(diagLines.length, AC9_DIAG_COUNT, "4 diagnosis lines");
    for (const diag of diagLines) {
      assert.equal(diag.valid, false, `valid false: ${JSON.stringify(diag)}`);
      assert.equal(
        diag.findings.length,
        AC9_NO_FINDINGS,
        `no findings: ${JSON.stringify(diag)}`,
      );
    }

    const stub1 = await llmStub(t, [], ENGINE_ROOT, {
      responder: l4Responder(),
    });
    const fixture1 = await buildEvaluationSet(t, stub1.baseUrl);
    const results1 = join(fixture1.runs, "e1cmp");
    const { runStatus: r1 } = await runEval(
      fixture1,
      "e1cmp",
      "dev",
      "1",
      t.signal,
    );
    assert.equal(r1, SUCCESS_EXIT);

    const checks9 = jsonLines<CheckLine>(
      await asTestUser(["cat", join(results9, "checks.jsonl")]),
    );
    const checks1 = jsonLines<CheckLine>(
      await asTestUser(["cat", join(results1, "checks.jsonl")]),
    );
    for (const c9 of checks9) {
      const c1 = checks1.find((c) => c.case === c9.case);
      if (!c1) continue;
      assert.equal(c9.pass, c1.pass, `pass unchanged for case ${c9.case}`);
    }

    const reportText = await asTestUser(["cat", join(results9, "report.md")]);
    assert.match(reportText, /invalid diagnoses: 4/);
    assert.match(reportText, /verdict complete/);
  },
);

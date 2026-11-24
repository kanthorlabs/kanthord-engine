import assert from "node:assert/strict";
import { basename, join } from "node:path";
import test from "node:test";
import { ENGINE_ROOT } from "./e2e-run-agent-test-support.ts";
import { llmStub } from "./e2e-llm-stub-test-support.ts";
import {
  asTestUser,
  buildEvaluationSet,
  l4Responder,
  runnerAsTestUser,
} from "./e2e-evaluation-test-support.ts";

interface ResultLine {
  agent: string;
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

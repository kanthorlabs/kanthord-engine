import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compare,
  type EvalRun,
  type HistoryEntry,
  PASS_RATE_THRESHOLD,
} from "./compare.ts";

const LATEST_RUN = "20260102-000000";
const REPEAT = 3;
const THIRD = 1 / REPEAT;
const TWO_THIRDS = 2 / REPEAT;
const EVERY_PASS = 1;
const NO_PASS = 0;

type CaseValue = EvalRun["cases"][number];

function caseOf(
  id: string,
  rate: number,
  digest = `digest-${id}`,
  rerun: number | null = null,
): CaseValue {
  return {
    case_id: id,
    case_digest: digest,
    pass_rate: rate,
    rerun_pass_rate: rerun,
    runs: [],
    reruns: [],
  };
}

function entryOf(name: string, cases: CaseValue[]): HistoryEntry {
  return {
    run: name,
    subject: "ops@1",
    engine_revision: "abc",
    configuration: {},
    prompt_digests: [],
    repeat: REPEAT,
    comparison: {
      baseline_run: null,
      regressed: [],
      improved: [],
      new: [],
      dropped: [],
      tokens_delta: 0,
      cost_delta: 0,
    },
    cases,
  };
}

test("invariant guard: verdict - cases match by case_digest and not by case_id", () => {
  const history = [
    entryOf("20260101-000000", [caseOf("alpha", EVERY_PASS, "old")]),
  ];
  const answer = compare({ cases: [caseOf("alpha", NO_PASS, "new")] }, history);
  assert.deepEqual(answer.new, ["alpha"]);
  assert.deepEqual(answer.regressed, []);
  assert.deepEqual(answer.dropped, ["alpha"]);
});

test("invariant guard: verdict - the latest history entry is the baseline", () => {
  const history = [
    entryOf("20260101-000000", [caseOf("alpha", EVERY_PASS)]),
    entryOf(LATEST_RUN, [caseOf("alpha", NO_PASS)]),
  ];
  const answer = compare({ cases: [caseOf("alpha", EVERY_PASS)] }, history);
  assert.equal(answer.baseline_run, LATEST_RUN);
  assert.deepEqual(answer.regressed, []);
  assert.deepEqual(answer.improved, ["alpha"]);
  const reversed = compare({ cases: [caseOf("alpha", NO_PASS)] }, [
    history[1]!,
    history[0]!,
  ]);
  assert.deepEqual(reversed.regressed, ["alpha"]);
});

test("invariant guard: verdict - a case regresses below the 2/3 threshold only", () => {
  assert.equal(PASS_RATE_THRESHOLD, TWO_THIRDS);
  const history = [entryOf("20260101-000000", [caseOf("alpha", EVERY_PASS)])];
  assert.deepEqual(
    compare({ cases: [caseOf("alpha", THIRD)] }, history).regressed,
    ["alpha"],
  );
  assert.deepEqual(
    compare({ cases: [caseOf("alpha", TWO_THIRDS)] }, history).regressed,
    [],
  );
});

test("invariant guard: verdict - a rerun at 2/3 clears a regression and a rerun at 1/3 keeps it", () => {
  const history = [entryOf("20260101-000000", [caseOf("alpha", EVERY_PASS)])];
  const cleared = caseOf("alpha", THIRD, "digest-alpha", TWO_THIRDS);
  const kept = caseOf("alpha", NO_PASS, "digest-alpha", THIRD);
  assert.deepEqual(compare({ cases: [cleared] }, history).regressed, []);
  assert.deepEqual(compare({ cases: [kept] }, history).regressed, ["alpha"]);
});

test("invariant guard: verdict - a baseline case with a passing rerun counts as passed", () => {
  const history = [
    entryOf("20260101-000000", [
      caseOf("alpha", THIRD, "digest-alpha", TWO_THIRDS),
    ]),
  ];
  const answer = compare({ cases: [caseOf("alpha", NO_PASS)] }, history);
  assert.deepEqual(answer.regressed, ["alpha"]);
});

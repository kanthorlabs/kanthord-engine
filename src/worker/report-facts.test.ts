import assert from "node:assert/strict";
import { test } from "node:test";
import type { Outcome } from "../mission/contract.ts";
import { reportFacts } from "./report-facts.ts";

const NODE = "node_01M4FWGWXKRKSNYM26ABGXB5YS";
const OUTCOME = "outcome_01M4FZ4YRJVFX0VEDN1XJ85RGR";
const OLDER_OUTCOME = "outcome_01M4FZ4YRJVFX0VEDN1XJ85RG0";
const ASSESSMENT = "assessment_01M4FYJNXEH374ETFZ7F3ZFVMB";

function outcome(id: string, createdAt: number): Outcome {
  return {
    id,
    node_id: NODE,
    attempt: 1,
    node_revision: 1,
    closing_event: "assessment-passed",
    result: "success",
    assessment_id: ASSESSMENT,
    evidence_ids: [],
    created_at: createdAt,
  } as Outcome;
}

test("report facts copy every identifier from the records and use the newest outcome", () => {
  const facts = reportFacts(
    [{ id: NODE, state: "Completed" }],
    [outcome(OLDER_OUTCOME, 1), outcome(OUTCOME, 2)],
    {
      tested_input: [
        { kind: "repository", binding_id: "binding_a", commit: "d6d4973" },
      ],
      results: [
        {
          command: "cd todoapp-repo && npm run verify",
          exit_code: 0,
          signal: null,
          timed_out: false,
        },
      ],
    },
  );
  assert.ok(facts.startsWith("## Facts recorded by KanthorD"));
  assert.ok(
    facts.includes(
      `| ${NODE} | \`${NODE}\` | Completed | \`${OUTCOME}\` | success | \`${ASSESSMENT}\` |`,
    ),
  );
  assert.ok(!facts.includes(OLDER_OUTCOME));
  assert.ok(facts.includes("- `binding_a` at `d6d4973`"));
  assert.ok(
    facts.includes(
      "| `cd todoapp-repo && npm run verify` | 0 | none | false |",
    ),
  );
});

test("report facts state that no verification ran without a repository", () => {
  assert.match(reportFacts([], [], null), /No final-snapshot verification ran/);
});

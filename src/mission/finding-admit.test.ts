import assert from "node:assert/strict";
import { test } from "node:test";
import { ZodError } from "zod";
import { createIdentity } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  FINDING_MAX,
  FINDING_TEXT_MAX_BYTES,
  FindingAction,
  FindingGround,
} from "./contract.ts";
import { refusedAt, reviewerFinding, reviewHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST_BLOCKER_LABEL = "B1";
const FINDINGS = "findings";
const FIRST_REVISION = 1;
const TOO_BIG = "too_big";

function zodAt(field: string) {
  return (error: unknown) =>
    error instanceof ZodError &&
    error.issues.some((issue) => issue.path.includes(field));
}

test("each field rule of a finding refuses the submit with an issue at findings", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  for (const findings of [
    [reviewerFinding("B1"), reviewerFinding("B1")],
    [reviewerFinding("B1", { action: FindingAction.No })],
    [reviewerFinding("B1", { ground: null })],
    [reviewerFinding("S1", { ground: FindingGround.Stated })],
    [reviewerFinding("S1", { task_id: createIdentity("task") })],
    [reviewerFinding("S1", { name: "   " })],
  ])
    await assert.rejects(
      h.submit({ ...h.notMet, findings }),
      refusedAt(FINDINGS),
    );
  await assert.rejects(
    h.submit({
      ...h.notMet,
      findings: [
        reviewerFinding("S1", { why: "x".repeat(FINDING_TEXT_MAX_BYTES + 1) }),
      ],
    }),
    refusedAt(FINDINGS, TOO_BIG),
  );
  await assert.rejects(
    h.submit({ findings: [reviewerFinding("B1")] }),
    refusedAt(FINDINGS),
  );
  for (const label of ["X1", "B0", "S1000", "b1"])
    await assert.rejects(
      h.submit({ ...h.notMet, findings: [reviewerFinding(label)] }),
      zodAt(FINDINGS),
    );
  await assert.rejects(
    h.submit({
      ...h.notMet,
      findings: [reviewerFinding("S1", { fix: "" })],
    }),
    zodAt(FINDINGS),
  );
  await assert.rejects(
    h.submit({
      ...h.notMet,
      findings: Array.from({ length: FINDING_MAX + 1 }, (_, index) =>
        reviewerFinding(`S${index + 1}`),
      ),
    }),
    zodAt(FINDINGS),
  );
  assert.deepEqual(await h.findings(), []);
});

test("a submit admits FINDING_MAX findings, the text bound and a task of the pinned revision", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  const taskId = createIdentity("task");
  h.store.transaction((tx) =>
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET tasks = ? WHERE node_id = ? AND revision = ?",
      )
      .run(
        JSON.stringify([
          {
            id: taskId,
            filename: "task.md",
            content: {
              name: "Task",
              requirement: "Requirement",
              criterion: "Criterion",
              verifications: ["true"],
              bindings: [],
            },
          },
        ]),
        h.node_id,
        FIRST_REVISION,
      ),
  );
  const bound = "é".repeat(FINDING_TEXT_MAX_BYTES / 2);
  await h.submit({
    ...h.notMet,
    findings: [
      reviewerFinding("B1", { task_id: taskId, description: bound }),
      ...Array.from({ length: FINDING_MAX - 1 }, (_, index) =>
        reviewerFinding(`S${index + 1}`, { action: FindingAction.No }),
      ),
    ],
  });
  const stored = await h.findings({ limit: String(FINDING_MAX) });
  assert.equal(stored.length, FINDING_MAX);
  assert.equal(stored[0]?.label, FIRST_BLOCKER_LABEL);
  assert.equal(stored[0]?.task_id, taskId);
  assert.equal(stored[0]?.description, bound);
});

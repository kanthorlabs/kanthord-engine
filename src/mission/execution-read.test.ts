import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  AssessmentResult,
  AssetKind,
  FindingAction,
  FindingStatus,
  MissionErrorCode,
  NodeState,
} from "./contract.ts";
import { canonicalJSON } from "../kernel/json.ts";
import {
  closeAttempt,
  insertAssessment,
  insertEvidence,
  insertOutcome,
  openAttempt,
} from "./record-store.ts";
import { getRevision } from "./node-read.ts";
import {
  insertDependency,
  insertNode,
  insertRevision,
  setNodeState,
} from "./store.ts";
import {
  evidenceHarness,
  executionHarness,
  reviewerFinding,
  reviewHarness,
} from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const NO_ATTEMPT = 0;
const NO_ITEMS = 0;
const FIRST_ITEM_INDEX = 0;
const FIRST_REVISION = 1;
const CREATED_AT = 1;
const FIRST_ATTEMPT = 1;
const SINGLE_ITEM = 1;
const SECOND_REVISION = 2;
const CLOSE_AT = 2;
const SECOND_ATTEMPT = 2;
const LATER_TS = 3;
const THIRD_REVISION = 3;
const PINNED = "Pinned";
const PINNED_FILENAME = "examine.md";

test("examine reads use outcome revisions, include discarded dependencies, minimize new dependencies and exclude retired dependencies", async (t) => {
  const h = executionHarness(t, IDENTITY);
  const childId = createIdentity("node");
  const freshId = createIdentity("node");
  const outcomeId = createIdentity("outcome");
  const evidenceId = createIdentity("evidence");
  h.store.transaction((tx) => {
    const base = getRevision(tx, h.node_id, FIRST_REVISION);
    for (const id of [childId, freshId]) {
      insertNode(tx, {
        id,
        mission_id: h.mission_id,
        filename: `${id.toLowerCase()}.md`,
        created_at: CREATED_AT,
      });
      insertRevision(tx, {
        ...base,
        node_id: id,
        content: { ...base.content, name: PINNED },
        tasks: [],
      });
      insertDependency(tx, h.mission_id, h.node_id, id);
    }
    setNodeState(tx, childId, NodeState.Discarded);
    insertEvidence(
      tx,
      {
        id: evidenceId,
        node_id: childId,
        attempt: NO_ATTEMPT,
        subject: "Historical",
        requirement_key: null,
        end_state: null,
        verification: null,
        provenance: canonicalJSON(h.actor),
        created_at: CREATED_AT,
      },
      [],
    );
    const assessmentId = createIdentity("assessment");
    insertAssessment(tx, {
      id: assessmentId,
      node_id: childId,
      attempt: NO_ATTEMPT,
      result: AssessmentResult.Undetermined,
      rationale: "Discard",
      evidence_ids: canonicalJSON([evidenceId]),
      dependency_outcome_ids: "[]",
      tested_input: null,
      gate_files: null,
      execution_id: null,
      actor: canonicalJSON(h.actor),
      node_revision: FIRST_REVISION,
      created_at: CREATED_AT,
    });
    insertOutcome(tx, {
      id: outcomeId,
      node_id: childId,
      result: AssessmentResult.Undetermined,
      assessment_id: assessmentId,
      evidence_ids: "[]",
      created_at: CREATED_AT,
    });
    insertRevision(tx, {
      ...base,
      node_id: childId,
      revision: SECOND_REVISION,
      filename: "renamed.md",
      content: { ...base.content, name: "Later" },
      tasks: [],
    });
    tx.database
      .prepare("UPDATE mission_node SET filename = ? WHERE id = ?")
      .run("renamed.md", childId);
  });
  const input = {
    params: { execution_id: h.claim.executionId },
    query: {},
    body: null,
  };
  const page = await h.invoke("execution.dependency.list", input);
  const child = page.items.find((item) => item.id === childId)!;
  assert.ok("content" in child);
  assert.equal(child.content.name, PINNED);
  assert.equal(child.visible_revision, FIRST_REVISION);
  assert.equal(child.filename, PINNED_FILENAME);
  assert.deepEqual(
    page.items.find((item) => item.id === freshId),
    { id: freshId, state: NodeState.Pending },
  );
  assert.deepEqual(
    (await h.invoke("execution.dependency.outcome.list", input)).items.map(
      (item) => item.id,
    ),
    [outcomeId],
  );
  assert.deepEqual(
    (await h.invoke("execution.dependency.evidence.list", input)).items.map(
      (item) => item.id,
    ),
    [evidenceId],
  );
  h.store.transaction((tx) =>
    tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(LATER_TS, childId),
  );
  assert.equal(
    (await h.invoke("execution.dependency.list", input)).items.length,
    SINGLE_ITEM,
  );
  assert.equal(
    (await h.invoke("execution.dependency.outcome.list", input)).items.length,
    NO_ITEMS,
  );
  assert.equal(
    (await h.invoke("execution.dependency.evidence.list", input)).items.length,
    NO_ITEMS,
  );
  const implement = evidenceHarness(t, IDENTITY);
  for (const operation of [
    "execution.dependency.list",
    "execution.dependency.outcome.list",
    "execution.dependency.evidence.list",
  ] as const)
    assert.deepEqual(
      await implement.invoke(operation, {
        params: { execution_id: implement.claim.executionId },
        query: {},
        body: null,
      }),
      { items: [], next_cursor: null },
    );
});

test("execution evidence is attempt-bound and cleared outcome appears only after a human opens the next attempt", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  const readCleared = () =>
    h.invoke("execution.clearedOutcome.get", {
      params: { execution_id: h.claim.executionId },
      query: {},
      body: null,
    });
  await assert.rejects(
    readCleared(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.RecordNotFound,
  );
  const outcomeId = createIdentity("outcome");
  const currentId = createIdentity("evidence");
  h.store.transaction((tx) => {
    const assessmentId = createIdentity("assessment");
    insertAssessment(tx, {
      id: assessmentId,
      node_id: h.node_id,
      attempt: FIRST_ATTEMPT,
      result: AssessmentResult.Undetermined,
      rationale: "Blocked",
      evidence_ids: "[]",
      dependency_outcome_ids: "[]",
      tested_input: null,
      gate_files: null,
      execution_id: null,
      actor: canonicalJSON(h.actor),
      node_revision: FIRST_REVISION,
      created_at: CREATED_AT,
    });
    insertOutcome(tx, {
      id: outcomeId,
      node_id: h.node_id,
      result: AssessmentResult.Undetermined,
      assessment_id: assessmentId,
      evidence_ids: "[]",
      created_at: CREATED_AT,
    });
    closeAttempt(tx, h.node_id, FIRST_ATTEMPT, CLOSE_AT);
    openAttempt(tx, h.node_id, FIRST_REVISION, h.actor, LATER_TS);
    for (const attempt of [FIRST_ATTEMPT, SECOND_ATTEMPT])
      insertEvidence(
        tx,
        {
          id:
            attempt === SECOND_ATTEMPT ? currentId : createIdentity("evidence"),
          node_id: h.node_id,
          attempt,
          subject: "Attempt evidence",
          requirement_key: null,
          end_state: null,
          verification: null,
          provenance: canonicalJSON(h.executionActor),
          created_at: LATER_TS,
        },
        [],
      );
  });
  h.claim.attempt = SECOND_ATTEMPT;
  assert.equal((await readCleared()).id, outcomeId);
  const page = await h.invoke("execution.evidence.list", {
    params: { execution_id: h.claim.executionId },
    query: {},
    body: null,
  });
  assert.deepEqual(
    page.items.map((item) => item.id),
    [currentId],
  );
});

test("execution revision reads carry the pinned tasks and exclude later human revisions from every page", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    const revision = getRevision(tx, h.node_id, FIRST_REVISION);
    insertRevision(tx, {
      ...revision,
      revision: SECOND_REVISION,
      content: { ...revision.content, name: PINNED },
      tasks: [
        {
          id: createIdentity("task"),
          filename: "task.md",
          content: {
            name: revision.content.name,
            requirement: revision.content.requirement,
            criterion: revision.content.criterion,
            verifications: revision.content.verifications,
            bindings: [],
          },
        },
      ],
    });
    insertRevision(tx, { ...revision, revision: THIRD_REVISION });
    tx.database
      .prepare(
        "UPDATE mission_attempt SET node_revision = ? WHERE node_id = ? AND attempt = ?",
      )
      .run(SECOND_REVISION, h.node_id, FIRST_ATTEMPT);
  });
  h.claim.pinnedRevision = SECOND_REVISION;
  const pinned = await h.invoke("execution.pinnedRevision.get", {
    params: { execution_id: h.claim.executionId },
    query: {},
    body: null,
  });
  assert.equal(pinned.revision, SECOND_REVISION);
  assert.equal(pinned.content.name, PINNED);
  assert.equal(pinned.tasks?.length, SINGLE_ITEM);
  const first = await h.invoke("execution.revision.list", {
    params: { execution_id: h.claim.executionId },
    query: { limit: SINGLE_ITEM },
    body: null,
  });
  assert.equal(first.items[FIRST_ITEM_INDEX]!.revision, SECOND_REVISION);
  const second = await h.invoke("execution.revision.list", {
    params: { execution_id: h.claim.executionId },
    query: { cursor: first.next_cursor, limit: SINGLE_ITEM },
    body: null,
  });
  assert.equal(second.items[FIRST_ITEM_INDEX]!.revision, FIRST_REVISION);
  assert.equal(second.next_cursor, null);
  await assert.rejects(
    h.invoke("execution.revision.get", {
      params: { execution_id: h.claim.executionId, revision: THIRD_REVISION },
      query: {},
      body: null,
    }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.ExecutionRevisionAbovePin,
  );
});

const LATER_COMMIT = "b".repeat(40);
const SECOND_ROUND = 2;
const THIRD_ROUND = 3;

async function laterEvidence(h: Awaited<ReturnType<typeof reviewHarness>>) {
  const address = { ...h.address, commit: LATER_COMMIT };
  const evidence = await h.invoke("evidence.submit", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.context,
      subject: "Verified again",
      assets: [{ kind: AssetKind.Repository, address }],
      verification: {
        tested_input: address,
        results: [
          { command: "true", exit_code: 0, signal: null, timed_out: false },
        ],
      },
    },
  });
  return { evidence_ids: [evidence.evidence.id], tested_input: address };
}

test("the review round answers its number, its review base and the open findings in label order", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  const first = await h.reviewRound();
  assert.deepEqual(first, {
    round: FIRST_ATTEMPT,
    final: false,
    review_base: null,
    findings: [],
  });
  await h.submit({
    ...h.notMet,
    findings: [
      reviewerFinding("S1"),
      reviewerFinding("B10"),
      reviewerFinding("B2"),
      reviewerFinding("S3", { action: FindingAction.No }),
    ],
  });
  h.evaluate();
  const second = await h.reviewRound();
  assert.equal(second.round, SECOND_ROUND);
  assert.equal(second.final, false);
  assert.deepEqual(second.review_base, h.address);
  assert.deepEqual(
    second.findings.map((item) => item.label),
    ["B2", "B10", "S1"],
  );
});

test("the review base skips an unjudged round and a round that rests only on an unlisted open blocker", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  await h.submit({ ...h.notMet, findings: [reviewerFinding("B1")] });
  h.evaluate();
  const later = await laterEvidence(h);
  const unjudged = await h.submit({ ...h.notMet, ...later });
  assert.ok("state" in unjudged.node);
  assert.equal(unjudged.node.state, NodeState.Available);
  h.evaluate();
  const round = await h.reviewRound();
  assert.equal(round.round, THIRD_ROUND);
  assert.equal(round.final, true);
  assert.deepEqual(round.review_base, h.address);
  assert.deepEqual(
    round.findings.map((item) => [item.label, item.status]),
    [["B1", FindingStatus.Open]],
  );
});

test("a criterion-not-met round with one new suggestion and an unlisted open blocker is the next review base", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  await h.submit({ ...h.notMet, findings: [reviewerFinding("B1")] });
  h.evaluate();
  const later = await laterEvidence(h);
  await h.submit({
    ...h.notMet,
    ...later,
    findings: [reviewerFinding("S1")],
  });
  h.evaluate();
  const round = await h.reviewRound();
  assert.deepEqual(round.review_base, later.tested_input);
  assert.deepEqual(
    round.findings.map((item) => item.label),
    ["B1", "S1"],
  );
});

test("the rework assessment selects a success while the attempt holds an open finding", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  const success = await h.submit({ findings: [reviewerFinding("S1")] });
  h.evaluate();
  const rework = await h.invoke("execution.rework_assessment.get", {
    params: { execution_id: h.claim.executionId },
    query: {},
    body: null,
  });
  assert.equal(rework.id, success.assessment.id);
  assert.equal(rework.round, FIRST_ATTEMPT);
});

test("the rework assessment ignores a rejected round that a later success follows", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  await h.submit(h.notMet);
  h.evaluate();
  h.store.transaction((tx) =>
    insertAssessment(tx, {
      id: createIdentity("assessment"),
      node_id: h.node_id,
      attempt: h.claim.attempt,
      result: AssessmentResult.Success,
      rationale: "Accepted",
      evidence_ids: "[]",
      dependency_outcome_ids: "[]",
      tested_input: null,
      gate_files: null,
      execution_id: h.claim.executionId,
      actor: null,
      node_revision: h.claim.pinnedRevision,
      created_at: CREATED_AT,
    }),
  );
  await assert.rejects(
    h.invoke("execution.rework_assessment.get", {
      params: { execution_id: h.claim.executionId },
      query: {},
      body: null,
    }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.RecordNotFound,
  );
});

test("a request evidence makes round 1 final", async (t) => {
  const h = await reviewHarness(t, IDENTITY);
  h.store.transaction((tx) =>
    insertEvidence(
      tx,
      {
        id: createIdentity("evidence"),
        node_id: h.node_id,
        attempt: h.claim.attempt,
        subject: "PR",
        requirement_key: "repo.pull_request",
        end_state: null,
        verification: null,
        provenance: canonicalJSON(h.executionActor),
        created_at: CREATED_AT,
      },
      [],
    ),
  );
  const round = await h.reviewRound();
  assert.equal(round.round, FIRST_ATTEMPT);
  assert.equal(round.final, true);
});

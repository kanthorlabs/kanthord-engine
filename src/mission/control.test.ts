import assert from "node:assert/strict";
import { test } from "node:test";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import {
  AssessmentResult,
  MissionErrorCode,
  NodeKind,
  NodeState,
} from "./contract.ts";
import {
  admitControl,
  ControlError,
  controlResult,
  writeHumanRecords,
  transition,
  closeExternalAttempt,
  requireNoUnresolvedAction,
  endLiveClaim,
} from "./control.ts";
import {
  openAttempt,
  readAttempt,
  insertAssessment,
  insertEvidence,
} from "./record-store.ts";
import { requireMission } from "./write.ts";
import { setNodeState } from "./store.ts";
import { controlHarness } from "./test-support.ts";

const NOW = 100;
const FIRST = 1;
const ZERO = 0;
const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const KEY = "repo.pull_request";

test("control admission checks retirement, kind and mission before settlement and state", (t) => {
  const h = controlHarness(t, IDENTITY);
  const check = (code: string) =>
    assert.throws(
      () =>
        h.store.transaction((tx) =>
          admitControl(
            tx,
            h.dependencies,
            h.nodeId,
            { ...h.body(), expectedMissionVersion: ZERO },
            [NodeState.Paused],
            NOW,
          ),
        ),
      (error) => error instanceof OperationError && error.code === code,
    );
  h.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(NOW, h.nodeId);
  check(MissionErrorCode.Retired);
  h.store.database
    .prepare("UPDATE mission_node SET retired_at = NULL, kind = ? WHERE id = ?")
    .run(NodeKind.Task, h.nodeId);
  check(ControlError.Task);
  h.store.database
    .prepare("UPDATE mission_node SET kind = ? WHERE id = ?")
    .run(NodeKind.Initiative, h.nodeId);
  check(MissionErrorCode.VersionConflict);
  assert.deepEqual(h.calls, []);
  assert.throws(
    () =>
      h.store.transaction((tx) =>
        admitControl(
          tx,
          h.dependencies,
          h.nodeId,
          h.body(NodeState.Paused),
          [NodeState.Paused],
          NOW,
        ),
      ),
    (error) =>
      error instanceof OperationError &&
      error.code === ControlError.StateConflict,
  );
  assert.throws(
    () =>
      h.store.transaction((tx) =>
        admitControl(
          tx,
          h.dependencies,
          h.nodeId,
          h.body(),
          [NodeState.Paused],
          NOW,
        ),
      ),
    (error) =>
      error instanceof OperationError && error.code === ControlError.Refused,
  );
});

test("control admission re-reads settled state and terminal refusal precedes expected-state mismatch", (t) => {
  const h = controlHarness(t, IDENTITY, {
    schedulerClaims: {
      revoke: () => null,
      liveExecutionOf: () => null,
      settle: (tx, id) => setNodeState(tx, id, NodeState.Paused),
    },
  });
  const admitted = h.store.transaction((tx) =>
    admitControl(
      tx,
      h.dependencies,
      h.nodeId,
      h.body(NodeState.Paused),
      [NodeState.Paused],
      NOW,
    ),
  );
  assert.equal(admitted.node.state, NodeState.Paused);
  h.dependencies.schedulerClaims.settle = (tx, id) =>
    setNodeState(tx, id, NodeState.Completed);
  assert.throws(
    () =>
      h.store.transaction((tx) =>
        admitControl(
          tx,
          h.dependencies,
          h.nodeId,
          h.body(),
          [NodeState.Available],
          NOW,
        ),
      ),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.Terminal,
  );
});

test("attempt-zero human records produce blocked context and no attempt", (t) => {
  const h = controlHarness(t, IDENTITY);
  const node = h.node();
  h.store.transaction((tx) => {
    const outcome = writeHumanRecords(
      tx,
      node,
      AssessmentResult.Undetermined,
      "Hold",
      h.actor,
      [],
      NOW,
    );
    transition(
      tx,
      h.dependencies,
      requireMission(tx, h.missionId),
      node,
      NodeState.Blocked,
      NOW,
    );
    const answer = controlResult(
      tx,
      h.dependencies,
      h.nodeId,
      outcome,
      h.actor,
      NOW,
    );
    assert.equal(answer.attempt, null);
    assert.equal(answer.outcome?.attempt, ZERO);
    assert.ok(answer.node.kind !== NodeKind.Task);
    assert.equal(answer.node.state, NodeState.Blocked);
    assert.equal(requireMission(tx, h.missionId).version, FIRST);
  });
});

test("transition replaces a claimable job and revokes only active claims", (t) => {
  const h = controlHarness(t, IDENTITY);
  const node = h.node();
  h.store.transaction((tx) => {
    transition(
      tx,
      h.dependencies,
      requireMission(tx, h.missionId),
      node,
      NodeState.Waiting,
      NOW,
    );
    endLiveClaim(
      tx,
      h.dependencies,
      { ...node, state: NodeState.Executing },
      NOW,
    );
    endLiveClaim(
      tx,
      h.dependencies,
      { ...node, state: NodeState.Evaluating },
      NOW,
    );
    endLiveClaim(tx, h.dependencies, { ...node, state: NodeState.Paused }, NOW);
  });
  assert.deepEqual(
    h.calls.map((call) => call.method),
    [
      "workQueue.delete",
      "workQueue.insert",
      "schedulerClaims.revoke",
      "schedulerClaims.revoke",
    ],
  );
});

for (const state of [NodeState.ExternalSuccess, NodeState.ExternalFailed]) {
  test(`external closure ${state} requires a current passing assessment`, (t) => {
    const h = controlHarness(t, IDENTITY);
    const node = h.node();
    h.store.transaction((tx) => {
      openAttempt(tx, node.id, FIRST, h.actor, NOW);
      setNodeState(tx, node.id, state);
      const current = { ...node, state, attempt: FIRST };
      assert.equal(
        closeExternalAttempt(tx, h.dependencies, current, NOW),
        null,
      );
      const assessment = insertAssessment(tx, {
        id: createIdentity("assessment"),
        node_id: node.id,
        attempt: FIRST,
        result: AssessmentResult.Success,
        rationale: "Passed",
        evidence_ids: "[]",
        child_outcome_ids: "[]",
        tested_input: null,
        execution_id: createIdentity("execution"),
        actor: null,
        node_revision: FIRST,
        created_at: NOW,
      });
      const outcome = closeExternalAttempt(tx, h.dependencies, current, NOW);
      assert.equal(outcome?.assessment_id, assessment.id);
      assert.equal(
        outcome?.result,
        state === NodeState.ExternalSuccess
          ? AssessmentResult.Success
          : AssessmentResult.Undetermined,
      );
      assert.equal(readAttempt(tx, node.id, FIRST)?.closed_at, NOW);
    });
  });
}

test("unresolved action guard reads the open attempt only", (t) => {
  const h = controlHarness(t, IDENTITY);
  const node = h.node();
  h.store.transaction((tx) => {
    requireNoUnresolvedAction(tx, node);
    openAttempt(tx, node.id, FIRST, h.actor, NOW);
    insertEvidence(
      tx,
      {
        id: createIdentity("evidence"),
        node_id: node.id,
        attempt: FIRST,
        subject: "Request",
        requirement_key: KEY,
        end_state: null,
        verification: null,
        provenance: JSON.stringify(h.actor),
        created_at: NOW,
      },
      [],
    );
    assert.throws(
      () => requireNoUnresolvedAction(tx, { ...node, attempt: FIRST }),
      (error) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, ControlError.Unresolved);
        assert.deepEqual(error.details, { requirementKeys: [KEY] });
        return true;
      },
    );
  });
});

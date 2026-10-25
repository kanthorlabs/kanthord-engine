import assert from "node:assert/strict";
import { test } from "node:test";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import {
  AssessmentResult,
  MissionErrorCode,
  NodeState,
  RevokeCause,
} from "./contract.ts";
import {
  admitControl,
  ControlError,
  executionEnds,
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
import { controlHarness, settlesExpired } from "./test-support.ts";

const NOW = 100;
const FIRST_ATTEMPT = 1;
const NO_ATTEMPT = 0;
const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const KEY = "repo.pull_request";
const EXECUTIONS_LOST = "schedulerClaims.executionsLost";
const WAKE = "wakeup.wake";

test("control admission checks retirement and mission before settlement and state", (t) => {
  const h = controlHarness(t, IDENTITY);
  const check = (code: string) =>
    assert.throws(
      () =>
        h.store.transaction((tx) =>
          admitControl(
            tx,
            h.dependencies,
            h.node_id,
            { ...h.body(), expected_mission_version: NO_ATTEMPT },
            [NodeState.Paused],
            NOW,
            executionEnds(),
          ),
        ),
      (error) => error instanceof OperationError && error.code === code,
    );
  h.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(NOW, h.node_id);
  check(MissionErrorCode.Retired);
  h.store.database
    .prepare("UPDATE mission_node SET retired_at = NULL WHERE id = ?")
    .run(h.node_id);
  check(MissionErrorCode.VersionConflict);
  assert.deepEqual(h.calls, []);
  assert.throws(
    () =>
      h.store.transaction((tx) =>
        admitControl(
          tx,
          h.dependencies,
          h.node_id,
          h.body(NodeState.Paused),
          [NodeState.Paused],
          NOW,
          executionEnds(),
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
          h.node_id,
          h.body(),
          [NodeState.Paused],
          NOW,
          executionEnds(),
        ),
      ),
    (error) =>
      error instanceof OperationError && error.code === ControlError.Refused,
  );
});

for (const [operation, state, body] of [
  ["node.ready", NodeState.Available, {}],
  ["node.resume", NodeState.Paused, { target: "Available" }],
] as const) {
  test(`${operation} whose admission settles an expired execution writes one lost end after its commit`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    const executionId = createIdentity("execution");
    settlesExpired(h.dependencies, executionId);
    h.store.transaction((tx) => setNodeState(tx, h.node_id, state));
    await h.invoke(operation, {
      params: { node_id: h.node_id },
      query: {},
      body: { ...h.body(state), ...body },
    });
    const ends = h.calls.filter((call) => call.method === EXECUTIONS_LOST);
    assert.equal(ends.length, FIRST_ATTEMPT);
    const [lost] = ends[0]!.arguments as [{ execution_id: string }[]];
    assert.deepEqual(
      lost.map((execution) => execution.execution_id),
      [executionId],
    );
    assert.ok(
      h.calls.findIndex((call) => call.method === EXECUTIONS_LOST) <
        h.calls.findIndex((call) => call.method === WAKE),
    );
  });

  test(`${operation} that the state check refuses after the settlement writes no end`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    settlesExpired(h.dependencies, createIdentity("execution"));
    h.store.transaction((tx) => setNodeState(tx, h.node_id, state));
    await assert.rejects(
      h.invoke(operation, {
        params: { node_id: h.node_id },
        query: {},
        body: { ...h.body(NodeState.Waiting), ...body },
      }),
      (error) =>
        error instanceof OperationError &&
        error.code === ControlError.StateConflict,
    );
    assert.equal(
      h.calls.some((call) => call.method === EXECUTIONS_LOST),
      false,
    );
  });
}

test("control admission re-reads settled state and terminal refusal precedes expected-state mismatch", (t) => {
  const h = controlHarness(t, IDENTITY, {
    schedulerClaims: {
      revoke: () => null,
      executionRevoked: () => undefined,
      executionsLost: () => undefined,
      liveExecutionOf: () => null,
      settle: (tx, id) => {
        setNodeState(tx, id, NodeState.Paused);
        return [];
      },
    },
  });
  const admitted = h.store.transaction((tx) =>
    admitControl(
      tx,
      h.dependencies,
      h.node_id,
      h.body(NodeState.Paused),
      [NodeState.Paused],
      NOW,
      executionEnds(),
    ),
  );
  assert.equal(admitted.node.state, NodeState.Paused);
  h.dependencies.schedulerClaims.settle = (tx, id) => {
    setNodeState(tx, id, NodeState.Completed);
    return [];
  };
  assert.throws(
    () =>
      h.store.transaction((tx) =>
        admitControl(
          tx,
          h.dependencies,
          h.node_id,
          h.body(),
          [NodeState.Available],
          NOW,
          executionEnds(),
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
      requireMission(tx, h.mission_id),
      node,
      NodeState.Blocked,
      NOW,
    );
    const answer = controlResult(
      tx,
      h.dependencies,
      h.node_id,
      outcome,
      h.actor,
      NOW,
    );
    assert.equal(answer.attempt, null);
    assert.equal(answer.outcome?.attempt, NO_ATTEMPT);
    assert.equal(answer.node.state, NodeState.Blocked);
    assert.equal(requireMission(tx, h.mission_id).version, FIRST_ATTEMPT);
  });
});

test("transition replaces a claimable job and revokes only active claims", (t) => {
  const h = controlHarness(t, IDENTITY);
  const node = h.node();
  h.store.transaction((tx) => {
    transition(
      tx,
      h.dependencies,
      requireMission(tx, h.mission_id),
      node,
      NodeState.Waiting,
      NOW,
    );
    endLiveClaim(
      tx,
      h.dependencies,
      { ...node, state: NodeState.Executing },
      NOW,
      RevokeCause.Human,
      executionEnds(),
    );
    endLiveClaim(
      tx,
      h.dependencies,
      { ...node, state: NodeState.Evaluating },
      NOW,
      RevokeCause.Human,
      executionEnds(),
    );
    endLiveClaim(
      tx,
      h.dependencies,
      { ...node, state: NodeState.Paused },
      NOW,
      RevokeCause.Human,
      executionEnds(),
    );
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
      openAttempt(tx, node.id, FIRST_ATTEMPT, h.actor, NOW);
      setNodeState(tx, node.id, state);
      const current = { ...node, state, attempt: FIRST_ATTEMPT };
      assert.equal(
        closeExternalAttempt(tx, h.dependencies, current, NOW),
        null,
      );
      const assessment = insertAssessment(tx, {
        id: createIdentity("assessment"),
        node_id: node.id,
        attempt: FIRST_ATTEMPT,
        result: AssessmentResult.Success,
        rationale: "Passed",
        evidence_ids: "[]",
        dependency_outcome_ids: "[]",
        tested_input: null,
        execution_id: createIdentity("execution"),
        actor: null,
        node_revision: FIRST_ATTEMPT,
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
      assert.equal(readAttempt(tx, node.id, FIRST_ATTEMPT)?.closed_at, NOW);
    });
  });
}

test("unresolved action guard reads the open attempt only", (t) => {
  const h = controlHarness(t, IDENTITY);
  const node = h.node();
  h.store.transaction((tx) => {
    requireNoUnresolvedAction(tx, node);
    openAttempt(tx, node.id, FIRST_ATTEMPT, h.actor, NOW);
    insertEvidence(
      tx,
      {
        id: createIdentity("evidence"),
        node_id: node.id,
        attempt: FIRST_ATTEMPT,
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
      () => requireNoUnresolvedAction(tx, { ...node, attempt: FIRST_ATTEMPT }),
      (error) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, ControlError.Unresolved);
        assert.deepEqual(error.details, { requirement_keys: [KEY] });
        return true;
      },
    );
  });
});

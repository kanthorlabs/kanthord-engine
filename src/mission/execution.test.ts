import assert from "node:assert/strict";
import { test } from "node:test";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import {
  admitExecution,
  requireEvaluationClaim,
  requireTextBound,
} from "./execution.ts";
import { executionHarness } from "./test-support.ts";
import { MissionErrorCode, NodeKind, NodeState } from "./contract.ts";
import { insertNode, setNodeState } from "./store.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const NOW = 200;
const TEXT_BOUND = 4;
const NEXT = 2;
const NOT_RUNNING = "scheduler.execution.not_running";
const VALIDATION = "gateway.request.validation_failed";

test("execution admission derives the pin and actor and rejects ended or foreign claimants first", (t) => {
  const h = executionHarness(t, IDENTITY);
  const admit = () =>
    h.store.transaction((tx) =>
      admitExecution(tx, h.dependencies, h.claim, h.nodeId, h.context, NOW),
    );
  const accepted = admit();
  assert.deepEqual(accepted.actor, h.executionActor);
  assert.equal(accepted.revision.revision, h.claim.pinnedRevision);
  assert.equal(accepted.attempt.attempt, h.claim.attempt);
  for (const live of [
    null,
    { ...h.claim, executionId: createIdentity("execution") },
    { ...h.claim, runtimeIdentity: createIdentity("worker_instance") },
  ]) {
    h.dependencies.schedulerClaims.liveExecutionOf = () => live;
    assert.throws(
      admit,
      (error) =>
        error instanceof OperationError &&
        error.status === HttpStatus.Conflict &&
        error.code === NOT_RUNNING,
    );
  }
});

test("execution context checks every supplied field and refuses a task route", (t) => {
  const h = executionHarness(t, IDENTITY);
  const taskId = createIdentity("node");
  h.store.transaction((tx) =>
    insertNode(tx, {
      id: taskId,
      mission_id: h.missionId,
      kind: NodeKind.Task,
      filename: "task.md",
      parent_id: h.nodeId,
      created_at: NOW,
    }),
  );
  const cases = [
    { nodeId: taskId, context: h.context, field: "nodeId" },
    {
      nodeId: h.nodeId,
      context: { ...h.context, executionId: createIdentity("execution") },
      field: "executionId",
    },
    {
      nodeId: h.nodeId,
      context: { ...h.context, attempt: NEXT },
      field: "attempt",
    },
    {
      nodeId: h.nodeId,
      context: { ...h.context, nodeRevision: NEXT },
      field: "nodeRevision",
    },
  ];
  for (const item of cases)
    assert.throws(
      () =>
        h.store.transaction((tx) =>
          admitExecution(
            tx,
            h.dependencies,
            h.claim,
            item.nodeId,
            item.context,
            NOW,
          ),
        ),
      (error) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, MissionErrorCode.ExecutionContextMismatch);
        assert.deepEqual(error.details, { field: item.field });
        return true;
      },
    );
});

test("evaluation admission and UTF-8 text bounds are exact", (t) => {
  const h = executionHarness(t, IDENTITY);
  assert.throws(
    () => requireEvaluationClaim(h.node()),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.ExecutionClaimNotEvaluation,
  );
  h.store.transaction((tx) => setNodeState(tx, h.nodeId, NodeState.Evaluating));
  requireEvaluationClaim(h.node());
  requireTextBound("subject", "éé", TEXT_BOUND);
  assert.throws(
    () => requireTextBound("subject", "ééa", TEXT_BOUND),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.BadRequest);
      assert.equal(error.code, VALIDATION);
      assert.deepEqual(error.details, [{ path: ["subject"], code: "too_big" }]);
      return true;
    },
  );
});

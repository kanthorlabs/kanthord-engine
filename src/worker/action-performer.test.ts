import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import {
  ACTION_REQUEST_TOOL_NAME,
  ActionAssessmentResult,
  ActionNodeState,
  TestedInputKind,
  WorkerErrorCode,
  type ActionContext,
} from "./contract.ts";
import { ActionPerformer } from "./action-performer.ts";

const FIRST = 1;
const NO_CALLS = 0;
const COMMIT = "b".repeat(40);
const NOT_RUNNING = "scheduler.execution.not_running";

function harness(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  const claim = {
    executionId: createIdentity("execution"),
    projectId: createIdentity("project"),
    nodeId: createIdentity("node"),
    attempt: FIRST,
    pinnedRevision: FIRST,
    runtimeIdentity: createIdentity("worker_instance"),
    workerBindingId: createIdentity("binding"),
  };
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "harness",
      resourceIdentity: "worker:kanthord:harness",
      projectId: claim.projectId,
      issuedAt: FIRST,
    },
    "jwt",
    claim.runtimeIdentity,
  );
  const context: ActionContext = {
    state: ActionNodeState.Evaluating,
    currentAssessment: {
      result: ActionAssessmentResult.Success,
      testedInput: {
        kind: TestedInputKind.Repository,
        bindingId: createIdentity("binding"),
        commit: COMMIT,
      },
    },
    actions: [],
  };
  const calls: string[] = [];
  const dependencies: ConstructorParameters<typeof ActionPerformer>[0] = {
    store,
    schedulerClaims: {
      requireRunning: (tx, executionId, runtimeIdentity, now) => {
        assert.ok(tx.database.isTransaction);
        assert.equal(executionId, claim.executionId);
        assert.equal(runtimeIdentity, claim.runtimeIdentity);
        assert.ok(Number.isSafeInteger(now));
        calls.push("claim");
        return claim;
      },
      runningExecutionOfRuntime: () => assert.fail("unexpected read"),
      activityOf: () => assert.fail("unexpected read"),
    },
    missionActions: {
      actionContextOf: (tx, nodeId, attempt) => {
        assert.ok(tx.database.isTransaction);
        assert.equal(nodeId, claim.nodeId);
        assert.equal(attempt, claim.attempt);
        calls.push("mission");
        return context;
      },
    },
    intakeActions: {
      perform: async () => assert.fail("unexpected dispatch"),
      read: async () => assert.fail("unexpected read"),
    },
    evidenceRequests: {
      request: async () => assert.fail("unexpected request"),
    },
  };
  const performer = new ActionPerformer(dependencies);
  const caller = { context: background, identity };
  return {
    store,
    claim,
    identity,
    context,
    calls,
    dependencies,
    performer,
    caller,
    perform: () => performer.perform(caller, claim),
  };
}

test("admission checks live claim before reading Mission", async (t) => {
  const h = harness(t);
  h.dependencies.schedulerClaims.requireRunning = () => {
    throw new OperationError(HttpStatus.Conflict, NOT_RUNNING, "ended");
  };
  await assert.rejects(h.perform(), {
    code: NOT_RUNNING,
    status: HttpStatus.Conflict,
  });
  assert.equal(h.calls.length, NO_CALLS);
});

test("admission refuses steps claims before any external call", async (t) => {
  const h = harness(t);
  h.context.state = ActionNodeState.Executing;
  await assert.rejects(h.perform(), {
    code: WorkerErrorCode.ClaimNotEvaluation,
    status: HttpStatus.Conflict,
  });
  assert.deepEqual(h.calls, ["claim", "mission"]);
});

test("admission requires a current passing assessment", async (t) => {
  const h = harness(t);
  h.context.currentAssessment!.result = ActionAssessmentResult.CriterionNotMet;
  await assert.rejects(h.perform(), {
    code: WorkerErrorCode.AssessmentNotCurrent,
  });
  h.context.currentAssessment = null;
  await assert.rejects(h.perform(), {
    code: WorkerErrorCode.AssessmentNotCurrent,
  });
});

test("admission reads one snapshot and no-action context calls no external seam", async (t) => {
  const h = harness(t);
  const transactions = t.mock.method(h.store, "transaction");
  assert.deepEqual(await h.perform(), {
    toolName: ACTION_REQUEST_TOOL_NAME,
    items: [],
  });
  assert.equal(transactions.mock.callCount(), FIRST);
  assert.deepEqual(h.calls, ["claim", "mission"]);
});

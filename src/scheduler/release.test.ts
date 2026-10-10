import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { background } from "../kernel/context.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { CallerContext } from "../kernel/operation.ts";
import {
  executionFixture,
  schedulerHarness,
  FIXTURE_NOW,
  FIXTURE_DEADLINE,
} from "./test-support.ts";
import {
  consecutiveStalls,
  insertExecution,
  readExecution,
  claimStateOf,
} from "./execution-store.ts";
import {
  BudgetLimit,
  ClaimState,
  ExecutionStopReason,
  schedulerOperations,
  type ReleaseStop,
} from "./contract.ts";
import { consecutiveFailures, EXECUTION_NOT_RUNNING } from "./settlement.ts";

const WAKE_CALL_COUNT = 1;
const NO_STALLS = 0;
const PRIOR_STALLS = 2;
const CURRENT_STALL = 1;
const FIRST_FAILURE = 1;
const SECOND_FAILURE = 2;
const RELEASE_ROUTING = "release";
const STOP: ReleaseStop = {
  reason: ExecutionStopReason.JudgementInvalid,
  code: null,
};
const BUDGET_END: ReleaseStop = {
  reason: ExecutionStopReason.BudgetEnd,
  code: BudgetLimit.Turns,
};
function harness(t: TestContext) {
  const h = schedulerHarness(t);
  const row = executionFixture();
  h.store.transaction((tx) => insertExecution(tx, row));
  const caller: CallerContext = {
    context: background,
    requestId: createIdentity("request"),
    execution: {
      executionId: row.execution_id,
      projectId: row.project_id,
      nodeId: row.node_id,
      attempt: row.attempt,
      pinnedRevision: row.pinned_revision,
      runtimeIdentity: row.runtime_identity,
      workerBindingId: row.worker_binding_id,
    },
    commit: (write) => h.store.transaction(write),
  };
  const release = (furtherWork = false, stop?: ReleaseStop) =>
    h.invoke(
      "executionRelease",
      {
        params: { execution_id: row.execution_id },
        query: {},
        body: {
          further_work: furtherWork,
          ...(stop && { stop }),
        },
      },
      caller,
    );
  const read = () =>
    h.store.transaction((tx) => readExecution(tx, row.execution_id)!);
  return { ...h, row, caller, release, read };
}

test("release routes once, ends at the transaction reading and wakes after commit", async (t) => {
  const h = harness(t);
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  const wakes: string[] = [];
  t.mock.method(h.service, "wake", (projectId: string) => {
    assert.equal(h.read().ended_at, FIXTURE_NOW);
    wakes.push(projectId);
  });
  assert.deepEqual(await h.release(true), {
    execution_id: h.row.execution_id,
    ended_at: FIXTURE_NOW,
  });
  await assert.rejects(h.release(), { code: EXECUTION_NOT_RUNNING });
  assert.equal(h.calls.length, WAKE_CALL_COUNT);
  assert.deepEqual(h.calls[0]!.arguments.slice(1), [
    {
      execution_id: h.row.execution_id,
      node_id: h.row.node_id,
      attempt: h.row.attempt,
    },
    true,
    NO_STALLS,
    FIXTURE_NOW,
  ]);
  assert.deepEqual(wakes, [h.row.project_id]);
});

test("a budget-end release routes the count of consecutive budget ends and stores its stop", async (t) => {
  const h = harness(t);
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  t.mock.method(h.service, "wake", () => {});
  h.store.transaction((tx) => {
    for (let index = 0; index < PRIOR_STALLS; index++) {
      const prior = executionFixture({
        node_id: h.row.node_id,
        project_id: h.row.project_id,
        attempt: h.row.attempt,
        ended_at: FIXTURE_NOW,
        stop: BUDGET_END,
      });
      insertExecution(tx, prior);
    }
  });
  await h.release(true, BUDGET_END);
  assert.equal(h.calls.length, WAKE_CALL_COUNT);
  assert.equal(h.calls[0]!.arguments[3], PRIOR_STALLS + CURRENT_STALL);
  assert.deepEqual(h.read().stop, BUDGET_END);
});

test("a budget end is no failure and resets the failure count", (t) => {
  const h = harness(t);
  const countAfter = (stops: ReleaseStop[]) =>
    h.store.transaction((tx) => {
      for (const stop of stops)
        insertExecution(
          tx,
          executionFixture({
            node_id: h.row.node_id,
            project_id: h.row.project_id,
            attempt: h.row.attempt,
            ended_at: FIXTURE_NOW,
            stop,
          }),
        );
      return consecutiveFailures(tx, h.row);
    });
  assert.equal(countAfter([STOP, BUDGET_END]), FIRST_FAILURE);
  assert.equal(countAfter([STOP]), SECOND_FAILURE);
});

test("a failure stop between budget ends resets the budget-end count", (t) => {
  const h = harness(t);
  const count = h.store.transaction((tx) => {
    for (const stop of [BUDGET_END, STOP, BUDGET_END]) {
      insertExecution(
        tx,
        executionFixture({
          node_id: h.row.node_id,
          project_id: h.row.project_id,
          attempt: h.row.attempt,
          ended_at: FIXTURE_NOW,
          stop,
        }),
      );
    }
    return consecutiveStalls(tx, h.row.node_id, h.row.attempt);
  });
  assert.equal(count, CURRENT_STALL);
});

test("Mission refusal rolls back all release writes and sends no wake", async (t) => {
  const h = harness(t);
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  const failure = new Error("Mission refused release");
  h.dependencies.transitions.release = (tx) => {
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0);
    throw failure;
  };
  const wake = t.mock.method(h.service, "wake");
  await assert.rejects(h.release(), failure);
  assert.equal(h.read().ended_at, null);
  assert.deepEqual(
    h.store.database.prepare("SELECT * FROM scheduler_job").all(),
    [],
  );
  assert.deepEqual(wake.mock.calls, []);
});

test("expiry equality, loss and revocation refuse release without routing", async (t) => {
  const h = harness(t);
  t.mock.method(Date, "now", () => FIXTURE_DEADLINE);
  await assert.rejects(h.release(), { code: EXECUTION_NOT_RUNNING });
  assert.equal(claimStateOf(h.read(), FIXTURE_DEADLINE), ClaimState.Lost);
  h.store.transaction((tx) =>
    h.service.settle(tx, h.row.node_id, FIXTURE_DEADLINE),
  );
  await assert.rejects(h.release(), { code: EXECUTION_NOT_RUNNING });
  const revoked = harness(t);
  revoked.store.transaction((tx) =>
    revoked.service.revoke(tx, revoked.row.node_id, FIXTURE_NOW),
  );
  await assert.rejects(revoked.release(), { code: EXECUTION_NOT_RUNNING });
  assert.deepEqual(revoked.calls, []);
  assert.equal(h.calls.length, WAKE_CALL_COUNT);
});

test("a release begun before expiry remains finished when commit ends after expiry", async (t) => {
  const h = harness(t);
  let now = FIXTURE_DEADLINE - 1;
  const started = now;
  t.mock.method(Date, "now", () => now);
  h.dependencies.transitions.release = () => {
    now = FIXTURE_DEADLINE + 1;
  };
  assert.deepEqual(await h.release(), {
    execution_id: h.row.execution_id,
    ended_at: started,
  });
  assert.equal(claimStateOf(h.read(), now), ClaimState.Finished);
});

test("a release with a stop stores the stop and routes the failure count", async (t) => {
  const h = harness(t);
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  const wake = t.mock.method(h.service, "wake");
  assert.deepEqual(await h.release(true, STOP), {
    execution_id: h.row.execution_id,
    ended_at: FIXTURE_NOW,
  });
  assert.deepEqual(h.read().stop, STOP);
  assert.equal(claimStateOf(h.read(), FIXTURE_NOW), ClaimState.Finished);
  assert.deepEqual(
    h.calls.map((call) => [call.method, ...call.arguments.slice(1)]),
    [["failure", h.row.node_id, FIRST_FAILURE, FIXTURE_NOW]],
  );
  assert.equal(wake.mock.callCount(), WAKE_CALL_COUNT);
});

test("a release without a stop field stores no stop", async (t) => {
  const h = harness(t);
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  await h.release(true);
  assert.equal(h.read().stop, null);
  assert.equal(h.calls[0]!.method, RELEASE_ROUTING);
});

test("the release input refuses a stop with no further work", () => {
  const input = schedulerOperations.executionRelease.input;
  const params = { execution_id: createIdentity("execution") };
  assert.equal(
    input.safeParse({
      params,
      query: {},
      body: { further_work: false, stop: STOP },
    }).success,
    false,
  );
  assert.equal(
    input.safeParse({
      params,
      query: {},
      body: { further_work: true, stop: { reason: "unknown", code: null } },
    }).success,
    false,
  );
  for (const stop of [
    { reason: ExecutionStopReason.BudgetEnd, code: null },
    { reason: ExecutionStopReason.OperationFailed, code: BudgetLimit.Turns },
  ])
    assert.equal(
      input.safeParse({ params, query: {}, body: { further_work: true, stop } })
        .success,
      false,
    );
  assert.deepEqual(
    input.parse({ params, query: {}, body: { further_work: false } }).body,
    { further_work: false, stop: null },
  );
});

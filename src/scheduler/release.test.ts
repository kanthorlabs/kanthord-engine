import assert from "node:assert/strict";
import { ExecutionEnd } from "../tracking/contract.ts";
import { executionTrace } from "./telemetry.ts";
import { test, type TestContext } from "node:test";
import { background } from "../kernel/context.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { CallerContext } from "../kernel/operation.ts";
import {
  executionFixture,
  schedulerHarness,
  FIXTURE_NOW,
  FIXTURE_DEADLINE,
  transitionFixture,
} from "./test-support.ts";
import {
  consecutiveStalls,
  insertExecution,
  readExecution,
  claimStateOf,
} from "./execution-store.ts";
import type { Dependencies } from "./service.ts";
import {
  BudgetLimit,
  ClaimIntent,
  ClaimState,
  EnvironmentFailure,
  ExecutionStopReason,
  schedulerOperations,
  TransitionRule,
  type ReleaseStop,
} from "./contract.ts";
import {
  consecutiveFailures,
  EXECUTION_NOT_RUNNING,
  heldUntil,
} from "./settlement.ts";
import { DEFAULT_STOP_BACKOFF_SECONDS } from "./config.ts";

const WAKE_CALL_COUNT = 1;
const NO_STALLS = 0;
const NO_FAILURES = 0;
const ONE_CALL = 1;
const PRIOR_STALLS = 2;
const FAILURE_LIMIT = 3;
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
      nodeBranch: `kanthord/${row.node_id}`,
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
    return transitionFixture();
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
  assert.deepEqual(h.telemetry, [
    {
      method: "executionEnded",
      arguments: [
        {
          trace: executionTrace(h.row),
          ended_at: FIXTURE_NOW,
          end: ExecutionEnd.Finished,
          revoke_cause: null,
          stop: STOP,
        },
      ],
    },
    {
      method: "executionTransition",
      arguments: [
        executionTrace(h.row),
        { ...transitionFixture(), transitioned_at: FIXTURE_NOW },
      ],
    },
  ]);
  assert.deepEqual(
    h.calls.map((call) => [call.method, ...call.arguments.slice(1)]),
    [["failure", h.row.node_id, FIRST_FAILURE, FIXTURE_NOW]],
  );
  assert.equal(wake.mock.callCount(), WAKE_CALL_COUNT);
});

test("a release stores the cause detail of its stop and hands it to telemetry", async (t) => {
  const h = harness(t);
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  const stop: ReleaseStop = { ...STOP, detail: "Cannot find module" };
  await h.release(true, stop);
  assert.deepEqual(h.read().stop, stop);
  assert.deepEqual(h.telemetry, [
    {
      method: "executionEnded",
      arguments: [
        {
          trace: executionTrace(h.row),
          ended_at: FIXTURE_NOW,
          end: ExecutionEnd.Finished,
          revoke_cause: null,
          stop,
        },
      ],
    },
    {
      method: "executionTransition",
      arguments: [
        executionTrace(h.row),
        { ...transitionFixture(), transitioned_at: FIXTURE_NOW },
      ],
    },
  ]);
});

test("a release writes one transition span after its root end", async (t) => {
  const h = harness(t);
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  await h.release(false);
  assert.deepEqual(
    h.telemetry.map((entry) => entry.method),
    ["executionEnded", "executionTransition"],
  );
  assert.deepEqual(h.telemetry[1]!.arguments, [
    executionTrace(h.row),
    {
      from: "Executing",
      to: "Waiting",
      rule: TransitionRule.None,
      count: null,
      limit: null,
      transitioned_at: FIXTURE_NOW,
    },
  ]);
});

test("a release of an evaluating node hands over the state at the commit", async (t) => {
  const h = harness(t);
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  h.dependencies.transitions.release = () =>
    transitionFixture({ from: "Evaluating", to: "Completed" });
  await h.release(false);
  assert.deepEqual(h.telemetry[1]!.arguments[1], {
    ...transitionFixture({ from: "Evaluating", to: "Completed" }),
    transitioned_at: FIXTURE_NOW,
  });
});

test("a stop at the failure limit writes the failure limit rule with its count and limit", async (t) => {
  const h = harness(t);
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  t.mock.method(h.service, "wake", () => {});
  const paused = transitionFixture({
    to: "Paused",
    rule: TransitionRule.FailureLimit,
    count: FAILURE_LIMIT,
    limit: FAILURE_LIMIT,
  });
  h.dependencies.transitions.failure = () => paused;
  await h.release(true, STOP);
  assert.deepEqual(h.telemetry[1]!.arguments, [
    executionTrace(h.row),
    { ...paused, transitioned_at: FIXTURE_NOW },
  ]);
});

test("a stalled release at the further work limit writes the further work limit rule", async (t) => {
  const h = harness(t);
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  t.mock.method(h.service, "wake", () => {});
  const paused = transitionFixture({
    to: "Paused",
    rule: TransitionRule.FurtherWorkLimit,
    count: PRIOR_STALLS + CURRENT_STALL,
    limit: PRIOR_STALLS + CURRENT_STALL,
  });
  h.dependencies.transitions.release = () => paused;
  await h.release(true, BUDGET_END);
  assert.deepEqual(h.telemetry[1]!.arguments, [
    executionTrace(h.row),
    { ...paused, transitioned_at: FIXTURE_NOW },
  ]);
});

test("a refused release writes no transition span", async (t) => {
  const h = harness(t);
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  h.dependencies.transitions.release = () => {
    throw new Error("Mission refused release");
  };
  await assert.rejects(h.release());
  assert.deepEqual(h.telemetry, []);
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

test("the stop backoff doubles with each consecutive failure and holds no job without a failure", () => {
  const base = DEFAULT_STOP_BACKOFF_SECONDS * 1000;
  assert.equal(heldUntil(0, FIXTURE_NOW, DEFAULT_STOP_BACKOFF_SECONDS), null);
  assert.equal(
    heldUntil(FIRST_FAILURE, FIXTURE_NOW, DEFAULT_STOP_BACKOFF_SECONDS),
    FIXTURE_NOW + base,
  );
  assert.equal(
    heldUntil(SECOND_FAILURE, FIXTURE_NOW, DEFAULT_STOP_BACKOFF_SECONDS),
    FIXTURE_NOW + 2 * base,
  );
});

test("a release with a stop holds the job of the node until the stop backoff ends", async (t) => {
  const h = harness(t);
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  h.dependencies.transitions.failure = (tx, nodeId) => {
    h.service.insert(tx, nodeId, h.row.project_id, 0);
    return transitionFixture();
  };
  await h.release(true, STOP);
  const job = h.store.transaction(
    (tx) =>
      tx.database
        .prepare("SELECT available_at FROM scheduler_job WHERE node_id = ?")
        .get(h.row.node_id) as { available_at: number | null },
  );
  assert.equal(
    job.available_at,
    FIXTURE_NOW + DEFAULT_STOP_BACKOFF_SECONDS * 1000,
  );
});

const API = "repository:github:acme/api";
const WEB = "repository:github:acme/web";
const APP_DIGEST = "sha256:aaaa";
const WEB_DIGEST = "sha256:bbbb";
const ENVIRONMENT_STOP: ReleaseStop = {
  reason: ExecutionStopReason.EnvironmentFailed,
  code: EnvironmentFailure.SetupFailed,
};

function environmentHarness(t: TestContext) {
  const h = harness(t);
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  const events: string[] = [];
  const failed: Parameters<
    Dependencies["environments"]["environmentFailed"]
  >[0][] = [];
  let committed = false;
  h.caller.commit = (write) => {
    const result = h.store.transaction(write);
    committed = true;
    events.push("commit");
    return result;
  };
  h.dependencies.facts.claimFacts = () => ({
    intent: ClaimIntent.Implement,
    tags: [],
    repositories: [API, WEB],
  });
  h.dependencies.environments.environmentFailed = (input) => {
    assert.equal(committed, true);
    events.push("environmentFailed");
    failed.push(input);
  };
  t.mock.method(h.service, "wake", () => events.push("wake"));
  return { ...h, events, failed };
}

test("an environment_failed release calls environmentFailed once after the commit and before the wake", async (t) => {
  const h = environmentHarness(t);
  const detail = JSON.stringify({
    command: "pnpm install",
    exit_code: 1,
    digests: { [API]: APP_DIGEST, [WEB]: WEB_DIGEST },
  });
  const stop: ReleaseStop = { ...ENVIRONMENT_STOP, detail };
  await h.release(true, stop);
  assert.deepEqual(h.events, ["commit", "environmentFailed", "wake"]);
  assert.deepEqual(h.failed, [
    {
      project_id: h.row.project_id,
      execution_id: h.row.execution_id,
      resource_identities: [API, WEB],
      digests: { [API]: APP_DIGEST, [WEB]: WEB_DIGEST },
      stop: { code: EnvironmentFailure.SetupFailed, detail },
    },
  ]);
});

test("an environment_failed release with no detail passes a null detail", async (t) => {
  const h = environmentHarness(t);
  await h.release(true, {
    reason: ExecutionStopReason.EnvironmentFailed,
    code: EnvironmentFailure.CommandAbsent,
  });
  assert.equal(h.failed.length, ONE_CALL);
  assert.deepEqual(h.failed[0]!.digests, {});
  assert.deepEqual(h.failed[0]!.stop, {
    code: EnvironmentFailure.CommandAbsent,
    detail: null,
  });
});

for (const detail of [
  "setup failed",
  "[1,2]",
  "null",
  JSON.stringify({ command: "pnpm install" }),
  JSON.stringify({ digests: "none" }),
  JSON.stringify({ digests: { [API]: 1 } }),
]) {
  test(`a stop detail of ${detail} passes empty digests`, async (t) => {
    const h = environmentHarness(t);
    await h.release(true, { ...ENVIRONMENT_STOP, detail });
    assert.equal(h.failed.length, ONE_CALL);
    assert.deepEqual(h.failed[0]!.digests, {});
    assert.equal(h.failed[0]!.stop.detail, detail);
  });
}

test("an environment_failed release neither counts a failure nor holds the job", async (t) => {
  const h = environmentHarness(t);
  await h.release(true, ENVIRONMENT_STOP);
  assert.deepEqual(
    h.calls.map((call) => [call.method, ...call.arguments.slice(1)]),
    [["failure", h.row.node_id, NO_FAILURES, FIXTURE_NOW]],
  );
  assert.deepEqual(
    h.store.database.prepare("SELECT * FROM scheduler_job").all(),
    [],
  );
});

test("a release that fails in its transaction calls environmentFailed never", async (t) => {
  const h = environmentHarness(t);
  const failure = new Error("Mission refused failure");
  h.dependencies.transitions.failure = () => {
    throw failure;
  };
  await assert.rejects(h.release(true, ENVIRONMENT_STOP), failure);
  assert.deepEqual(h.failed, []);
  assert.deepEqual(h.events, []);
  assert.equal(h.read().ended_at, null);
});

test("a release with another stop reason calls environmentFailed never", async (t) => {
  const h = environmentHarness(t);
  await h.release(true, STOP);
  assert.deepEqual(h.failed, []);
  assert.deepEqual(h.events, ["commit", "wake"]);
});

test("a release with no stop calls environmentFailed never", async (t) => {
  const h = environmentHarness(t);
  await h.release(true);
  assert.deepEqual(h.failed, []);
});

test("a budget-end release calls environmentFailed never", async (t) => {
  const h = environmentHarness(t);
  await h.release(true, BUDGET_END);
  assert.deepEqual(h.failed, []);
});

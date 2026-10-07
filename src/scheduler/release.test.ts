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
  insertExecution,
  readExecution,
  claimStateOf,
} from "./execution-store.ts";
import { ClaimState } from "./contract.ts";
import { EXECUTION_NOT_RUNNING } from "./settlement.ts";

const WAKE_CALL_COUNT = 1;
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
  const release = (furtherWork = false) =>
    h.invoke(
      "executionRelease",
      {
        params: { execution_id: row.execution_id },
        query: {},
        body: { further_work: furtherWork },
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
    FIXTURE_NOW,
  ]);
  assert.deepEqual(wakes, [h.row.project_id]);
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

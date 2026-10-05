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
    execution: row,
    commit: (write) => h.store.transaction(write),
  };
  const release = (furtherWork = false) =>
    h.invoke(
      "executionRelease",
      {
        params: { executionId: row.executionId },
        query: {},
        body: { furtherWork },
      },
      caller,
    );
  const read = () =>
    h.store.transaction((tx) => readExecution(tx, row.executionId)!);
  return { ...h, row, caller, release, read };
}

test("release routes once, ends at the transaction reading and wakes after commit", async (t) => {
  const h = harness(t);
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  const wakes: string[] = [];
  t.mock.method(h.service, "wake", (projectId: string) => {
    assert.equal(h.read().endedAt, FIXTURE_NOW);
    wakes.push(projectId);
  });
  assert.deepEqual(await h.release(true), {
    executionId: h.row.executionId,
    endedAt: FIXTURE_NOW,
  });
  await assert.rejects(h.release(), { code: EXECUTION_NOT_RUNNING });
  assert.equal(h.calls.length, WAKE_CALL_COUNT);
  assert.deepEqual(h.calls[0]!.arguments.slice(1), [
    {
      executionId: h.row.executionId,
      nodeId: h.row.nodeId,
      attempt: h.row.attempt,
    },
    true,
    FIXTURE_NOW,
  ]);
  assert.deepEqual(wakes, [h.row.projectId]);
});

test("Mission refusal rolls back all release writes and sends no wake", async (t) => {
  const h = harness(t);
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  const failure = new Error("Mission refused release");
  h.dependencies.transitions.release = (tx) => {
    h.service.insert(tx, h.row.nodeId, h.row.projectId, 0);
    throw failure;
  };
  const wake = t.mock.method(h.service, "wake");
  await assert.rejects(h.release(), failure);
  assert.equal(h.read().endedAt, null);
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
    h.service.settle(tx, h.row.nodeId, FIXTURE_DEADLINE),
  );
  await assert.rejects(h.release(), { code: EXECUTION_NOT_RUNNING });
  const revoked = harness(t);
  revoked.store.transaction((tx) =>
    revoked.service.revoke(tx, revoked.row.nodeId, FIXTURE_NOW),
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
    executionId: h.row.executionId,
    endedAt: started,
  });
  assert.equal(claimStateOf(h.read(), now), ClaimState.Finished);
});

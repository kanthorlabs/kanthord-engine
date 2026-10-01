import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { background, CancellationContext } from "../kernel/context.ts";
import { createIdentity } from "../kernel/identity.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import type { CallerContext } from "../kernel/operation.ts";
import {
  ClaimNodeState,
  NodeFormatField,
  WorkPullKind,
  WORK_PULL_WAIT_MS,
} from "./contract.ts";
import { insertExecution, readExecution } from "./execution-store.ts";
import { schedulerHarness, executionFixture } from "./test-support.ts";

const NO_COMMITS = 0;
const ONE_COMMIT = 1;
const TWO_CHECKS = 2;
const FIRST_ATTEMPT = 1;
const CLAIMANT_MISMATCH = "scheduler.work.claimant_mismatch";
const CANCELLED = "gateway.invocation.cancelled";

function harness(t: TestContext) {
  const h = schedulerHarness(t);
  const row = executionFixture({
    createdAt: Date.now(),
    expiredAt: Date.now() + 10000,
  });
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "worker",
      projectId: row.projectId,
      resourceIdentity: row.resourceIdentity,
      issuedAt: Date.now(),
    },
    "pull",
    row.runtimeIdentity,
  );
  h.dependencies.bindings.workerBindingOf = () => ({
    bindingId: row.workerBindingId,
    workerName: "general@1",
    instanceCount: 2,
    tombstone: false,
  });
  h.dependencies.declarations.declarationOf = () => ({
    declaredNodeStates: [ClaimNodeState.Available],
    requiredNodeFormat: Object.values(NodeFormatField),
    resourceBudget: { wallTimeMs: 7200000 },
  });
  h.dependencies.transitions.claim = (tx, nodeId) => {
    h.service.delete(tx, nodeId);
    tx.database.prepare("INSERT INTO attempts VALUES (?)").run(nodeId);
    return {
      kind: "steps",
      projectId: row.projectId,
      attempt: 1,
      nodeRevision: 1,
    };
  };
  h.store.database.exec("CREATE TABLE attempts (node_id TEXT PRIMARY KEY)");
  let commits = 0;
  const caller: CallerContext = {
    identity,
    context: background,
    requestId: createIdentity("request"),
    commit: (write) => {
      commits++;
      return h.store.transaction(write);
    },
  };
  const input = {
    params: {},
    query: {},
    body: {
      resourceIdentity: row.resourceIdentity,
      runtimeIdentity: row.runtimeIdentity,
    },
  };
  const pull = (context = caller.context) =>
    h.invoke("workPull", input, { ...caller, context });
  const enqueue = () =>
    h.store.transaction((tx) =>
      h.service.insert(tx, row.nodeId, row.projectId, 0),
    );
  return {
    ...h,
    row,
    identity,
    caller,
    input,
    pull,
    enqueue,
    commits: () => commits,
  };
}

test("pull rolls back its probe, rechecks health, and commits exactly one claim", async (t) => {
  const h = harness(t);
  h.enqueue();
  const result = await h.pull();
  assert.equal(result.kind, WorkPullKind.Claimed);
  assert.equal(h.commits(), ONE_COMMIT);
  assert.equal(
    h.calls.filter((call) => call.method === HEALTHCHECK).length,
    TWO_CHECKS,
  );
  assert.equal(
    Number(
      h.store.database.prepare("SELECT count(*) AS count FROM attempts").get()!
        .count,
    ),
    FIRST_ATTEMPT,
  );
  assert.equal(
    Number(
      h.store.database
        .prepare("SELECT count(*) AS count FROM scheduler_execution")
        .get()!.count,
    ),
    FIRST_ATTEMPT,
  );
  const repeat = await h.pull();
  assert.deepEqual(repeat, result);
  assert.equal(
    h.calls.filter((call) => call.method === HEALTHCHECK).length,
    TWO_CHECKS,
  );
});
const HEALTHCHECK = "instanceHealthcheck";

test("project wake serves parked pulls in arrival order and another project does not", async (t) => {
  const h = harness(t);
  const first = h.pull();
  assert.equal(h.service.pulling(h.row.runtimeIdentity), true);
  const otherRuntime = createIdentity("worker_instance");
  const otherIdentity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "other",
      projectId: h.identity.projectId,
      resourceIdentity: h.identity.resourceIdentity,
      issuedAt: Date.now(),
    },
    "other",
    otherRuntime,
  );
  const context = new CancellationContext();
  const second = h.invoke(
    "workPull",
    { ...h.input, body: { ...h.input.body, runtimeIdentity: otherRuntime } },
    { ...h.caller, identity: otherIdentity, context },
  );
  const secondRejected = assert.rejects(second, { code: CANCELLED });
  h.service.wake(createIdentity("project"));
  await turn();
  assert.equal(h.commits(), NO_COMMITS);
  h.enqueue();
  h.service.wake(h.row.projectId);
  const result = await first;
  assert.equal(result.kind, WorkPullKind.Claimed);
  assert.equal(h.commits(), ONE_COMMIT);
  assert.equal(h.service.pulling(otherRuntime), true);
  context.cancel();
  await secondRejected;
  assert.equal(h.commits(), ONE_COMMIT);
});

test("woken health failure and quiescence answer no-work once without claims", async (t) => {
  const h = harness(t);
  const waiting = h.pull();
  h.dependencies.registrations.instanceHealthcheck = () => false;
  h.service.wake(h.row.projectId);
  assert.deepEqual(await waiting, { kind: WorkPullKind.NoWork });
  assert.equal(h.commits(), ONE_COMMIT);
  const stopped = harness(t);
  const parked = stopped.pull();
  await stopped.service.quiesce();
  assert.deepEqual(await parked, { kind: WorkPullKind.NoWork });
  stopped.enqueue();
  assert.deepEqual(await stopped.pull(), { kind: WorkPullKind.NoWork });
  assert.deepEqual(
    stopped.store.database.prepare("SELECT * FROM scheduler_execution").all(),
    [],
  );
});

test("window expiry commits no-work and cancellation commits nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let monotonic = 0;
  t.mock.method(performance, "now", () => monotonic);
  const h = harness(t);
  const waiting = h.pull();
  monotonic = WORK_PULL_WAIT_MS;
  t.mock.timers.tick(WORK_PULL_WAIT_MS);
  assert.deepEqual(await waiting, { kind: WorkPullKind.NoWork });
  assert.equal(h.commits(), ONE_COMMIT);
  const cancelled = harness(t);
  const context = new CancellationContext();
  const pending = cancelled.pull(context);
  context.cancel();
  await assert.rejects(pending, { code: CANCELLED });
  assert.equal(cancelled.commits(), NO_COMMITS);
});

test("mismatches and unexpected probe errors propagate without a commit", async (t) => {
  const h = harness(t);
  for (const body of [
    { ...h.input.body, runtimeIdentity: createIdentity("worker_instance") },
    { ...h.input.body, resourceIdentity: "another-binding" },
  ])
    await assert.rejects(h.invoke("workPull", { ...h.input, body }, h.caller), {
      code: CLAIMANT_MISMATCH,
    });
  const failure = new Error("health probe failed");
  h.dependencies.registrations.instanceHealthcheck = () => {
    throw failure;
  };
  await assert.rejects(h.pull(), failure);
  assert.equal(h.commits(), NO_COMMITS);
});

test("loss probes commit settlement at once and return a new claim", async (t) => {
  const h = harness(t);
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const expired = { ...h.row, createdAt: now - 1000, expiredAt: now };
  h.store.transaction((tx) => insertExecution(tx, expired));
  h.dependencies.transitions.loss = (tx, nodeId) =>
    h.service.insert(tx, nodeId, h.row.projectId, 0);
  const result = await h.pull();
  assert.equal(result.kind, WorkPullKind.Claimed);
  assert.equal(h.commits(), ONE_COMMIT);
  assert.equal(
    h.store.transaction((tx) => readExecution(tx, expired.executionId))!
      .endedAt,
    now,
  );
  if (result.kind === WorkPullKind.Claimed)
    assert.notEqual(result.execution.executionId, expired.executionId);
});

test("the deciding probe and commit share one clock reading", async (t) => {
  const h = harness(t);
  let now = h.row.expiredAt - 1;
  t.mock.method(Date, "now", () => now);
  h.store.transaction((tx) => insertExecution(tx, h.row));
  const original = h.caller.commit;
  h.caller.commit = (write) => {
    now = h.row.expiredAt;
    return original(write);
  };
  const result = await h.pull();
  assert.equal(result.kind, WorkPullKind.Claimed);
  assert.equal(h.commits(), ONE_COMMIT);
  assert.deepEqual(
    h.calls.filter((call) => call.method === HEALTHCHECK),
    [],
  );
});

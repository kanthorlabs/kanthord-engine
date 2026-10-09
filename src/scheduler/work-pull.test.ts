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
const THREE_COMMITS = 3;

function harness(t: TestContext) {
  const h = schedulerHarness(t);
  const row = executionFixture({
    created_at: Date.now(),
    expired_at: Date.now() + 10000,
  });
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "worker",
      projectId: row.project_id,
      resourceIdentity: row.resource_identity,
      issuedAt: Date.now(),
    },
    "pull",
    row.runtime_identity,
  );
  h.dependencies.bindings.workerBindingOf = () => ({
    binding_id: row.worker_binding_id,
    worker_name: "general@1",
    instance_count: 2,
    tombstone: false,
  });
  h.dependencies.declarations.declarationOf = () => ({
    declared_node_states: [ClaimNodeState.Available],
    required_node_format: Object.values(NodeFormatField),
    resource_budget: { wall_time_ms: 7200000 },
  });
  h.dependencies.transitions.claim = (tx, nodeId) => {
    h.service.delete(tx, nodeId);
    tx.database.prepare("INSERT INTO attempts VALUES (?)").run(nodeId);
    return {
      kind: "steps",
      project_id: row.project_id,
      attempt: 1,
      node_revision: 1,
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
      resource_identity: row.resource_identity,
      runtime_identity: row.runtime_identity,
    },
  };
  const pull = (context = caller.context) =>
    h.invoke("workPull", input, { ...caller, context });
  const enqueue = () =>
    h.store.transaction((tx) =>
      h.service.insert(tx, row.node_id, row.project_id, 0),
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
  assert.equal(h.service.pulling(h.row.runtime_identity), true);
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
    { ...h.input, body: { ...h.input.body, runtime_identity: otherRuntime } },
    { ...h.caller, identity: otherIdentity, context },
  );
  const secondRejected = assert.rejects(second, { code: CANCELLED });
  h.service.wake(createIdentity("project"));
  await turn();
  assert.equal(h.commits(), NO_COMMITS);
  h.enqueue();
  h.service.wake(h.row.project_id);
  const result = await first;
  assert.equal(result.kind, WorkPullKind.Claimed);
  assert.equal(h.commits(), ONE_COMMIT);
  assert.equal(h.service.pulling(otherRuntime), true);
  context.cancel();
  await secondRejected;
  assert.equal(h.commits(), ONE_COMMIT);
});

test("concurrent empty pulls of one runtime retain one waiter and each duplicate commits once", async (t) => {
  const h = harness(t);
  const context = new CancellationContext();
  const first = h.pull(context);
  const cancelled = assert.rejects(first, { code: CANCELLED });
  assert.equal(h.service.pulling(h.row.runtime_identity), true);
  const duplicates = await Promise.all([h.pull(), h.pull(), h.pull()]);
  assert.deepEqual(
    duplicates,
    Array.from({ length: THREE_COMMITS }, () => ({
      kind: WorkPullKind.NoWork,
    })),
  );
  assert.equal(h.commits(), THREE_COMMITS);
  assert.equal(h.service.pulling(h.row.runtime_identity), true);
  context.cancel();
  await cancelled;
  assert.equal(h.commits(), THREE_COMMITS);
  assert.equal(h.service.pulling(h.row.runtime_identity), false);
  h.enqueue();
  const claim = await h.pull();
  assert.equal(claim.kind, WorkPullKind.Claimed);
});

test("woken health failure and quiescence answer no-work once without claims", async (t) => {
  const h = harness(t);
  const waiting = h.pull();
  h.dependencies.registrations.instanceHealthcheck = () => false;
  h.service.wake(h.row.project_id);
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
    { ...h.input.body, runtime_identity: createIdentity("worker_instance") },
    { ...h.input.body, resource_identity: "another-binding" },
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
  const expired = { ...h.row, created_at: now - 1000, expired_at: now };
  h.store.transaction((tx) => insertExecution(tx, expired));
  h.dependencies.transitions.failure = (tx, nodeId) =>
    h.service.insert(tx, nodeId, h.row.project_id, 0);
  const result = await h.pull();
  assert.equal(result.kind, WorkPullKind.Claimed);
  assert.equal(h.commits(), ONE_COMMIT);
  assert.equal(
    h.store.transaction((tx) => readExecution(tx, expired.execution_id))!
      .ended_at,
    now,
  );
  if (result.kind === WorkPullKind.Claimed)
    assert.notEqual(result.execution.execution_id, expired.execution_id);
});

test("the deciding probe and commit share one clock reading", async (t) => {
  const h = harness(t);
  let now = h.row.expired_at - 1;
  t.mock.method(Date, "now", () => now);
  h.store.transaction((tx) => insertExecution(tx, h.row));
  const original = h.caller.commit;
  h.caller.commit = (write) => {
    now = h.row.expired_at;
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

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import { ClaimNodeState, NodeFormatField } from "./contract.ts";
import { claimOnce, ClaimOutcome } from "./claim.ts";
import { insertExecution, readExecution } from "./execution-store.ts";
import {
  executionFixture,
  schedulerHarness,
  FIXTURE_NOW,
  FIXTURE_DEADLINE,
} from "./test-support.ts";

const WALL_TIME = 7200000;
const RESERVE_MS = 600000;
const PIN = 3;
const ONE_CALL = 1;
const CLAIM_METHOD = "claim";
const FIRST_JOB = 0;

export function claimHarness(
  t: TestContext,
  states: readonly string[] = [ClaimNodeState.Available],
) {
  const row = executionFixture();
  const h = schedulerHarness(t);
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "worker",
      projectId: row.project_id,
      resourceIdentity: row.resource_identity,
      issuedAt: FIXTURE_NOW,
    },
    "claim",
    row.runtime_identity,
  );
  const pull = {
    resource_identity: row.resource_identity,
    runtime_identity: row.runtime_identity,
  };
  const binding = {
    binding_id: row.worker_binding_id,
    worker_name: "general@1",
    instance_count: 1,
    tombstone: false,
    resource_budget: null as { wall_time_ms: number } | null,
  };
  h.dependencies.bindings.workerBindingOf = () => binding;
  h.dependencies.declarations.declarationOf = () => ({
    declared_node_states: states,
    required_node_format: Object.values(NodeFormatField),
    resource_budget: { wall_time_ms: WALL_TIME },
  });
  h.dependencies.transitions.claim = (
    tx,
    nodeId,
    declaredStates,
    opener,
    now,
  ) => {
    h.calls.push({
      method: "claim",
      arguments: [nodeId, declaredStates, opener, now],
    });
    h.service.delete(tx, nodeId);
    return {
      kind: "claim",
      project_id: row.project_id,
      attempt: 1,
      node_revision: PIN,
    };
  };
  const claim = (now = FIXTURE_NOW) =>
    h.store.transaction((tx) =>
      claimOnce(tx, h.dependencies, identity, pull, now),
    );
  return { ...h, row, identity, pull, binding, claim };
}

test("claim pins binding, attempt, revision, trace and the fixed effective deadline", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  const first = h.claim();
  assert.equal(first.outcome, ClaimOutcome.Claimed);
  assert.equal(first.row!.expired_at, FIXTURE_NOW + WALL_TIME + RESERVE_MS);
  assert.equal(first.row!.pinned_revision, PIN);
  assert.equal(first.row!.worker_binding_id, h.binding.binding_id);
  assert.deepEqual(first.row!.credentials, []);
  assert.equal(Object.hasOwn(first.row!, "kind"), false);
  h.binding.resource_budget = { wall_time_ms: 1 };
  h.dependencies.config.release_reserve = 1;
  const repeat = h.claim();
  assert.equal(repeat.outcome, ClaimOutcome.Running);
  assert.deepEqual(repeat.row, first.row);
  assert.equal(
    h.calls.filter((call) => call.method === CLAIM_METHOD).length,
    ONE_CALL,
  );
  h.store.transaction((tx) => h.service.revoke(tx, h.row.node_id, FIXTURE_NOW));
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  assert.equal(h.claim().row!.expired_at, FIXTURE_NOW + 1001);
});

test("selection preserves priority and age while skipping a stale job", (t) => {
  const h = claimHarness(t, [
    ClaimNodeState.Waiting,
    ClaimNodeState.ExternalRequested,
  ]);
  const nodes = [
    createIdentity("node"),
    createIdentity("node"),
    createIdentity("node"),
  ];
  const jobs = [
    "job_00000000000000000000000001",
    "job_00000000000000000000000002",
    "job_00000000000000000000000003",
  ];
  h.store.transaction((tx) => {
    for (let i = 0; i < nodes.length; i++)
      tx.database
        .prepare("INSERT INTO scheduler_job VALUES (?, ?, ?, ?)")
        .run(jobs[i]!, h.row.project_id, nodes[i]!, i === FIRST_JOB ? 0 : 1);
  });
  const visited: string[] = [];
  h.dependencies.transitions.claim = (tx, nodeId, states) => {
    visited.push(nodeId);
    assert.deepEqual(states, [
      ClaimNodeState.Waiting,
      ClaimNodeState.ExternalRequested,
    ]);
    if (nodeId === nodes[1]) return null;
    h.service.delete(tx, nodeId);
    return {
      kind: "evaluation",
      project_id: h.row.project_id,
      attempt: 1,
      node_revision: PIN,
    };
  };
  assert.equal(h.claim().row!.node_id, nodes[2]);
  assert.deepEqual(visited, [nodes[1], nodes[2]]);
});

test("health, tombstones, zero counts and occupied binding counts refuse admission", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) =>
    h.service.insert(tx, h.row.node_id, h.row.project_id, 0),
  );
  h.dependencies.registrations.instanceHealthcheck = () => false;
  assert.equal(h.claim().outcome, ClaimOutcome.Refused);
  h.dependencies.registrations.instanceHealthcheck = () => true;
  h.binding.tombstone = true;
  assert.equal(h.claim().outcome, ClaimOutcome.None);
  h.binding.tombstone = false;
  h.binding.instance_count = 0;
  assert.equal(h.claim().outcome, ClaimOutcome.None);
  h.binding.instance_count = 1;
  h.store.transaction((tx) =>
    insertExecution(tx, executionFixture({ project_id: h.row.project_id })),
  );
  assert.equal(h.claim().outcome, ClaimOutcome.None);
  assert.deepEqual(
    h.calls.filter((call) => call.method === CLAIM_METHOD),
    [],
  );
});

test("runtime and node expiry settle before admission; rollback undoes all claim writes", (t) => {
  const h = claimHarness(t);
  h.store.transaction((tx) => insertExecution(tx, h.row));
  h.dependencies.transitions.loss = (tx, nodeId, count, now) => {
    assert.equal(count, ONE_CALL);
    assert.equal(now, FIXTURE_DEADLINE);
    h.service.insert(tx, nodeId, h.row.project_id, 0);
  };
  const next = h.claim(FIXTURE_DEADLINE);
  assert.equal(next.settled, true);
  assert.equal(next.outcome, ClaimOutcome.Claimed);
  assert.notEqual(next.row!.execution_id, h.row.execution_id);
  assert.equal(
    h.store.transaction((tx) => readExecution(tx, h.row.execution_id))
      ?.ended_at,
    FIXTURE_DEADLINE,
  );
  const fresh = claimHarness(t);
  const expired = executionFixture({
    project_id: fresh.row.project_id,
    node_id: fresh.row.node_id,
  });
  fresh.store.transaction((tx) => {
    insertExecution(tx, expired);
    fresh.service.insert(tx, expired.node_id, expired.project_id, 0);
  });
  const failure = new Error("probe rollback");
  assert.throws(
    () =>
      fresh.store.transaction((tx) => {
        const result = claimOnce(
          tx,
          fresh.dependencies,
          fresh.identity,
          fresh.pull,
          FIXTURE_DEADLINE,
        );
        assert.equal(result.settled, true);
        assert.equal(result.outcome, ClaimOutcome.Claimed);
        throw failure;
      }),
    failure,
  );
  assert.deepEqual(
    fresh.store.transaction((tx) => readExecution(tx, expired.execution_id)),
    expired,
  );
  assert.equal(fresh.claim(FIXTURE_DEADLINE).outcome, ClaimOutcome.Claimed);
});

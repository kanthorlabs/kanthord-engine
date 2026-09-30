import assert from "node:assert/strict";
import { test } from "node:test";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { OperationError } from "../kernel/errors.ts";
import { NodeKind, NodeState } from "./contract.ts";
import { ControlError } from "./control.ts";
import { openAttempt, readAttempt } from "./record-store.ts";
import { setNodeState } from "./store.ts";
import { controlHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST = 1;
const NOW = 100;
const REVOKE = "schedulerClaims.revoke";
const WAKE = "wakeup.wake";
const INSERT = "workQueue.insert";
for (const state of [
  NodeState.Pending,
  NodeState.Available,
  NodeState.Executing,
  NodeState.Waiting,
  NodeState.Evaluating,
  NodeState.ExternalRequested,
  NodeState.ExternalSuccess,
  NodeState.ExternalFailed,
]) {
  test(`pause from ${state} preserves the open attempt and revokes only active claims`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.transaction((tx) => {
      openAttempt(tx, h.nodeId, FIRST, h.actor, NOW);
      setNodeState(tx, h.nodeId, state);
    });
    const result = await h.invoke("node.pause", {
      params: { nodeId: h.nodeId },
      query: {},
      body: h.body(state, FIRST),
    });
    assert.ok(result.node.kind !== NodeKind.Task);
    assert.equal(result.node.state, NodeState.Paused);
    assert.equal(result.attempt?.closedAt, null);
    assert.equal(result.attempt?.attempt, FIRST);
    assert.equal(result.outcome, null);
    assert.equal(
      h.store.transaction((tx) => readAttempt(tx, h.nodeId, FIRST))?.closed_at,
      null,
    );
    assert.equal(
      h.calls.some((call) => call.method === REVOKE),
      state === NodeState.Executing || state === NodeState.Evaluating,
    );
    assert.equal(h.calls.at(-1)?.method, WAKE);
    assert.equal(
      h.calls.some((call) => call.method === INSERT),
      false,
    );
    const mission = await h.invoke("get", {
      params: { projectId: h.projectId },
      query: {},
      body: null,
    });
    assert.equal(mission.version, FIRST);
  });
}

test("pause refuses Blocked without a write or wakeup", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => setNodeState(tx, h.nodeId, NodeState.Blocked));
  await assert.rejects(
    h.invoke("node.pause", {
      params: { nodeId: h.nodeId },
      query: {},
      body: h.body(NodeState.Blocked),
    }),
    (error) =>
      error instanceof OperationError && error.code === ControlError.Refused,
  );
  assert.equal(h.node().state, NodeState.Blocked);
  assert.equal(
    h.calls.some((call) => call.method === WAKE),
    false,
  );
});

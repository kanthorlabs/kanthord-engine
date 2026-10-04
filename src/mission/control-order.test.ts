import assert from "node:assert/strict";
import { test } from "node:test";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { OperationError } from "../kernel/errors.ts";
import {
  AssessmentResult,
  MissionErrorCode,
  NodeState,
  ResumeTarget,
} from "./contract.ts";
import { ControlError } from "./control.ts";
import { setNodeState } from "./store.ts";
import { controlHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST = 1;
const STALE_ATTEMPT = 7;

type Control = {
  operation:
    | "node.pause"
    | "node.resume"
    | "node.block"
    | "node.ready"
    | "node.override"
    | "node.discard";
  admitted: NodeState;
  refused: NodeState;
  extra: Record<string, unknown>;
};

const CONTROLS: Control[] = [
  {
    operation: "node.pause",
    admitted: NodeState.Available,
    refused: NodeState.Paused,
    extra: {},
  },
  {
    operation: "node.resume",
    admitted: NodeState.Paused,
    refused: NodeState.Available,
    extra: { target: ResumeTarget.Available },
  },
  {
    operation: "node.block",
    admitted: NodeState.Paused,
    refused: NodeState.Available,
    extra: {},
  },
  {
    operation: "node.ready",
    admitted: NodeState.Available,
    refused: NodeState.Paused,
    extra: {},
  },
  {
    operation: "node.override",
    admitted: NodeState.Available,
    refused: NodeState.ExternalRequested,
    extra: { result: AssessmentResult.Success },
  },
  {
    operation: "node.discard",
    admitted: NodeState.Available,
    refused: NodeState.ExternalRequested,
    extra: {},
  },
];

const rejectsWith = (code: string) => (error: unknown) =>
  error instanceof OperationError && error.code === code;

for (const control of CONTROLS) {
  const call = (
    h: ReturnType<typeof controlHarness>,
    expectedState: NodeState,
    expectedAttempt: number,
  ) =>
    h.invoke(control.operation, {
      params: { nodeId: h.nodeId },
      query: {},
      body: { ...h.body(expectedState, expectedAttempt), ...control.extra },
    } as never);

  for (const terminal of [NodeState.Completed, NodeState.Discarded]) {
    test(`${control.operation} on a ${terminal} node answers terminal before expected state and admitted states`, async (t) => {
      const h = controlHarness(t, IDENTITY);
      h.store.transaction((tx) => setNodeState(tx, h.nodeId, terminal));
      const before = h.node();
      await assert.rejects(
        call(h, control.refused, STALE_ATTEMPT),
        rejectsWith(MissionErrorCode.Terminal),
      );
      await assert.rejects(
        call(h, control.admitted, before.attempt!),
        rejectsWith(MissionErrorCode.Terminal),
      );
      assert.deepEqual(h.node(), before);
    });
  }

  test(`${control.operation} answers state_conflict before control_refused on a nonterminal node`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.transaction((tx) => setNodeState(tx, h.nodeId, control.admitted));
    const before = h.node();
    await assert.rejects(
      call(h, control.refused, before.attempt!),
      rejectsWith(ControlError.StateConflict),
    );
    await assert.rejects(
      call(h, control.admitted, before.attempt! + STALE_ATTEMPT),
      rejectsWith(ControlError.StateConflict),
    );
    h.store.transaction((tx) => setNodeState(tx, h.nodeId, control.refused));
    await assert.rejects(
      call(h, control.admitted, before.attempt!),
      rejectsWith(ControlError.StateConflict),
    );
    assert.equal(h.node().state, control.refused);
  });

  test(`${control.operation} answers control_refused when expected state equals the current state outside the admitted states`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.transaction((tx) => setNodeState(tx, h.nodeId, control.refused));
    const before = h.node();
    await assert.rejects(
      call(h, control.refused, before.attempt!),
      rejectsWith(ControlError.Refused),
    );
    assert.deepEqual(h.node(), before);
  });
}

const unblock = (
  h: ReturnType<typeof controlHarness>,
  blockedAttempt: number,
) =>
  h.invoke("node.unblock", {
    params: { nodeId: h.nodeId },
    query: {},
    body: {
      expectedMissionVersion: FIRST,
      expectedRevision: FIRST,
      blockedAttempt,
    },
  } as never);

for (const terminal of [NodeState.Completed, NodeState.Discarded]) {
  test(`node.unblock on a ${terminal} node answers terminal before blockedAttempt and admitted states`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.transaction((tx) => setNodeState(tx, h.nodeId, terminal));
    const before = h.node();
    await assert.rejects(
      unblock(h, STALE_ATTEMPT),
      rejectsWith(MissionErrorCode.Terminal),
    );
    await assert.rejects(
      unblock(h, before.attempt!),
      rejectsWith(MissionErrorCode.Terminal),
    );
    assert.deepEqual(h.node(), before);
  });
}

test("node.unblock answers state_conflict before control_refused on a nonterminal node", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const before = h.node();
  await assert.rejects(
    unblock(h, before.attempt! + STALE_ATTEMPT),
    rejectsWith(ControlError.StateConflict),
  );
  assert.deepEqual(h.node(), before);
});

test("node.unblock answers control_refused when blockedAttempt equals the current attempt outside the admitted states", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const before = h.node();
  await assert.rejects(
    unblock(h, before.attempt!),
    rejectsWith(ControlError.Refused),
  );
  assert.deepEqual(h.node(), before);
});

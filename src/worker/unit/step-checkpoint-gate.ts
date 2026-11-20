import assert from "node:assert/strict";
import { DeadlineKind } from "./chain.ts";
import type { Step } from "./chain-host.ts";
import { nodeUnitOf } from "./release-gate.ts";
import { next } from "./step-support.ts";
import type { StepsState } from "./steps-implement.ts";
import {
  checkpointGate,
  isTurnViolation,
  unitCommitMessage,
  ViolationEnd,
} from "./turn-gate.ts";

const NO_CHECKOUTS = 0;

function checkpointMessage(state: StepsState): string {
  return unitCommitMessage(
    state,
    state.task ?? nodeUnitOf(state.input.claim.node_id, state.revision),
  );
}

export const checkpointGateExit: Step<unknown, "state", never> = {
  id: "checkpoint.gate",
  deadline: DeadlineKind.Cleanup,
  reads: ["state"],
  writes: [],
  stops: [
    "operation_failed/worker.turn.*",
    "operation_failed/worker.git.commit_failed",
    "operation_failed/worker.merge.markers_left",
  ],
  note: "aborts the agent; concludes a resolved open merge; aborts each other MERGE_HEAD; commits the partial work of the current unit",
  async run({ state }, scope, io) {
    assert.ok(state.checkouts.length > NO_CHECKOUTS);
    await state.agent.abort();
    await checkpointGate(state, {
      message: checkpointMessage(state),
      merge: state.openMerge?.resolved ? state.openMerge : null,
      context: io.context,
      violationEnd: ViolationEnd.Stop,
    });
    return next(scope);
  },
};

export const checkpointGateRestore: Step<unknown, "state" | "stop", never> = {
  id: "checkpoint.gate(restore)",
  deadline: DeadlineKind.Cleanup,
  reads: ["state", "stop"],
  writes: [],
  stops: [],
  note: "aborts the agent; aborts every MERGE_HEAD; skipped after a turn violation; a violation restores",
  async run({ state, stop }, scope, io) {
    await state.agent.abort();
    if (!isTurnViolation(stop.code))
      await checkpointGate(state, {
        message: checkpointMessage(state),
        merge: null,
        context: io.context,
        violationEnd: ViolationEnd.Restore,
      });
    return next(scope);
  },
};

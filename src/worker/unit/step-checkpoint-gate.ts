import assert from "node:assert/strict";
import { DeadlineKind, type Step } from "./chain.ts";
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
  ],
  note: "aborts the agent; commits the partial work of the current unit",
  async run({ state }, scope, io) {
    assert.ok(state.checkouts.length > NO_CHECKOUTS);
    await state.agent.abort();
    await checkpointGate(
      state,
      checkpointMessage(state),
      io.context,
      ViolationEnd.Stop,
    );
    return next(scope);
  },
};

export const checkpointGateRestore: Step<unknown, "state" | "stop", never> = {
  id: "checkpoint.gate(restore)",
  deadline: DeadlineKind.Cleanup,
  reads: ["state", "stop"],
  writes: [],
  stops: [],
  note: "aborts the agent; skipped after a turn violation; a violation restores",
  async run({ state, stop }, scope, io) {
    await state.agent.abort();
    if (!isTurnViolation(stop.code))
      await checkpointGate(
        state,
        checkpointMessage(state),
        io.context,
        ViolationEnd.Restore,
      );
    return next(scope);
  },
};

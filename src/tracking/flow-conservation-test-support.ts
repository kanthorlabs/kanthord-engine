import assert from "node:assert/strict";
import { FlowStage, type StageWindow } from "./contract.ts";

const NO_COUNT = 0;
const NEXT_STAGE = 1;

const LAST_STAGE_OF_KIND: readonly FlowStage[] = [
  FlowStage.ReleaseGate,
  FlowStage.Outcome,
];

const STAGE_KIND_OF: Record<FlowStage, string> = {
  [FlowStage.Queued]: "steps",
  [FlowStage.Executing]: "steps",
  [FlowStage.Verification]: "steps",
  [FlowStage.ReleaseGate]: "steps",
  [FlowStage.Evaluation]: "evaluation",
  [FlowStage.Outcome]: "evaluation",
};

export function exitSum(window: StageWindow): number {
  return Object.values(window.exits).reduce(
    (total, exit) => total + (exit?.count ?? NO_COUNT),
    NO_COUNT,
  );
}

export function assertConserved(
  label: string,
  stages: readonly { stage: FlowStage; current: StageWindow }[],
): void {
  stages.forEach(({ stage, current }, index) => {
    const exits = exitSum(current);
    assert.ok(
      exits <= current.entered,
      `${label} ${stage}: exits ${exits} > entered ${current.entered}`,
    );
    if (LAST_STAGE_OF_KIND.includes(stage))
      assert.equal(exits, current.entered, `${label} ${stage}`);
    const next = stages[index + NEXT_STAGE];
    if (
      next === undefined ||
      STAGE_KIND_OF[next.stage] !== STAGE_KIND_OF[stage]
    )
      return;
    assert.ok(
      current.entered + current.unobserved >=
        next.current.entered + next.current.unobserved,
      `${label} ${stage} to ${next.stage}`,
    );
  });
}

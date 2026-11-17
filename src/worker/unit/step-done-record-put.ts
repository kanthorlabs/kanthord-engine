import assert from "node:assert/strict";
import { DeadlineKind, type FoundryStep } from "./chain.ts";
import { writeDoneRecord } from "./done-record.ts";
import { next } from "./step-support.ts";
import type { UnitScope } from "./step-unit-enter.ts";
import { TaskResultKind } from "./steps-implement.ts";

export const doneRecordPut: FoundryStep<UnitScope, "state", never> = {
  foundry: true,
  id: "done_record.put",
  deadline: DeadlineKind.Work,
  reads: ["state"],
  writes: [],
  stops: ["operation_failed/worker.git.commit_failed"],
  note: "on a pass; the done trailer on the commits of the unit",
  async run({ state }, scope) {
    if (scope.result !== null) return next(scope);
    assert.ok(scope.gated);
    scope.result = {
      kind: TaskResultKind.Complete,
      recorded: await writeDoneRecord(state, scope.unit, scope.gated.commits()),
    };
    return next(scope);
  },
};

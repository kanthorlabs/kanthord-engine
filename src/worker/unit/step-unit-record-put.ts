import assert from "node:assert/strict";
import { DeadlineKind, type FoundryStep } from "./chain.ts";
import { type ImplementPorts, PortResultKind } from "./foundry-ports.ts";
import { next } from "./step-support.ts";
import type { UnitScope } from "./step-unit-enter.ts";
import { TaskResultKind } from "./steps-implement.ts";
import { recordsUnit, unitRecordOf } from "./unit-record.ts";

export const unitRecordPut: FoundryStep<
  UnitScope,
  "state",
  never,
  ImplementPorts
> = {
  foundry: true,
  id: "unit_record.put",
  ports: ["unitRecords.put"],
  deadline: DeadlineKind.Work,
  reads: ["state"],
  writes: [],
  stops: ["revoked"],
  note: "on a pass; the unit record of the checkouts that hold a gate commit of the unit; a failed put ends nothing",
  async run({ state }, scope, io) {
    if (scope.result !== null) return next(scope);
    assert.ok(scope.gated);
    const { unit } = scope;
    const record = unitRecordOf(state, unit, scope.gated.commits());
    scope.result = {
      kind: TaskResultKind.Complete,
      committed: record !== null,
    };
    if (!recordsUnit(state, unit)) return next(scope);
    if (record === null) {
      state.ports.log.log("unit record skipped", { unit_id: unit.id });
      return next(scope);
    }
    const put = await io.ports.unitRecords.put(record, io.context);
    if (io.context.signal.aborted) return next(scope);
    if (put.kind === PortResultKind.Failed)
      state.ports.log.log("unit record failed", {
        unit_id: unit.id,
        code: put.code,
      });
    else
      state.ports.log.log("unit recorded", {
        unit_id: unit.id,
        commits: record.commits.map(({ commit }) => commit),
      });
    return next(scope);
  },
};

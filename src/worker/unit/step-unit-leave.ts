import assert from "node:assert/strict";
import { DeadlineKind, type FoundryStep } from "./chain.ts";
import { isDone } from "./done-record.ts";
import { next } from "./step-support.ts";
import type { UnitScope } from "./step-unit-enter.ts";
import { TaskResultKind } from "./steps-implement.ts";

export const unitLeave: FoundryStep<
  UnitScope,
  "state" | "plan" | "completedUnits" | "reports",
  "completedUnits" | "reports"
> = {
  foundry: true,
  id: "unit.leave",
  ports: [],
  deadline: DeadlineKind.Work,
  reads: ["state", "plan", "completedUnits", "reports"],
  writes: ["completedUnits", "reports"],
  stops: [],
  note: "notes the final agent text for the coder report; counts the completed unit",
  async run(ctx, scope) {
    const { unit, result } = scope;
    assert.ok(result?.kind === TaskResultKind.Complete);
    const reports = new Map(ctx.reports);
    const text = ctx.state.agent.lastText();
    if (text?.trim())
      reports.set(unit.id, `## ${unit.id} ${unit.content.name}\n\n${text}`);
    else reports.delete(unit.id);
    const completedUnits = new Set(ctx.completedUnits);
    if (
      scope.node !== null ||
      (result.recorded && !isDone(ctx.plan.done, unit))
    )
      completedUnits.add(unit.id);
    return next(scope, { completedUnits, reports });
  },
};

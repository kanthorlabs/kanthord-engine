import type { StepWatch } from "./foundry.ts";
import type { UnitScope } from "./step-unit-enter.ts";
import type { TasksOutput } from "./tasks-output.ts";

const OBJECT_TYPE = "object";
const NO_START = 0;

export interface StepTime {
  step: string;
  ms: number;
}

function isUnitScope(scope: unknown): scope is UnitScope {
  if (scope === null || typeof scope !== OBJECT_TYPE) return false;
  const value = scope as object;
  return "unit" in value && "round" in value;
}

function unitRecordOf(scope: UnitScope) {
  return {
    unit: scope.unit,
    node: scope.node,
    instruction: scope.instruction,
    template: scope.template,
    ruled: scope.ruled,
    revised: scope.revised,
    unchanged_before: scope.unchangedBefore,
    commands: scope.commands,
    passed: scope.passed,
    result: scope.result,
  };
}

export class StepRecord implements StepWatch {
  private readonly output: TasksOutput;
  private readonly times: StepTime[] = [];
  private readonly units = new Map<string, UnitScope>();
  private startedAt = NO_START;

  constructor(output: TasksOutput) {
    this.output = output;
  }

  started(step: string): void {
    this.output.enterStep(step);
    this.startedAt = Date.now();
  }

  ended(step: string, scope: unknown): void {
    this.times.push({ step, ms: Date.now() - this.startedAt });
    if (isUnitScope(scope)) this.units.set(scope.unit.id, scope);
    this.output.enterStep(null);
  }

  stepTimes(): readonly StepTime[] {
    return this.times;
  }

  unitScopes(): Record<string, unknown> {
    return Object.fromEntries(
      [...this.units].map(([id, scope]) => [id, unitRecordOf(scope)]),
    );
  }
}

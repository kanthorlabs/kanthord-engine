import { PromptTemplate } from "../../agent/contract.ts";
import type { TaskContent } from "../../mission/contract.ts";
import { DeadlineKind, type FoundryStep } from "./chain.ts";
import { next } from "./step-support.ts";
import {
  type NodeInstruction,
  ownCommandsOf,
  type StepsState,
  type TaskResult,
  type TaskRunner,
} from "./steps-implement.ts";
import {
  gatedAgent,
  type GatedAgent,
  NO_UNCHANGED_TURNS,
  unitCommitMessage,
} from "./turn-gate.ts";

const NO_CHECKOUTS = 0;

export interface RoundUnit {
  task: TaskContent;
  instruction: string | null;
  node: NodeInstruction | null;
}

export interface RoundScope {
  units: readonly RoundUnit[];
  planned: boolean;
  runner: TaskRunner | null;
}

export interface UnitScope {
  round: RoundScope;
  index: number;
  unit: TaskContent;
  node: NodeInstruction | null;
  instruction: string | null;
  template: PromptTemplate;
  ruled: boolean;
  revised: boolean;
  unchangedBefore: number;
  commands: readonly string[];
  gated: GatedAgent | null;
  passed: boolean;
  result: TaskResult | null;
}

export function unitScopeOf(
  round: RoundScope,
  index: number,
): UnitScope | null {
  const entry = round.units[index];
  if (entry === undefined) return null;
  return {
    round,
    index,
    unit: entry.task,
    node: entry.node,
    instruction: entry.instruction,
    template: PromptTemplate.TaskRevision,
    ruled: false,
    revised: false,
    unchangedBefore: NO_UNCHANGED_TURNS,
    commands: [],
    gated: null,
    passed: false,
    result: null,
  };
}

export function runnerOf(scope: UnitScope): TaskRunner | null {
  return scope.node === null ? scope.round.runner : null;
}

export function openUnit(state: StepsState, scope: UnitScope): void {
  const { unit, node } = scope;
  if (node === null) {
    state.ports.log.log("task started", { task_id: unit.id });
    scope.gated = gatedAgent(state, unitCommitMessage(state, unit));
    return;
  }
  scope.commands = ownCommandsOf(unit, state.revision);
  scope.gated = gatedAgent(state, unitCommitMessage(state, unit));
  scope.ruled = node.judged.length > NO_CHECKOUTS;
  scope.instruction = node.text;
  scope.template = PromptTemplate.CriterionRevision;
  state.ports.log.log("node instruction started", {
    task_id: unit.id,
    ruled: scope.ruled,
  });
}

export const unitEnter: FoundryStep<UnitScope, "state", never> = {
  foundry: true,
  id: "unit.enter",
  deadline: DeadlineKind.Work,
  reads: ["state"],
  writes: [],
  stops: [],
  note: "names the current unit; a planned round resets the unchanged-turn count",
  async run({ state }, scope) {
    state.task = scope.unit;
    state.revisionCount = 0;
    if (scope.round.planned) state.unchangedTurns = NO_UNCHANGED_TURNS;
    if (runnerOf(scope) === null) openUnit(state, scope);
    return next(scope);
  },
};

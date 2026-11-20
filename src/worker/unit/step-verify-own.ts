import assert from "node:assert/strict";
import { PromptTemplate } from "../../agent/contract.ts";
import type { TaskContent } from "../../mission/contract.ts";
import { DeadlineKind, type FoundryStep } from "./chain.ts";
import { EndReason, ExecutionStop } from "./execution-stop.ts";
import type { ImplementPorts } from "./foundry-ports.ts";
import { taskRevisionInstruction } from "./judgement.ts";
import {
  AGENT_REASON_MAX_LENGTH,
  noProgressDetail,
  NoProgressRule,
  verificationFactsOf,
} from "./progress-rule.ts";
import {
  budgetEnd,
  type BudgetEndResult,
  next,
  stopsReturned,
} from "./step-support.ts";
import type { NextResult } from "./step-support.ts";
import type { UnitScope } from "./step-unit-enter.ts";
import {
  type CheckedRun,
  headSetOf,
  type NodeInstruction,
  type StepsState,
  verifyCommands,
  verifyTaskRun,
} from "./steps-implement.ts";
import { verdictRuleHolds } from "./verdict-rule.ts";
import { verificationPassed } from "./verification.ts";

const NO_PROGRESS_LIMIT = 2;
const ONE_TURN = 1;

type Verified = NextResult<UnitScope, never> | BudgetEndResult<UnitScope>;

function lastTemplateOf(scope: UnitScope): PromptTemplate {
  return scope.instruction === null ? PromptTemplate.Work : scope.template;
}

async function agentReasonOf(
  state: StepsState,
): Promise<{ agent_reason?: string }> {
  const text = state.agent.lastText();
  if (!text) return {};
  const redacted = await state.ports.secrets.redact(
    text,
    AGENT_REASON_MAX_LENGTH,
  );
  return redacted === null ? {} : { agent_reason: redacted.toWellFormed() };
}

async function countUnchangedTurn(
  state: StepsState,
  scope: UnitScope,
  rule: NoProgressRule,
): Promise<void> {
  state.unchangedTurns++;
  if (state.unchangedTurns < NO_PROGRESS_LIMIT) return;
  throw new ExecutionStop(EndReason.NoProgress, null, {
    detail: noProgressDetail({
      rule,
      count: state.unchangedTurns,
      limit: NO_PROGRESS_LIMIT,
      verification: state.lastVerification,
      unit_id: scope.unit.id,
      template: lastTemplateOf(scope),
      ...(await agentReasonOf(state)),
    }),
  });
}

function recordTaskVerification(
  state: StepsState,
  unit: TaskContent,
  checked: CheckedRun,
): boolean {
  const { verification } = checked;
  const passed = verificationPassed(verification, checked.commands);
  state.lastVerification = verificationFactsOf(passed, verification);
  state.verificationTimedOut = state.lastVerification?.timed_out ?? false;
  state.ports.log.log("task verified", {
    task_id: unit.id,
    commit: headSetOf(state.checkouts),
    passed,
    exit_codes: verification.results.map((result) => result.exit_code),
  });
  return passed;
}

function revisionInstructionOf(state: StepsState, checked: CheckedRun): string {
  return taskRevisionInstruction(
    state.input.setup.templates,
    checked.verification,
    checked.commands,
    checked.outputs.at(-1) ?? "",
  );
}

async function reviseNodeInstruction(
  state: StepsState,
  scope: UnitScope,
  checked: CheckedRun,
): Promise<string> {
  if (scope.ruled)
    await countUnchangedTurn(state, scope, NoProgressRule.VerdictRuleUnmet);
  const instruction = revisionInstructionOf(state, checked);
  state.revisionCount++;
  return instruction;
}

async function verdictTurnRetried(
  state: StepsState,
  scope: UnitScope,
): Promise<boolean> {
  state.unchangedTurns = scope.unchangedBefore;
  if (state.unchangedTurns + ONE_TURN >= NO_PROGRESS_LIMIT) {
    state.ports.log.log("verdict rule waived for review", {
      task_id: scope.unit.id,
      commit: headSetOf(state.checkouts),
    });
    return false;
  }
  await countUnchangedTurn(state, scope, NoProgressRule.VerdictRuleUnmet);
  state.revisionCount++;
  return true;
}

async function verifyTask(
  state: StepsState,
  scope: UnitScope,
): Promise<Verified> {
  assert.ok(scope.gated);
  if (scope.instruction !== null && !scope.gated.changed())
    await countUnchangedTurn(state, scope, NoProgressRule.UnchangedRevision);
  state.ports.log.log("task committed", {
    task_id: scope.unit.id,
    commit: headSetOf(state.checkouts),
  });
  const checked = await verifyTaskRun(state, scope.unit);
  scope.passed = recordTaskVerification(state, scope.unit, checked);
  if (scope.passed) return next(scope);
  scope.instruction = revisionInstructionOf(state, checked);
  state.revisionCount++;
  return next(scope);
}

async function verdictRuleRetried(
  state: StepsState,
  scope: UnitScope,
  node: NodeInstruction,
): Promise<boolean> {
  assert.ok(scope.gated);
  if (!scope.ruled) {
    if (scope.revised && !scope.gated.changed())
      await countUnchangedTurn(state, scope, NoProgressRule.UnchangedRevision);
    return false;
  }
  scope.ruled = !(await verdictRuleHolds(state, node.judged));
  state.ports.log.log("verdict rule checked", {
    task_id: scope.unit.id,
    commit: headSetOf(state.checkouts),
    holds: !scope.ruled,
  });
  return scope.ruled && (await verdictTurnRetried(state, scope));
}

async function verifyVerdict(
  state: StepsState,
  scope: UnitScope,
  node: NodeInstruction,
): Promise<Verified> {
  if (await verdictRuleRetried(state, scope, node)) return next(scope);
  const checked = await verifyCommands(state, scope.unit, scope.commands);
  scope.passed = recordTaskVerification(state, scope.unit, checked);
  if (scope.passed) return next(scope);
  if (state.agent.budget.exhausted()) return budgetEnd(scope);
  scope.instruction = await reviseNodeInstruction(state, scope, checked);
  scope.template = PromptTemplate.TaskRevision;
  scope.revised = true;
  return next(scope);
}

export const verifyOwn: FoundryStep<
  UnitScope,
  "state",
  "verificationTimedOut",
  ImplementPorts
> = {
  foundry: true,
  id: "verify.own",
  ports: ["releaseTrees.takeBase", "secrets.redact"],
  deadline: DeadlineKind.Work,
  reads: ["state"],
  writes: ["verificationTimedOut"],
  stops: [
    "no_progress",
    "operation_failed/worker.verification.infrastructure_failed",
    "environment_failed/verification_timeout",
    "environment_failed/command_absent",
    "environment_failed/setup_failed",
  ],
  note: "verdict rule, unchanged-turn count, pending setup, own commands; restore on exit",
  async run({ state }, scope) {
    const verified = await stopsReturned(scope, () =>
      scope.node === null
        ? verifyTask(state, scope)
        : verifyVerdict(state, scope, scope.node),
    );
    return {
      ...verified,
      patch: { verificationTimedOut: state.verificationTimedOut },
    };
  },
};

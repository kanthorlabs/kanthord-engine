import assert from "node:assert/strict";
import type { Revision, TaskContent } from "../mission/contract.ts";
import type { ExecutionSetup, RepositoryTransport } from "./contract.ts";
import type { WorkspaceRoot } from "./workspace.ts";
import type { NativeAgent } from "./native-agent.ts";
import { EndReason, ExecutionRun, type MethodClaim } from "./execution-run.ts";
import { renderWorkPrompt } from "./prompt-composer.ts";
import {
  commitWork,
  discardChanges,
  headCommit,
  taskCommitMessage,
} from "./local-git.ts";
import { runVerifications, verificationPassed } from "./verification.ts";
import {
  parseJudgement,
  taskJudgementInstruction,
  taskJudgementSchema,
  taskRevisionInstruction,
  criterionRevisionInstruction,
} from "./judgement.ts";

export const TaskResultKind = {
  Complete: "complete",
  BudgetEnd: "budget_end",
} as const;
export const TaskBoundary = {
  InProgress: "in_progress",
  RunFailed: "run_failed",
  RunPassed: "run_passed",
} as const;
export type TaskBoundary = (typeof TaskBoundary)[keyof typeof TaskBoundary];
export type TaskResult =
  | { kind: typeof TaskResultKind.Complete }
  | { kind: typeof TaskResultKind.BudgetEnd; boundary: TaskBoundary };

export async function runTask(
  state: StepsState,
  task: TaskContent,
): Promise<TaskResult> {
  const budget = state.agent.budget;
  let instruction: string | null = null;
  const ended = (boundary: TaskBoundary): TaskResult => ({
    kind: TaskResultKind.BudgetEnd,
    boundary,
  });
  while (!budget.exhausted()) {
    if (instruction === null) await state.agent.prompt(taskWork(state, task));
    else await state.agent.instruct(taskWork(state, task), instruction);
    if (budget.exhausted()) return ended(TaskBoundary.InProgress);
    await commitWork(
      state.directory,
      taskCommitMessage(task.id, state.input.claim.attempt),
      state.run.operationContext,
      budget.remainingMs(),
    );
    state.head = await headCommit(
      state.directory,
      state.run.operationContext,
      budget.remainingMs(),
    );
    const verification = await verifyTask(state, task);
    if (!verificationPassed(verification, task.content.verifications)) {
      if (budget.exhausted()) return ended(TaskBoundary.RunFailed);
      instruction = taskRevisionInstruction(
        verification,
        task.content.verifications,
      );
      continue;
    }
    if (budget.exhausted()) return ended(TaskBoundary.RunPassed);
    await state.agent.instruct(
      taskWork(state, task),
      taskJudgementInstruction(task),
    );
    if (budget.exhausted()) return ended(TaskBoundary.RunPassed);
    const judgement = parseJudgement(
      state.agent.lastText(),
      taskJudgementSchema,
    );
    if (!judgement) state.run.stop(EndReason.JudgementInvalid);
    if (judgement.criterionMet) return { kind: TaskResultKind.Complete };
    instruction = criterionRevisionInstruction(judgement.rationale);
  }
  return ended(TaskBoundary.InProgress);
}

export interface StepsInput {
  claim: MethodClaim;
  setup: ExecutionSetup;
  workspaces: WorkspaceRoot;
  transport: RepositoryTransport;
}
export interface StepsState {
  input: StepsInput;
  run: ExecutionRun;
  agent: NativeAgent;
  revision: Revision;
  directory: string;
  head: string;
  nodeBranch: string;
}

export function prepareStepsWorkspace(input: StepsInput, run: ExecutionRun) {
  const repository = input.setup.repositories[0];
  assert.ok(repository);
  assert.equal(input.claim.executionId, input.setup.executionId);
  return input.workspaces.prepareObjective({
    objectiveId: input.claim.nodeId,
    repository,
    transport: input.transport,
    context: run.operationContext,
    deadlineMs:
      Math.min(
        input.claim.createdAt + input.setup.resourceBudget.wallTimeMs,
        input.claim.expiredAt,
      ) - Date.now(),
  });
}

export function taskWork(state: StepsState, task: TaskContent) {
  return renderWorkPrompt({
    nodeId: task.id,
    revision: state.input.claim.pinnedRevision,
    content: task.content,
  });
}

export async function verifyTask(state: StepsState, task: TaskContent) {
  const verification = await runVerifications({
    directory: state.directory,
    commands: task.content.verifications,
    testedInput: {
      kind: "repository",
      bindingId: state.input.setup.repositories[0]!.bindingId,
      commit: state.head,
    },
    deadline: state.agent.budget.wallDeadline(),
    context: state.run.operationContext,
  });
  const cleanup = state.agent.budget.cleanupContext(state.run.operationContext);
  try {
    await discardChanges(
      state.directory,
      cleanup,
      state.input.claim.expiredAt - Date.now(),
    );
  } finally {
    cleanup.cancel();
  }
  return verification;
}

export async function startCheck(state: StepsState): Promise<TaskContent[]> {
  assert.ok(state.revision.tasks);
  assert.ok(state.head);
  const pending: TaskContent[] = [];
  for (const task of state.revision.tasks) {
    const verification = await verifyTask(state, task);
    if (
      !verificationPassed(verification, task.content.verifications) ||
      state.agent.budget.exhausted()
    ) {
      pending.push(task);
      continue;
    }
    await state.agent.instruct(
      taskWork(state, task),
      taskJudgementInstruction(task),
    );
    if (state.agent.budget.exhausted()) {
      pending.push(task);
      continue;
    }
    const judgement = parseJudgement(
      state.agent.lastText(),
      taskJudgementSchema,
    );
    if (!judgement) state.run.stop(EndReason.JudgementInvalid);
    if (!judgement.criterionMet) pending.push(task);
  }
  return pending;
}

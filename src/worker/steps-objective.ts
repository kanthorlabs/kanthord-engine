import assert from "node:assert/strict";
import type { Revision, TaskContent } from "../mission/contract.ts";
import type { ExecutionSetup, RepositoryTransport } from "./contract.ts";
import { WorkspaceKind, type WorkspaceRoot } from "./workspace.ts";
import type { NativeAgent } from "./native-agent.ts";
import {
  EndReason,
  ExecutionRun,
  type MethodClaim,
  type ExecutionEnd,
} from "./execution-run.ts";
import { CodedError } from "../kernel/errors.ts";
import { renderWorkPrompt } from "./prompt-composer.ts";
import {
  commitWork,
  discardChanges,
  headCommit,
  taskCommitMessage,
  checkpointCommitMessage,
} from "./local-git.ts";
import { runVerifications, verificationPassed } from "./verification.ts";
import {
  parseJudgement,
  taskJudgementInstruction,
  taskJudgementSchema,
  taskRevisionInstruction,
  criterionRevisionInstruction,
} from "./judgement.ts";

export const HEAD_COMMIT_SUBJECT = "Head commit of the node branch";

async function finishObjective(
  state: StepsState,
  task: TaskContent | null,
  boundary: TaskBoundary | null,
): Promise<ExecutionEnd> {
  const furtherWork = boundary !== null && boundary !== TaskBoundary.RunFailed;
  const cleanup = state.agent.budget.cleanupContext(state.run.operationContext);
  const remaining = () => state.input.claim.expiredAt - Date.now();
  try {
    if (furtherWork) {
      assert.ok(task);
      await state.agent.abort();
      await commitWork(
        state.directory,
        checkpointCommitMessage(task.id, state.input.claim.attempt),
        cleanup,
        remaining(),
      );
    }
    await state.input.transport.proveSshIdentity(
      state.input.setup.repositories[0]!.sshIdentity,
      cleanup,
      remaining(),
    );
    await state.input.transport.pushNodeBranch(
      state.directory,
      state.nodeBranch,
      cleanup,
      remaining(),
    );
    if (!furtherWork) {
      const head = await headCommit(state.directory, cleanup, remaining());
      await state.run.submitEvidence(state.input.claim.nodeId, {
        subject: HEAD_COMMIT_SUBJECT,
        assets: [
          {
            kind: "repository",
            address: {
              kind: "repository",
              bindingId: state.input.setup.repositories[0]!.bindingId,
              commit: head,
            },
          },
        ],
      });
    }
    return await state.run.release(furtherWork);
  } finally {
    cleanup.cancel();
  }
}

export async function runStepsObjective(
  state: StepsState,
): Promise<ExecutionEnd> {
  try {
    const checked = await startCheck(state);
    if (checked.budgetEnd)
      return await finishObjective(
        state,
        checked.budgetEnd.task,
        checked.budgetEnd.boundary,
      );
    for (const { task, boundary } of checked.pending) {
      const result = await runTask(state, task, boundary);
      if (result.kind === TaskResultKind.BudgetEnd)
        return await finishObjective(state, task, result.boundary);
    }
    return await finishObjective(state, null, null);
  } catch (error) {
    return state.run.stop(
      EndReason.OperationFailed,
      error instanceof CodedError ? error.code : null,
    );
  } finally {
    state.input.workspaces.release(
      state.input.workspaces.objectiveKey(state.input.claim.nodeId),
      WorkspaceKind.Objective,
    );
  }
}

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
  initialBoundary: TaskBoundary = TaskBoundary.InProgress,
): Promise<TaskResult> {
  const budget = state.agent.budget;
  let instruction: string | null = null;
  let boundary = initialBoundary;
  const ended = (boundary: TaskBoundary): TaskResult => ({
    kind: TaskResultKind.BudgetEnd,
    boundary,
  });
  while (!budget.exhausted()) {
    boundary = TaskBoundary.InProgress;
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
      boundary = TaskBoundary.RunFailed;
      if (budget.exhausted()) return ended(TaskBoundary.RunFailed);
      instruction = taskRevisionInstruction(
        verification,
        task.content.verifications,
      );
      continue;
    }
    boundary = TaskBoundary.RunPassed;
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
  return ended(boundary);
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

export async function startCheck(state: StepsState): Promise<{
  pending: { task: TaskContent; boundary: TaskBoundary }[];
  budgetEnd: { task: TaskContent; boundary: TaskBoundary } | null;
}> {
  assert.ok(state.revision.tasks);
  assert.ok(state.head);
  const pending: { task: TaskContent; boundary: TaskBoundary }[] = [];
  for (const task of state.revision.tasks) {
    const verification = await verifyTask(state, task);
    const passed = verificationPassed(verification, task.content.verifications);
    const boundary = passed ? TaskBoundary.RunPassed : TaskBoundary.RunFailed;
    if (state.agent.budget.exhausted())
      return { pending, budgetEnd: { task, boundary } };
    if (!passed) {
      pending.push({ task, boundary });
      continue;
    }
    await state.agent.instruct(
      taskWork(state, task),
      taskJudgementInstruction(task),
    );
    if (state.agent.budget.exhausted()) {
      return { pending, budgetEnd: { task, boundary } };
    }
    const judgement = parseJudgement(
      state.agent.lastText(),
      taskJudgementSchema,
    );
    if (!judgement) state.run.stop(EndReason.JudgementInvalid);
    if (!judgement.criterionMet) pending.push({ task, boundary });
  }
  return { pending, budgetEnd: null };
}

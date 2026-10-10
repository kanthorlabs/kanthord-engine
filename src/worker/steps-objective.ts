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
import { renderWorkPrompt } from "../agent/prompt-composer.ts";
import {
  commitWork,
  discardChanges,
  headCommit,
  taskCommitMessage,
  checkpointCommitMessage,
} from "./local-git.ts";
import { runVerifications, verificationPassed } from "./verification.ts";
import {
  parseRepaired,
  ReplyRepair,
  taskJudgementInstruction,
  taskJudgementSchema,
  taskRevisionInstruction,
  criterionRevisionInstruction,
} from "./judgement.ts";
import { judgedAt, recordJudged } from "./judged-tasks.ts";
import {
  RefreshResult,
  refreshAtClaim,
  refreshBeforeRelease,
} from "./base-refresh.ts";

export const HEAD_COMMIT_SUBJECT = "Head commit of the node branch";
const NO_TASKS = 0;

async function finishObjective(
  state: StepsState,
  task: TaskContent | null,
  boundary: TaskBoundary | null,
  completedTasks: number,
): Promise<ExecutionEnd> {
  const budgetEnd = boundary !== null && boundary !== TaskBoundary.RunFailed;
  let furtherWork = budgetEnd;
  const cleanup = state.agent.budget.cleanupContext(state.run.operationContext);
  const remaining = () => state.input.claim.expired_at - Date.now();
  try {
    if (furtherWork && task !== null) {
      await state.agent.abort();
      await commitWork(
        state.directory,
        checkpointCommitMessage(task.id, state.input.claim.attempt),
        cleanup,
        remaining(),
      );
    }
    await state.input.transport.proveSshIdentity(
      state.input.setup.repositories[0]!.ssh_identity,
      cleanup,
      remaining(),
    );
    if (
      !furtherWork &&
      !(await refreshBeforeRelease(state, () => allTasksPass(state)))
    )
      furtherWork = true;
    await state.input.transport.pushNodeBranch(
      state.directory,
      state.nodeBranch,
      cleanup,
      remaining(),
    );
    if (!furtherWork) {
      const head = await headCommit(state.directory, cleanup, remaining());
      await state.run.submitEvidence(state.input.claim.node_id, {
        subject: HEAD_COMMIT_SUBJECT,
        assets: [
          {
            kind: "repository",
            address: {
              kind: "repository",
              binding_id: state.input.setup.repositories[0]!.binding_id,
              commit: head,
            },
          },
        ],
      });
    }
    return await state.run.release(
      furtherWork,
      budgetEnd && completedTasks === NO_TASKS
        ? state.agent.budget.limit()
        : null,
    );
  } finally {
    cleanup.cancel();
  }
}

async function checkpointOnStop(state: StepsState): Promise<void> {
  const cleanup = state.run.cleanupContext();
  const remaining = () => state.input.claim.expired_at - Date.now();
  try {
    await state.agent.abort();
    if (state.task)
      await commitWork(
        state.directory,
        checkpointCommitMessage(state.task.id, state.input.claim.attempt),
        cleanup,
        remaining(),
      );
    await state.input.transport.proveSshIdentity(
      state.input.setup.repositories[0]!.ssh_identity,
      cleanup,
      remaining(),
    );
    await state.input.transport.pushNodeBranch(
      state.directory,
      state.nodeBranch,
      cleanup,
      remaining(),
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  } finally {
    cleanup.cancel();
  }
}

export type TaskRunner = (
  state: StepsState,
  task: TaskContent,
  boundary: TaskBoundary,
  instruction: string | null,
) => Promise<TaskResult>;

export async function runStepsObjective(
  state: StepsState,
  taskRunner: TaskRunner = runTask,
): Promise<ExecutionEnd> {
  try {
    if ((await refreshAtClaim(state)) === RefreshResult.BudgetEnd)
      return await finishObjective(
        state,
        null,
        TaskBoundary.InProgress,
        NO_TASKS,
      );
    const checked = await startCheck(state);
    if (checked.budgetEnd)
      return await finishObjective(
        state,
        checked.budgetEnd.task,
        checked.budgetEnd.boundary,
        NO_TASKS,
      );
    let completedTasks = NO_TASKS;
    for (const { task, boundary, instruction } of checked.pending) {
      state.task = task;
      const result = await taskRunner(state, task, boundary, instruction);
      if (result.kind === TaskResultKind.BudgetEnd)
        return await finishObjective(
          state,
          task,
          result.boundary,
          completedTasks,
        );
      completedTasks++;
    }
    return await finishObjective(state, null, null, completedTasks);
  } catch (error) {
    const stopped = state.run.stopOf(error);
    if (stopped.reason !== EndReason.Revoked) await checkpointOnStop(state);
    throw stopped;
  } finally {
    state.input.workspaces.release(
      state.input.workspaces.objectiveKey(state.input.claim.node_id),
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
  initialInstruction: string | null = null,
  worked = false,
): Promise<TaskResult> {
  const budget = state.agent.budget;
  let instruction = initialInstruction;
  let boundary = initialBoundary;
  let workDone = worked;
  const ended = (boundary: TaskBoundary): TaskResult => ({
    kind: TaskResultKind.BudgetEnd,
    boundary,
  });
  state.run.log("task started", { task_id: task.id });
  while (!budget.exhausted()) {
    boundary = TaskBoundary.InProgress;
    if (workDone) workDone = false;
    else if (instruction === null)
      await state.agent.prompt(taskWork(state, task));
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
    state.run.log("task committed", { task_id: task.id, commit: state.head });
    const verification = await verifyTask(state, task);
    const passed = verificationPassed(verification, task.content.verifications);
    state.run.log("task verified", {
      task_id: task.id,
      commit: state.head,
      passed,
      exit_codes: verification.results.map((result) => result.exit_code),
    });
    if (!passed) {
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
    const judgement = await parseRepaired(
      state.agent,
      taskWork(state, task),
      taskJudgementSchema,
    );
    if (judgement === ReplyRepair.BudgetEnd)
      return ended(TaskBoundary.RunPassed);
    if (judgement === ReplyRepair.Invalid)
      state.run.stop(EndReason.JudgementInvalid);
    state.run.log("task judged", {
      task_id: task.id,
      commit: state.head,
      criterion_met: judgement.criterion_met,
    });
    if (judgement.criterion_met) {
      recordJudged(
        objectiveDirectoryOf(state),
        judgedTaskOf(state, task),
        state.head,
      );
      return { kind: TaskResultKind.Complete };
    }
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
  priorRationale: string | null;
  task?: TaskContent;
}

export function prepareStepsWorkspace(input: StepsInput, run: ExecutionRun) {
  const repository = input.setup.repositories[0];
  assert.ok(repository);
  assert.equal(input.claim.execution_id, input.setup.execution_id);
  return input.workspaces.prepareObjective({
    objectiveId: input.claim.node_id,
    repository,
    transport: input.transport,
    context: run.operationContext,
    deadlineMs:
      Math.min(
        input.claim.created_at + input.setup.resource_budget.wall_time_ms,
        input.claim.expired_at,
      ) - Date.now(),
  });
}

export function taskWork(state: StepsState, task: TaskContent) {
  return renderWorkPrompt({
    node_id: task.id,
    revision: state.input.claim.pinned_revision,
    content: task.content,
  });
}

export async function verifyTask(state: StepsState, task: TaskContent) {
  const verification = await runVerifications({
    directory: state.directory,
    commands: task.content.verifications,
    tested_input: {
      kind: "repository",
      binding_id: state.input.setup.repositories[0]!.binding_id,
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
      state.input.claim.expired_at - Date.now(),
    );
  } finally {
    cleanup.cancel();
  }
  return verification;
}

async function allTasksPass(state: StepsState): Promise<boolean> {
  assert.ok(state.revision.tasks);
  for (const task of state.revision.tasks) {
    const verification = await verifyTask(state, task);
    if (!verificationPassed(verification, task.content.verifications))
      return false;
  }
  return true;
}

function objectiveDirectoryOf(state: StepsState): string {
  return state.input.workspaces.objectiveKey(state.input.claim.node_id);
}

function judgedTaskOf(state: StepsState, task: TaskContent) {
  return {
    attempt: state.input.claim.attempt,
    revision: state.input.claim.pinned_revision,
    taskId: task.id,
  };
}

export interface PendingTask {
  task: TaskContent;
  boundary: TaskBoundary;
  instruction: string | null;
}

export async function startCheck(state: StepsState): Promise<{
  pending: PendingTask[];
  budgetEnd: { task: TaskContent; boundary: TaskBoundary } | null;
}> {
  assert.ok(state.revision.tasks);
  assert.ok(state.head);
  const pending: PendingTask[] = [];
  for (const task of state.revision.tasks) {
    state.task = task;
    const verification = await verifyTask(state, task);
    const passed = verificationPassed(verification, task.content.verifications);
    const boundary = passed ? TaskBoundary.RunPassed : TaskBoundary.RunFailed;
    if (state.agent.budget.exhausted())
      return { pending, budgetEnd: { task, boundary } };
    if (!passed) {
      pending.push({ task, boundary, instruction: null });
      continue;
    }
    if (
      judgedAt(objectiveDirectoryOf(state), judgedTaskOf(state, task)) ===
        state.head &&
      !state.priorRationale?.includes(task.id)
    )
      continue;
    if (state.priorRationale?.includes(task.id)) {
      pending.push({
        task,
        boundary,
        instruction: criterionRevisionInstruction(state.priorRationale),
      });
      continue;
    }
    await state.agent.instruct(
      taskWork(state, task),
      taskJudgementInstruction(task, state.priorRationale),
    );
    if (state.agent.budget.exhausted()) {
      return { pending, budgetEnd: { task, boundary } };
    }
    const judgement = await parseRepaired(
      state.agent,
      taskWork(state, task),
      taskJudgementSchema,
    );
    if (judgement === ReplyRepair.BudgetEnd)
      return { pending, budgetEnd: { task, boundary } };
    if (judgement === ReplyRepair.Invalid)
      state.run.stop(EndReason.JudgementInvalid);
    if (judgement.criterion_met)
      recordJudged(
        objectiveDirectoryOf(state),
        judgedTaskOf(state, task),
        state.head,
      );
    if (!judgement.criterion_met)
      pending.push({
        task,
        boundary,
        instruction:
          state.priorRationale === null
            ? null
            : criterionRevisionInstruction(state.priorRationale),
      });
  }
  return { pending, budgetEnd: null };
}

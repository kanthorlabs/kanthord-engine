import assert from "node:assert/strict";
import {
  AssetKind,
  type Revision,
  type TaskContent,
} from "../../mission/contract.ts";
import type { ExecutionSetup, RepositoryTransport } from "../contract.ts";
import { WorkspaceKind, type WorkspaceRoot } from "./workspace.ts";
import type { NativeAgent } from "./native-agent.ts";
import {
  EndReason,
  ExecutionRun,
  type MethodClaim,
  type ExecutionEnd,
} from "./execution-run.ts";
import { renderWorkPrompt } from "../../agent/prompt-composer.ts";
import {
  commitWork,
  discardChanges,
  headCommit,
  taskCommitMessage,
  checkpointCommitMessage,
} from "./local-git.ts";
import {
  runVerificationsWithOutput,
  verificationPassed,
  type VerificationRun,
} from "./verification.ts";
import {
  failedVerificationReport,
  parseJudgement,
  parseRepaired,
  ReplyRepair,
  taskChoiceInstruction,
  taskChoiceSchema,
  taskJudgementInstruction,
  taskJudgementSchema,
  taskRevisionInstruction,
  criterionRevisionInstruction,
} from "./judgement.ts";
import { judgedAt, recordJudged } from "./judged-tasks.ts";
import { readAttemptEvidence } from "./node-reads.ts";
import { Phase } from "./telemetry.ts";
import {
  GitStep,
  withinGit,
  judgementEnd,
  judgementSpan,
  phaseSpan,
  taskEnd,
  taskSpan,
  verificationObserver,
} from "./method-telemetry.ts";
import {
  nodeWork,
  RefreshResult,
  refreshAtClaim,
  refreshBeforeRelease,
} from "./base-refresh.ts";

export const HEAD_COMMIT_SUBJECT = "Head commit of the node branch";
const NO_TASKS = 0;
const NO_PROGRESS_LIMIT = 2;

export function workUnitsOf(
  nodeId: string,
  revision: Pick<Revision, "filename" | "content" | "tasks">,
): TaskContent[] {
  if (revision.tasks.length > NO_TASKS) return revision.tasks;
  return [
    { id: nodeId, filename: revision.filename, content: revision.content },
  ];
}

function unitsOf(state: StepsState): TaskContent[] {
  return workUnitsOf(state.input.claim.node_id, state.revision);
}

async function finishImplement(
  state: StepsState,
  task: TaskContent | null,
  boundary: TaskBoundary | null,
  completedTasks: number,
): Promise<ExecutionEnd> {
  const budgetEnd = boundary !== null && boundary !== TaskBoundary.RunFailed;
  const furtherWork = await state.run.spans.within(
    phaseSpan(Phase.Finish),
    () => settleImplement(state, task, budgetEnd),
  );
  return await state.run.release(
    furtherWork,
    budgetEnd && completedTasks === NO_TASKS
      ? state.agent.budget.limit()
      : null,
  );
}

async function settleImplement(
  state: StepsState,
  task: TaskContent | null,
  budgetEnd: boolean,
): Promise<boolean> {
  assert.ok(state.directory);
  assert.ok(task === null || task.id);
  let furtherWork = budgetEnd;
  const cleanup = state.agent.budget.cleanupContext(state.run.operationContext);
  const remaining = () => state.input.claim.expired_at - Date.now();
  try {
    if (furtherWork && task !== null) {
      await state.agent.abort();
      await withinGit(state.run.spans, GitStep.Commit, () =>
        commitWork(
          state.input.env,
          state.directory!,
          checkpointCommitMessage(task.id, state.input.claim.attempt),
          cleanup,
          remaining(),
        ),
      );
    }
    await withinGit(state.run.spans, GitStep.SshProof, () =>
      state.input.transport.proveSshIdentity(
        state.input.setup.repositories[0]!.ssh_identity,
        cleanup,
        remaining(),
      ),
    );
    if (
      !furtherWork &&
      !(await refreshBeforeRelease(state, () => allTasksPass(state)))
    )
      furtherWork = true;
    await withinGit(state.run.spans, GitStep.Push, () =>
      state.input.transport.pushNodeBranch(
        state.directory!,
        state.nodeBranch,
        cleanup,
        remaining(),
      ),
    );
    if (!furtherWork) {
      const head = await headCommit(
        state.input.env,
        state.directory,
        cleanup,
        remaining(),
      );
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
    return furtherWork;
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
        state.input.env,
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

export async function runStepsImplement(
  state: StepsState,
  taskRunner: TaskRunner = runTask,
): Promise<ExecutionEnd> {
  const spans = state.run.spans;
  try {
    const checked = await spans.within(phaseSpan(Phase.Start), () =>
      startImplement(state),
    );
    if (checked.budgetEnd)
      return await finishImplement(
        state,
        checked.budgetEnd.task,
        checked.budgetEnd.boundary,
        NO_TASKS,
      );
    const ran = await spans.within(phaseSpan(Phase.Tasks), () =>
      runPending(state, checked.pending, taskRunner),
    );
    return await finishImplement(
      state,
      ran.task,
      ran.boundary,
      ran.completedTasks,
    );
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

async function startImplement(state: StepsState): Promise<StartCheck> {
  assert.ok(state.head);
  if ((await refreshAtClaim(state)) === RefreshResult.BudgetEnd)
    return {
      pending: [],
      budgetEnd: { task: null, boundary: TaskBoundary.InProgress },
    };
  return await startCheck(state);
}

async function runPending(
  state: StepsState,
  pending: readonly PendingTask[],
  taskRunner: TaskRunner,
): Promise<{
  task: TaskContent | null;
  boundary: TaskBoundary | null;
  completedTasks: number;
}> {
  assert.ok(pending.length <= unitsOf(state).length);
  let completedTasks = NO_TASKS;
  for (const { task, boundary, instruction } of pending) {
    state.task = task;
    const result = await state.run.spans.within(
      taskSpan(state.run.spans, task),
      () => taskRunner(state, task, boundary, instruction),
      taskEnd,
    );
    if (result.kind === TaskResultKind.BudgetEnd)
      return { task, boundary: result.boundary, completedTasks };
    completedTasks++;
  }
  return { task: null, boundary: null, completedTasks };
}

async function judgeTask(
  state: StepsState,
  task: TaskContent,
  priorRationale: string | null,
) {
  assert.ok(state.head);
  assert.ok(task.content.criterion);
  return state.run.spans.within(
    judgementSpan(state.run.spans, task, state.head),
    async () => {
      await state.agent.instruct(
        taskWork(state, task),
        taskJudgementInstruction(
          state.input.setup.templates,
          task,
          priorRationale,
        ),
      );
      if (state.agent.budget.exhausted()) return ReplyRepair.BudgetEnd;
      return await parseRepaired(
        state.input.setup.templates,
        state.agent,
        taskWork(state, task),
        taskJudgementSchema,
      );
    },
    judgementEnd,
  );
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
): Promise<TaskResult> {
  const budget = state.agent.budget;
  let instruction = initialInstruction;
  let boundary = initialBoundary;
  const ended = (boundary: TaskBoundary): TaskResult => ({
    kind: TaskResultKind.BudgetEnd,
    boundary,
  });
  let revisingFailedRun = false;
  let unchangedRevisions = 0;
  state.run.log("task started", { task_id: task.id });
  while (!budget.exhausted()) {
    await state.run.checkClaim();
    boundary = TaskBoundary.InProgress;
    if (instruction === null) await state.agent.prompt(taskWork(state, task));
    else await state.agent.instruct(taskWork(state, task), instruction);
    if (budget.exhausted()) return ended(TaskBoundary.InProgress);
    const commit = await commitWork(
      state.input.env,
      state.directory,
      taskCommitMessage(task.id, state.input.claim.attempt),
      state.run.operationContext,
      budget.remainingMs(),
    );
    unchangedRevisions =
      revisingFailedRun && commit === null ? unchangedRevisions + 1 : 0;
    if (unchangedRevisions >= NO_PROGRESS_LIMIT)
      state.run.stop(EndReason.NoProgress);
    state.head = await headCommit(
      state.input.env,
      state.directory,
      state.run.operationContext,
      budget.remainingMs(),
    );
    state.run.log("task committed", { task_id: task.id, commit: state.head });
    const { verification, outputs } = await verifyTaskRun(state, task);
    const passed = verificationPassed(verification, task.content.verifications);
    state.run.log("task verified", {
      task_id: task.id,
      commit: state.head,
      passed,
      exit_codes: verification.results.map((result) => result.exit_code),
    });
    revisingFailedRun = !passed;
    if (!passed) {
      boundary = TaskBoundary.RunFailed;
      if (budget.exhausted()) return ended(TaskBoundary.RunFailed);
      instruction = taskRevisionInstruction(
        state.input.setup.templates,
        verification,
        task.content.verifications,
        outputs.at(-1) ?? "",
      );
      continue;
    }
    boundary = TaskBoundary.RunPassed;
    if (budget.exhausted()) return ended(TaskBoundary.RunPassed);
    const judgement = await judgeTask(state, task, null);
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
        nodeDirectoryOf(state),
        judgedTaskOf(state, task),
        state.head,
      );
      return { kind: TaskResultKind.Complete };
    }
    instruction = criterionRevisionInstruction(
      state.input.setup.templates,
      judgement.rationale,
    );
  }
  return ended(boundary);
}

export interface StepsInput {
  claim: MethodClaim;
  setup: ExecutionSetup;
  workspaces: WorkspaceRoot;
  transport: RepositoryTransport;
  env: NodeJS.ProcessEnv;
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
  rework: boolean;
  task?: TaskContent;
}

export async function prepareStepsWorkspace(
  input: StepsInput,
  run: ExecutionRun,
) {
  const repository = input.setup.repositories[0];
  assert.ok(repository);
  assert.equal(input.claim.execution_id, input.setup.execution_id);
  const pushed = (await readAttemptEvidence(run)).some((evidence) =>
    evidence.assets.some(
      (asset) =>
        asset.kind === AssetKind.Repository &&
        asset.address.binding_id === repository.binding_id,
    ),
  );
  return await input.workspaces.prepareObjective({
    objectiveId: input.claim.node_id,
    nodeBranch: input.claim.node_branch,
    pushed,
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
  return renderWorkPrompt(state.input.setup.templates, {
    node_id: task.id,
    revision: state.input.claim.pinned_revision,
    content: task.content,
  });
}

export async function verifyTask(state: StepsState, task: TaskContent) {
  return (await verifyTaskRun(state, task)).verification;
}

function verifyTaskRun(
  state: StepsState,
  task: TaskContent,
): Promise<VerificationRun> {
  return verifyCommands(state, task.content.verifications);
}

async function verifyCommands(
  state: StepsState,
  commands: readonly string[],
): Promise<VerificationRun> {
  const run = await runVerificationsWithOutput({
    observe: verificationObserver(state.run.spans, state.head),
    directory: state.directory,
    commands,
    tested_input: {
      kind: "repository",
      binding_id: state.input.setup.repositories[0]!.binding_id,
      commit: state.head,
    },
    deadline: state.agent.budget.wallDeadline(),
    context: state.run.operationContext,
    env: state.input.env,
  });
  const cleanup = state.agent.budget.cleanupContext(state.run.operationContext);
  try {
    await discardChanges(
      state.input.env,
      state.directory,
      cleanup,
      state.input.claim.expired_at - Date.now(),
    );
  } finally {
    cleanup.cancel();
  }
  return run;
}

async function allTasksPass(state: StepsState): Promise<boolean> {
  for (const task of unitsOf(state)) {
    const verification = await verifyTask(state, task);
    if (!verificationPassed(verification, task.content.verifications))
      return false;
  }
  return true;
}

function nodeDirectoryOf(state: StepsState): string {
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

export interface StartCheck {
  pending: PendingTask[];
  budgetEnd: { task: TaskContent | null; boundary: TaskBoundary } | null;
}

interface NodeCheck {
  budgetEnd: boolean;
  revised: { task: TaskContent; instruction: string } | null;
}

async function reworkNodeCheck(state: StepsState): Promise<NodeCheck> {
  if (!state.rework) return { budgetEnd: false, revised: null };
  const commands = state.revision.content.verifications;
  const run = await verifyCommands(state, commands);
  const passed = verificationPassed(run.verification, commands);
  state.run.log("node verified", {
    commit: state.head,
    passed,
    exit_codes: run.verification.results.map((result) => result.exit_code),
  });
  if (state.agent.budget.exhausted()) return { budgetEnd: true, revised: null };
  if (passed) return { budgetEnd: false, revised: null };
  const failure = failedVerificationReport(run, commands);
  const task =
    state.revision.tasks.length === NO_TASKS
      ? unitsOf(state)[0]!
      : await chooseTask(state, failure);
  if (task === null) return { budgetEnd: true, revised: null };
  return {
    budgetEnd: false,
    revised: {
      task,
      instruction: criterionRevisionInstruction(
        state.input.setup.templates,
        failure,
      ),
    },
  };
}

async function chooseTask(
  state: StepsState,
  failure: string,
): Promise<TaskContent | null> {
  const tasks = state.revision.tasks;
  const last = tasks.at(-1);
  assert.ok(last);
  await state.agent.instruct(
    nodeWork(state),
    taskChoiceInstruction(state.input.setup.templates, tasks, failure),
  );
  if (state.agent.budget.exhausted()) return null;
  const reply = parseJudgement(state.agent.lastText(), taskChoiceSchema);
  const chosen = tasks.find((task) => task.filename === reply?.filename);
  state.run.log("task chosen", {
    task_id: (chosen ?? last).id,
    commit: state.head,
    fallback: chosen === undefined,
  });
  return chosen ?? last;
}

export async function startCheck(state: StepsState): Promise<StartCheck> {
  assert.ok(state.head);
  const pending: PendingTask[] = [];
  const node = await reworkNodeCheck(state);
  if (node.budgetEnd)
    return {
      pending,
      budgetEnd: { task: null, boundary: TaskBoundary.InProgress },
    };
  for (const task of unitsOf(state)) {
    state.task = task;
    const verification = await verifyTask(state, task);
    const passed = verificationPassed(verification, task.content.verifications);
    const boundary = passed ? TaskBoundary.RunPassed : TaskBoundary.RunFailed;
    if (state.agent.budget.exhausted())
      return { pending, budgetEnd: { task, boundary } };
    if (task.id === node.revised?.task.id) {
      pending.push({ task, boundary, instruction: node.revised.instruction });
      continue;
    }
    if (!passed) {
      pending.push({ task, boundary, instruction: null });
      continue;
    }
    if (
      judgedAt(nodeDirectoryOf(state), judgedTaskOf(state, task)) ===
        state.head &&
      !state.priorRationale?.includes(task.id)
    )
      continue;
    if (state.priorRationale?.includes(task.id)) {
      pending.push({
        task,
        boundary,
        instruction: criterionRevisionInstruction(
          state.input.setup.templates,
          state.priorRationale,
        ),
      });
      continue;
    }
    const judgement = await judgeTask(state, task, state.priorRationale);
    if (judgement === ReplyRepair.BudgetEnd)
      return { pending, budgetEnd: { task, boundary } };
    if (judgement === ReplyRepair.Invalid)
      state.run.stop(EndReason.JudgementInvalid);
    state.run.log("task judged", {
      task_id: task.id,
      commit: state.head,
      criterion_met: judgement.criterion_met,
    });
    if (judgement.criterion_met)
      recordJudged(
        nodeDirectoryOf(state),
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
            : criterionRevisionInstruction(
                state.input.setup.templates,
                state.priorRationale,
              ),
      });
  }
  return { pending, budgetEnd: null };
}

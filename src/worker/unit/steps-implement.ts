import assert from "node:assert/strict";
import {
  AssetKind,
  type Revision,
  type TaskContent,
} from "../../mission/contract.ts";
import type { ExecutionSetup, RepositoryTransport } from "../contract.ts";
import type { SshAccess } from "../../repository/contract.ts";
import {
  sshAccessOf,
  WorkspaceKind,
  workRepositoriesOf,
  type WorkspaceCheckout,
  type WorkspaceRoot,
} from "./workspace.ts";
import type { Context } from "../../kernel/context.ts";
import type { NativeAgent } from "./native-agent.ts";
import {
  checkpointGate,
  gatedAgent,
  type GatedAgent,
  isTurnViolation,
  removeRootEntries,
  restoreCheckout,
  ViolationEnd,
} from "./turn-gate.ts";
import {
  EndReason,
  ExecutionRun,
  type ExecutionStop,
  type MethodClaim,
  type ExecutionEnd,
} from "./execution-run.ts";
import { renderWorkPrompt } from "../../agent/prompt-composer.ts";
import {
  headCommit,
  taskCommitMessage,
  checkpointCommitMessage,
} from "./local-git.ts";
import {
  infrastructureStop,
  runVerificationsWithOutput,
  testedInputOf,
  VerificationClass,
  verificationPassed,
  type VerificationRun,
} from "./verification.ts";
import {
  taskRevisionInstruction,
  criterionRevisionInstruction,
} from "./judgement.ts";
import { isDone, readDoneRecords, writeDoneRecord } from "./done-record.ts";
import { readAttemptEvidence, type Verdict } from "./node-reads.ts";
import {
  judgedCheckouts,
  verdictRuleHolds,
  type JudgedCheckout,
} from "./verdict-rule.ts";
import { Phase } from "./telemetry.ts";
import {
  GitStep,
  withinGit,
  phaseSpan,
  taskEnd,
  taskSpan,
  testedCommitOf,
  verificationObserver,
} from "./method-telemetry.ts";
import { nodeWork, RefreshResult, refreshAtClaim } from "./base-refresh.ts";
import { nodeUnitOf, releaseGate, ReleaseGateKind } from "./release-gate.ts";

export const HEAD_COMMIT_SUBJECT = "Head commit of the node branch";
const NO_TASKS = 0;
const NO_CHECKOUTS = 0;
const NO_PROGRESS_LIMIT = 2;
const SINGLE_CHECKOUT = 1;

export function workUnitsOf(
  nodeId: string,
  revision: Pick<Revision, "filename" | "content" | "tasks">,
): TaskContent[] {
  if (revision.tasks.length > NO_TASKS) return revision.tasks;
  return [nodeUnitOf(nodeId, revision)];
}

function unitsOf(state: StepsState): TaskContent[] {
  return workUnitsOf(state.input.claim.node_id, state.revision);
}

interface UnitsEnd {
  task: TaskContent | null;
  budgetEnd: boolean;
  completedTasks: number;
}

async function finishImplement(
  state: StepsState,
  end: UnitsEnd,
): Promise<ExecutionEnd> {
  await state.run.spans.within(phaseSpan(Phase.Finish), () =>
    settleImplement(state, end),
  );
  return await state.run.release(
    end.budgetEnd,
    end.budgetEnd && end.completedTasks === NO_TASKS
      ? state.agent.budget.limit()
      : null,
  );
}

async function settleImplement(
  state: StepsState,
  end: UnitsEnd,
): Promise<void> {
  assert.ok(state.checkouts.length > NO_CHECKOUTS);
  assert.ok(end.task === null || end.task.id);
  const cleanup = state.agent.budget.cleanupContext(state.run.operationContext);
  const remaining = () => state.input.claim.expired_at - Date.now();
  try {
    if (end.budgetEnd) {
      await state.agent.abort();
      await withinGit(state.run.spans, GitStep.Commit, () =>
        checkpointGate(
          state,
          checkpointMessage(state, end.task),
          cleanup,
          ViolationEnd.Stop,
        ),
      );
    }
    await withinGit(state.run.spans, GitStep.Push, () =>
      pushNodeBranches(state, cleanup, remaining),
    );
    if (!end.budgetEnd) {
      for (const checkout of state.checkouts)
        checkout.head = await headCommit(
          state.input.env,
          checkout.directory,
          cleanup,
          remaining(),
        );
      await state.run.submitEvidence(state.input.claim.node_id, {
        subject: HEAD_COMMIT_SUBJECT,
        assets: state.checkouts.map((checkout) => ({
          kind: "repository",
          address: {
            kind: "repository",
            binding_id: checkout.binding_id,
            commit: checkout.head,
          },
        })),
      });
    }
  } finally {
    cleanup.cancel();
  }
}

function checkpointMessage(
  state: StepsState,
  task: TaskContent | null,
): string {
  return checkpointCommitMessage(
    task?.id ?? state.input.claim.node_id,
    state.input.claim.attempt,
  );
}

async function pushNodeBranches(
  state: StepsState,
  context: Context,
  remaining: () => number,
): Promise<void> {
  for (const checkout of state.checkouts)
    await state.input.transport.pushNodeBranch(
      checkout.directory,
      state.nodeBranch,
      context,
      remaining(),
      sshAccessOf(state.input.sshAccess, checkout.binding_id),
    );
}

export function repositoryOf(
  state: Pick<StepsState, "input">,
  checkout: WorkspaceCheckout,
): ExecutionSetup["repositories"][number] {
  const repository = state.input.setup.repositories.find(
    (row) => row.binding_id === checkout.binding_id,
  );
  assert.ok(repository);
  return repository;
}

async function checkpointOnStop(
  state: StepsState,
  stopped: ExecutionStop,
): Promise<void> {
  const cleanup = state.run.cleanupContext();
  const remaining = () => state.input.claim.expired_at - Date.now();
  try {
    await state.agent.abort();
    if (!isTurnViolation(stopped.code))
      await checkpointGate(
        state,
        checkpointMessage(state, state.task ?? null),
        cleanup,
        ViolationEnd.Restore,
      );
    await pushNodeBranches(state, cleanup, remaining);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const reason = await state.run.reasonOf(error);
    state.run.log("checkpoint failed", reason === null ? {} : { reason });
  } finally {
    cleanup.cancel();
  }
}

export type TaskRunner = (
  state: StepsState,
  task: TaskContent,
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
    const end = checked.budgetEnd
      ? {
          task: checked.budgetEnd.task,
          budgetEnd: true,
          completedTasks: NO_TASKS,
        }
      : await spans.within(phaseSpan(Phase.Tasks), () =>
          runUnits(state, checked, taskRunner),
        );
    return await finishImplement(state, end);
  } catch (error) {
    const stopped = await state.run.stopOf(error);
    if (stopped.reason !== EndReason.Revoked)
      await checkpointOnStop(state, stopped);
    throw stopped;
  } finally {
    state.input.workspaces.release(
      state.input.workspaces.nodeKey(state.input.claim.node_id),
      WorkspaceKind.Node,
    );
  }
}

async function startImplement(state: StepsState): Promise<StartCheck> {
  assert.ok(state.checkouts.length > NO_CHECKOUTS);
  if ((await refreshAtClaim(state)) === RefreshResult.BudgetEnd)
    return {
      pending: [],
      node: null,
      done: new Set(),
      budgetEnd: { task: null },
    };
  return await startCheck(state);
}

async function runUnits(
  state: StepsState,
  checked: StartCheck,
  taskRunner: TaskRunner,
): Promise<UnitsEnd> {
  const completed = new Set<string>();
  let units: readonly PendingTask[] = checked.pending;
  let nodeInstruction = checked.node;
  while (!state.agent.budget.exhausted()) {
    const ran = await runPending(state, units, nodeInstruction, taskRunner, {
      done: checked.done,
      completed,
    });
    if (ran.budgetEnd) return ran;
    nodeInstruction = null;
    const gate = await releaseGate(state);
    if (gate.kind === ReleaseGateKind.Passed)
      return { task: null, budgetEnd: false, completedTasks: completed.size };
    if (gate.kind === ReleaseGateKind.BudgetEnd) break;
    state.run.log("release failure routed", { task_id: gate.unit.id });
    units = [{ task: gate.unit, instruction: gate.instruction }];
  }
  return {
    task: state.task ?? null,
    budgetEnd: true,
    completedTasks: completed.size,
  };
}

interface Completion {
  done: ReadonlySet<string>;
  completed: Set<string>;
}

async function runPending(
  state: StepsState,
  pending: readonly PendingTask[],
  node: NodeInstruction | null,
  taskRunner: TaskRunner,
  { done, completed }: Completion,
): Promise<UnitsEnd> {
  assert.ok(pending.length <= unitsOf(state).length);
  const units = pending.map(({ task, instruction }) => ({
    task,
    verdict: false,
    run: () => taskRunner(state, task, instruction),
  }));
  if (node !== null) {
    const unit = nodeUnitOf(state.input.claim.node_id, state.revision);
    units.push({
      task: unit,
      verdict: true,
      run: () => runNodeInstruction(state, unit, node),
    });
  }
  for (const { task, verdict, run } of units) {
    state.task = task;
    const result = await state.run.spans.within(
      taskSpan(state.run.spans, task),
      run,
      taskEnd,
    );
    if (result.kind === TaskResultKind.BudgetEnd)
      return { task, budgetEnd: true, completedTasks: completed.size };
    if (verdict || (result.recorded && !isDone(done, task)))
      completed.add(task.id);
  }
  return { task: null, budgetEnd: false, completedTasks: completed.size };
}

async function runNodeInstruction(
  state: StepsState,
  unit: TaskContent,
  node: NodeInstruction,
): Promise<TaskResult> {
  const budget = state.agent.budget;
  const ended: TaskResult = { kind: TaskResultKind.BudgetEnd };
  const commands = state.revision.content.verifications;
  const agent = gatedAgent(
    state,
    taskCommitMessage(unit.id, state.input.claim.attempt),
  );
  let ruled = node.judged.length > NO_CHECKOUTS;
  let instruction = node.text;
  let revised = false;
  state.run.log("node instruction started", { task_id: unit.id, ruled });
  while (!budget.exhausted()) {
    await state.run.checkClaim();
    const unchangedTurns = state.unchangedTurns;
    await agent.instruct(taskWork(state, unit), instruction);
    if (budget.exhausted()) return ended;
    if (ruled) {
      ruled = !(await verdictRuleHolds(state, node.judged));
      state.run.log("verdict rule checked", {
        task_id: unit.id,
        commit: headSetOf(state.checkouts),
        holds: !ruled,
      });
      if (ruled) {
        state.unchangedTurns = unchangedTurns;
        countUnchangedTurn(state);
        continue;
      }
    } else if (revised && !agent.changed()) countUnchangedTurn(state);
    const { verification, outputs } = await verifyCommands(state, commands);
    const passed = verificationPassed(verification, commands);
    state.run.log("task verified", {
      task_id: unit.id,
      commit: headSetOf(state.checkouts),
      passed,
      exit_codes: verification.results.map((result) => result.exit_code),
    });
    if (passed) return await completeUnit(state, unit, agent);
    instruction = taskRevisionInstruction(
      state.input.setup.templates,
      verification,
      commands,
      outputs.at(-1) ?? "",
    );
    revised = true;
  }
  return ended;
}

export const TaskResultKind = {
  Complete: "complete",
  BudgetEnd: "budget_end",
} as const;
export type TaskResult =
  | { kind: typeof TaskResultKind.Complete; recorded: boolean }
  | { kind: typeof TaskResultKind.BudgetEnd };

async function completeUnit(
  state: StepsState,
  unit: TaskContent,
  agent: GatedAgent,
): Promise<TaskResult> {
  return {
    kind: TaskResultKind.Complete,
    recorded: await writeDoneRecord(state, unit, agent.commits()),
  };
}

export async function runTask(
  state: StepsState,
  task: TaskContent,
  initialInstruction: string | null = null,
): Promise<TaskResult> {
  const budget = state.agent.budget;
  let instruction = initialInstruction;
  const ended: TaskResult = { kind: TaskResultKind.BudgetEnd };
  state.run.log("task started", { task_id: task.id });
  const agent = gatedAgent(
    state,
    taskCommitMessage(task.id, state.input.claim.attempt),
  );
  while (!budget.exhausted()) {
    await state.run.checkClaim();
    if (instruction === null) await agent.prompt(taskWork(state, task));
    else await agent.instruct(taskWork(state, task), instruction);
    if (budget.exhausted()) return ended;
    if (instruction !== null && !agent.changed()) countUnchangedTurn(state);
    state.run.log("task committed", {
      task_id: task.id,
      commit: headSetOf(state.checkouts),
    });
    const { verification, outputs } = await verifyTaskRun(state, task);
    const passed = verificationPassed(verification, task.content.verifications);
    state.run.log("task verified", {
      task_id: task.id,
      commit: headSetOf(state.checkouts),
      passed,
      exit_codes: verification.results.map((result) => result.exit_code),
    });
    if (passed) return await completeUnit(state, task, agent);
    instruction = taskRevisionInstruction(
      state.input.setup.templates,
      verification,
      task.content.verifications,
      outputs.at(-1) ?? "",
    );
  }
  return ended;
}

function countUnchangedTurn(state: StepsState): void {
  state.unchangedTurns++;
  if (state.unchangedTurns >= NO_PROGRESS_LIMIT)
    state.run.stop(EndReason.NoProgress);
}

export interface StepsInput {
  claim: MethodClaim;
  setup: ExecutionSetup;
  workspaces: WorkspaceRoot;
  transport: RepositoryTransport;
  sshAccess: ReadonlyMap<string, SshAccess>;
  env: NodeJS.ProcessEnv;
}
export interface StepsState {
  input: StepsInput;
  run: ExecutionRun;
  agent: NativeAgent;
  revision: Revision;
  root: string;
  checkouts: WorkspaceCheckout[];
  nodeBranch: string;
  verdict: Verdict | null;
  cleared: string | null;
  unchangedTurns: number;
  task?: TaskContent;
}

export async function prepareStepsWorkspace(
  input: StepsInput,
  run: ExecutionRun,
) {
  assert.ok(input.setup.repositories.length > NO_CHECKOUTS);
  assert.equal(input.claim.execution_id, input.setup.execution_id);
  const pushed = new Set(
    (await readAttemptEvidence(run)).flatMap((evidence) =>
      evidence.assets.flatMap((asset) =>
        asset.kind === AssetKind.Repository ? [asset.address.binding_id] : [],
      ),
    ),
  );
  const deadline = Math.min(
    input.claim.created_at + input.setup.resource_budget.wall_time_ms,
    input.claim.expired_at,
  );
  const prepared = await input.workspaces.prepareImplement({
    nodeId: input.claim.node_id,
    nodeBranch: input.claim.node_branch,
    pushed,
    repositories: input.setup.repositories,
    transport: input.transport,
    sshAccess: input.sshAccess,
    context: run.operationContext,
    deadlineMs: deadline - Date.now(),
  });
  try {
    for (const checkout of prepared.checkouts)
      await restoreCheckout(
        input.env,
        checkout,
        input.claim.node_branch,
        checkout.head,
        run.operationContext,
        () => deadline - Date.now(),
      );
  } catch (error) {
    input.workspaces.release(
      input.workspaces.nodeKey(input.claim.node_id),
      WorkspaceKind.Node,
    );
    throw error;
  }
  return { ...prepared, nodeBranch: input.claim.node_branch };
}

export function taskWork(state: StepsState, task: TaskContent) {
  if (task.id === state.input.claim.node_id) return nodeWork(state);
  return renderWorkPrompt(state.input.setup.templates, {
    node_id: task.id,
    revision: state.input.claim.pinned_revision,
    content: task.content,
    repositories: implementRepositoriesOf(state),
  });
}

export function implementRepositoriesOf(state: StepsState) {
  return workRepositoriesOf(
    state.root,
    state.checkouts.map((checkout) => ({
      name: checkout.name,
      directory: checkout.directory,
      base_branch: repositoryOf(state, checkout).strategy.base_branch,
    })),
  );
}

export function verifyTaskRun(
  state: StepsState,
  task: TaskContent,
): Promise<VerificationRun> {
  return verifyCommands(state, task.content.verifications);
}

async function verifyCommands(
  state: StepsState,
  commands: readonly string[],
): Promise<VerificationRun> {
  const testedInput = testedInputOf(state.checkouts);
  const run = await runVerificationsWithOutput({
    observe: verificationObserver(state.run.spans, testedCommitOf(testedInput)),
    directory: state.root,
    commands,
    tested_input: testedInput,
    deadline: state.agent.budget.wallDeadline(),
    context: state.run.operationContext,
    env: state.input.env,
    exhausted: () => state.agent.budget.exhausted(),
  });
  if (run.outcome === VerificationClass.BudgetEnd)
    state.agent.budget.wallDeadlineReached();
  const cleanup = state.agent.budget.cleanupContext(state.run.operationContext);
  try {
    for (const checkout of state.checkouts)
      await restoreCheckout(
        state.input.env,
        checkout,
        state.nodeBranch,
        checkout.head,
        cleanup,
        () => state.input.claim.expired_at - Date.now(),
      );
    removeRootEntries(state);
  } finally {
    cleanup.cancel();
  }
  const stop = infrastructureStop(run);
  if (stop) throw stop;
  return run;
}

function headSetOf(checkouts: readonly WorkspaceCheckout[]): string {
  assert.ok(checkouts.length >= SINGLE_CHECKOUT);
  if (checkouts.length === SINGLE_CHECKOUT) return checkouts[0]!.head;
  return checkouts
    .map((checkout) => `${checkout.name}=${checkout.head}`)
    .join(",");
}

export interface PendingTask {
  task: TaskContent;
  instruction: string | null;
}

export interface NodeInstruction {
  text: string;
  judged: JudgedCheckout[];
}

export interface StartCheck {
  pending: PendingTask[];
  node: NodeInstruction | null;
  done: ReadonlySet<string>;
  budgetEnd: { task: TaskContent | null } | null;
}

async function nodeInstructionOf(
  state: StepsState,
): Promise<NodeInstruction | null> {
  if (state.verdict === null)
    return state.cleared === null ? null : { text: state.cleared, judged: [] };
  const judged = await judgedCheckouts(state, state.verdict.judged);
  const holds =
    judged.length > NO_CHECKOUTS && (await verdictRuleHolds(state, judged));
  state.run.log("verdict planned", {
    commit: headSetOf(state.checkouts),
    judged: judged.map(({ checkout }) => checkout.name),
    holds,
  });
  if (holds) return null;
  return {
    text: criterionRevisionInstruction(
      state.input.setup.templates,
      state.verdict.text,
    ),
    judged,
  };
}

export async function startCheck(state: StepsState): Promise<StartCheck> {
  assert.ok(state.checkouts.length > NO_CHECKOUTS);
  const node = await nodeInstructionOf(state);
  const done = await readDoneRecords(state);
  const pending = unitsOf(state)
    .filter((task) => !isDone(done, task))
    .map((task) => ({ task, instruction: null }));
  state.run.log("units planned", {
    commit: headSetOf(state.checkouts),
    pending: pending.map(({ task }) => task.id),
  });
  return { pending, node, done, budgetEnd: null };
}

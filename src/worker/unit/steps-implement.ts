import assert from "node:assert/strict";
import type { Revision, TaskContent } from "../../mission/contract.ts";
import type { ExecutionSetup, RepositoryTransport } from "../contract.ts";
import type { SshAccess } from "../../repository/contract.ts";
import {
  workRepositoriesOf,
  type WorkspaceCheckout,
  WorkspaceKind,
  type WorkspaceRoot,
} from "./workspace.ts";
import type { NativeAgent } from "./native-agent.ts";
import { removeRootEntries, restoreCheckout } from "./turn-gate.ts";
import type { CancellationContext } from "../../kernel/context.ts";
import type { ExecutionRun } from "./execution-run.ts";
import type { CommonPorts } from "./foundry-ports.ts";
import {
  EndReason,
  type ExecutionEnd,
  ExecutionStop,
  type MethodClaim,
} from "./execution-run.ts";
import {
  type AffectedTest,
  renderWorkPrompt,
} from "../../agent/prompt-composer.ts";
import {
  environmentStop,
  infrastructureStop,
  runVerificationsWithOutput,
  testedInputOf,
  VerificationClass,
  type VerificationRun,
} from "./verification.ts";
import {
  type BaseHead,
  runSetup,
  SetupEnd,
  type SetupEntry,
} from "./environment-setup.ts";
import { BudgetLimit } from "../../scheduler/contract.ts";
import { criterionRevisionInstruction } from "./judgement.ts";
import { isDone, readDoneRecords } from "./done-record.ts";
import { type Verdict, VerdictSource } from "./node-reads.ts";
import {
  type JudgedCheckout,
  judgedCheckouts,
  verdictRuleHolds,
} from "./verdict-rule.ts";
import { Phase } from "./telemetry.ts";
import {
  environmentDigestsOf,
  testedCommitOf,
  VerificationContext,
  verificationObserver,
} from "./method-telemetry.ts";
import { nodeWork, RefreshResult } from "./base-refresh.ts";
import type { VerificationFacts } from "./progress-rule.ts";
import { nodeUnitOf } from "./release-gate.ts";
import { memoScopeOf, type VerificationMemo } from "./verification-memo.ts";
import { ExecutionBudget } from "./budget.ts";
import { loopNode, StepKind, stepNode } from "./chain.ts";
import {
  implementChain,
  implementWorkspaceNodes,
  revisionsFrame,
} from "./chain-implement.ts";
import { type ChainIo, runChain, runNodes } from "./chain-runner.ts";
import { doneRecordPut } from "./step-done-record-put.ts";
import { setupCommandsOf } from "./step-env-setup.ts";
import { hostOf, seedOf } from "./step-support.ts";
import { openUnit, unitScopeOf } from "./step-unit-enter.ts";
import { workerPorts } from "./worker-ports.ts";

export const HEAD_COMMIT_SUBJECT = "Head commit of the node branch";
const NO_TASKS = 0;
const NO_CHECKOUTS = 0;
const NO_LINK_UPDATES = 0;
const SINGLE_CHECKOUT = 1;
const BASE_MERGED = "base_merged";
const FIRST_UNIT = 0;

export function workUnitsOf(
  nodeId: string,
  revision: Pick<Revision, "filename" | "content" | "tasks">,
): TaskContent[] {
  if (revision.tasks.length > NO_TASKS) return revision.tasks;
  return [nodeUnitOf(nodeId, revision)];
}

export function ownCommandsOf(
  unit: TaskContent,
  revision: Pick<Revision, "content">,
): string[] {
  const node = new Set(revision.content.verifications);
  return unit.content.verifications.filter((command) => !node.has(command));
}

function unitsOf(state: StepsState): TaskContent[] {
  return workUnitsOf(state.input.claim.node_id, state.revision);
}

export function repositoryOf(
  state: Pick<StepsState, "input">,
  checkout: Pick<WorkspaceCheckout, "binding_id">,
): ExecutionSetup["repositories"][number] {
  const repository = state.input.setup.repositories.find(
    (row) => row.binding_id === checkout.binding_id,
  );
  assert.ok(repository);
  return repository;
}

export type TaskRunner = (
  state: StepsState,
  task: TaskContent,
  instruction: string | null,
) => Promise<TaskResult>;

export function stateIo(state: HostedState): ChainIo {
  return {
    run: state.run,
    budget: state.agent.budget,
    resources: new AsyncDisposableStack(),
    host: hostOf(state.input, () => assert.fail("The state holds the agent.")),
    ports: workerPorts(state.input, state.run),
  };
}

export function runStepsImplement(
  state: HostedState,
  taskRunner: TaskRunner | null = null,
): Promise<ExecutionEnd> {
  const io = stateIo(state);
  io.resources.defer(() =>
    state.input.workspaces.release(
      state.input.workspaces.nodeKey(state.input.claim.node_id),
      WorkspaceKind.Node,
    ),
  );
  io.resources.defer(() => state.base.giveBack());
  return runChain(
    implementChain(taskRunner),
    {
      seed: { ...seedOf(state.input), revision: state.revision, state },
      from: Phase.Start,
    },
    io,
  );
}

export const TaskResultKind = {
  Complete: "complete",
  BudgetEnd: "budget_end",
} as const;
export type TaskResult =
  | { kind: typeof TaskResultKind.Complete; recorded: boolean }
  | { kind: typeof TaskResultKind.BudgetEnd };

export async function runTask(
  state: HostedState,
  task: TaskContent,
  initialInstruction: string | null = null,
): Promise<TaskResult> {
  const scope = unitScopeOf(
    {
      units: [{ task, instruction: initialInstruction, node: null }],
      planned: false,
      runner: null,
    },
    FIRST_UNIT,
  );
  assert.ok(scope);
  openUnit(state, scope);
  const end = await runNodes(
    {
      nodes: [loopNode("revisions", revisionsFrame), stepNode(doneRecordPut)],
      seed: { state },
      scope,
    },
    stateIo(state),
  );
  if (end.kind === StepKind.BudgetEnd)
    return { kind: TaskResultKind.BudgetEnd };
  assert.ok(scope.result);
  return scope.result;
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
  cancel: CancellationContext;
  ports: CommonPorts;
  agent: NativeAgent;
  revision: Revision;
  root: string;
  checkouts: WorkspaceCheckout[];
  nodeBranch: string;
  verdict: Verdict | null;
  cleared: string | null;
  unchangedTurns: number;
  refreshed: RefreshResult | null;
  lastVerification: VerificationFacts;
  revisionCount: number;
  setup: SetupEntry[];
  affectedTests: AffectedTest[];
  base: BaseHead;
  setupPending: boolean;
  setupInstruction: string | null;
  memo: VerificationMemo;
  verificationTimedOut: boolean;
  task?: TaskContent;
}

export interface HostedState extends StepsState {
  run: ExecutionRun;
}

export async function prepareStepsWorkspace(
  input: StepsInput,
  run: ExecutionRun,
) {
  const resources = new AsyncDisposableStack();
  try {
    const { kind, ctx } = await runNodes(
      {
        nodes: implementWorkspaceNodes(),
        seed: seedOf(input),
      },
      {
        run,
        budget: new ExecutionBudget({
          ...input.claim,
          resource_budget: input.setup.resource_budget,
        }),
        resources,
        host: hostOf(input, () => assert.fail("The workspace opens no agent.")),
        ports: workerPorts(input, run),
      },
    );
    if (kind === StepKind.BudgetEnd)
      throw new ExecutionStop(EndReason.BudgetEnd, BudgetLimit.WallTime);
    assert.ok(ctx.baseHead);
    return {
      ...ctx.workspace,
      nodeBranch: input.claim.node_branch,
      setup: ctx.setupEntries,
      affectedTests: ctx.affectedTests,
      base: ctx.baseHead,
      setupPending: ctx.setupPending,
      setupInstruction: ctx.setupInstruction,
    };
  } catch (error) {
    await resources.disposeAsync();
    throw error;
  }
}

export function taskWork(state: StepsState, task: TaskContent) {
  if (task.id === state.input.claim.node_id) return nodeWork(state);
  return renderWorkPrompt(state.input.setup.templates, {
    node_id: task.id,
    revision: state.input.claim.pinned_revision,
    content: task.content,
    repositories: implementRepositoriesOf(state),
    affected_tests: state.affectedTests,
    node: state.revision.content,
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

export interface CheckedRun extends VerificationRun {
  commands: readonly string[];
}

export function verifyTaskRun(
  state: StepsState,
  task: TaskContent,
): Promise<CheckedRun> {
  return verifyCommands(state, task, ownCommandsOf(task, state.revision));
}

async function pendingSetup(state: StepsState): Promise<CheckedRun | null> {
  if (!state.setupPending) return null;
  const result = await runSetup(
    {
      env: state.input.env,
      context: state.cancel,
      deadline: state.agent.budget.wallDeadline(),
      spans: state.ports.telemetry,
      exhausted: () => state.agent.budget.exhausted(),
    },
    state.setup,
  );
  if (result.end === SetupEnd.Pass) {
    state.setupPending = false;
    return null;
  }
  if (result.end === SetupEnd.BudgetEnd) {
    state.agent.budget.wallDeadlineReached();
    return {
      verification: {
        tested_input: testedInputOf(state.checkouts),
        results: [],
      },
      outputs: [],
      flaky: [],
      flaky_failures: [],
      outcome: VerificationClass.BudgetEnd,
      commands: setupCommandsOf(state.setup),
    };
  }
  return { ...result.run, commands: result.commands };
}

export async function verifyCommands(
  state: StepsState,
  task: TaskContent,
  commands: readonly string[],
): Promise<CheckedRun> {
  const setup = await pendingSetup(state);
  if (setup !== null) return setup;
  const testedInput = testedInputOf(state.checkouts);
  const context =
    task.id === state.input.claim.node_id
      ? VerificationContext.Node
      : VerificationContext.Task;
  const run = await runVerificationsWithOutput({
    observe: verificationObserver(
      state.ports.telemetry,
      testedCommitOf(testedInput),
      environmentDigestsOf(state.input.setup.repositories),
      { context, ownerOf: () => task.id },
    ),
    memo: await memoScopeOf(state, context, commands),
    directory: state.root,
    commands,
    tested_input: testedInput,
    deadline: state.agent.budget.wallDeadline(),
    context: state.cancel,
    env: state.input.env,
    exhausted: () => state.agent.budget.exhausted(),
    baseline: (command) => state.base.exitOf(command),
  });
  if (run.outcome === VerificationClass.BudgetEnd)
    state.agent.budget.wallDeadlineReached();
  const cleanup = state.agent.budget.cleanupContext(state.cancel);
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
  const stop = infrastructureStop(run) ?? environmentStop(run);
  if (stop) throw stop;
  return { ...run, commands };
}

export function headSetOf(checkouts: readonly WorkspaceCheckout[]): string {
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
  round: number | null;
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
    return state.cleared === null
      ? null
      : { text: state.cleared, judged: [], round: null };
  const judged = await judgedCheckouts(state, state.verdict.judged);
  if (
    state.verdict.source === VerdictSource.FailedChecks &&
    state.refreshed === RefreshResult.Merged
  ) {
    state.ports.log.log("verdict planned", {
      commit: headSetOf(state.checkouts),
      judged: judged.map(({ checkout }) => checkout.name),
      holds: false,
      skipped: BASE_MERGED,
      link_updates: state.verdict.linkUpdates ?? NO_LINK_UPDATES,
    });
    return null;
  }
  const holds =
    judged.length > NO_CHECKOUTS && (await verdictRuleHolds(state, judged));
  state.ports.log.log("verdict planned", {
    commit: headSetOf(state.checkouts),
    judged: judged.map(({ checkout }) => checkout.name),
    holds,
  });
  if (holds) return null;
  return {
    text: criterionRevisionInstruction(
      state.input.setup.templates,
      state.verdict.text,
      state.verdict.findings,
    ),
    judged,
    round: state.verdict.round,
  };
}

export async function startCheck(state: StepsState): Promise<StartCheck> {
  assert.ok(state.checkouts.length > NO_CHECKOUTS);
  const node = await nodeInstructionOf(state);
  const done = await readDoneRecords(state);
  const pending = unitsOf(state)
    .filter((task) => !isDone(done, task))
    .map((task) => ({ task, instruction: null }));
  state.ports.log.log("units planned", {
    commit: headSetOf(state.checkouts),
    pending: pending.map(({ task }) => task.id),
  });
  return { pending, node, done, budgetEnd: null };
}

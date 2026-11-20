import assert from "node:assert/strict";
import type { Revision, TaskContent } from "../../mission/contract.ts";
import type { ExecutionSetup } from "../contract.ts";
import {
  type NodeCheckout,
  workRepositoriesOf,
  type WorkspaceCheckout,
} from "./workspace-layout.ts";
import type { NativeAgent } from "./native-agent-session.ts";
import { removeRootEntries, restoreCheckout } from "./turn-gate.ts";
import type { CancellationContext } from "../../kernel/context.ts";
import type { CommonPorts } from "./foundry-ports.ts";
import type { MethodClaim } from "./execution-stop.ts";
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
import { criterionRevisionInstruction } from "./judgement.ts";
import { isDone, readDoneRecords } from "./done-record.ts";
import { type Verdict, VerdictSource } from "./node-verdict.ts";
import {
  type JudgedCheckout,
  judgedCheckouts,
  verdictRuleHolds,
} from "./verdict-rule.ts";
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
import { setupCommandsOf } from "./step-env-setup.ts";
import { repositoryOf } from "./setup-repository.ts";

export { HEAD_COMMIT_SUBJECT } from "../contract.ts";
const NO_TASKS = 0;
const NO_CHECKOUTS = 0;
const NO_LINK_UPDATES = 0;
const SINGLE_CHECKOUT = 1;
const BASE_MERGED = "base_merged";

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

export type TaskRunner = (
  state: StepsState,
  task: TaskContent,
  instruction: string | null,
) => Promise<TaskResult>;

export const TaskResultKind = {
  Complete: "complete",
  BudgetEnd: "budget_end",
} as const;
export type TaskResult =
  | { kind: typeof TaskResultKind.Complete; recorded: boolean }
  | { kind: typeof TaskResultKind.BudgetEnd };

export interface StepsInput {
  claim: MethodClaim;
  setup: ExecutionSetup;
  env: NodeJS.ProcessEnv;
}

export interface ProgressCtx {
  unchangedTurns: number;
  lastVerification: VerificationFacts;
  revisionCount: number;
}

export interface StepsState extends ProgressCtx {
  input: StepsInput;
  cancel: CancellationContext;
  ports: CommonPorts;
  agent: NativeAgent;
  revision: Revision;
  root: string;
  workspaceKey: string;
  checkouts: NodeCheckout[];
  nodeBranch: string;
  setup: SetupEntry[];
  affectedTests: AffectedTest[];
  base: BaseHead;
  setupPending: boolean;
  setupInstruction: string | null;
  memo: VerificationMemo;
  verificationTimedOut: boolean;
  task?: TaskContent;
}

export interface StartState extends StepsState {
  verdict: Verdict | null;
  cleared: string | null;
  refreshed: RefreshResult | null;
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
  state: StartState,
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

export async function startCheck(state: StartState): Promise<StartCheck> {
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

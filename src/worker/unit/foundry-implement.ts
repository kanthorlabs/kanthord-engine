import assert from "node:assert/strict";
import type { AffectedTest } from "../../agent/prompt-composer.ts";
import type { Revision, TaskContent } from "../../mission/contract.ts";
import { SpanStatus } from "../../tracking/contract.ts";
import type { ExecutionSetup } from "../contract.ts";
import {
  type ChainNode,
  type ExecutionCtx,
  type FoundryEnd,
  FrameOutcome,
  type LoopFrame,
  loopNode,
  stepNode,
} from "./chain.ts";
import type { BaseHead, SetupEntry } from "./environment-setup.ts";
import type { MethodClaim } from "./execution-stop.ts";
import type { CheckoutRef, Commit, ImplementPorts } from "./foundry-ports.ts";
import type { GitPaths } from "./local-git.ts";
import { type FoundryControl, type FoundryHost, runTasks } from "./foundry.ts";
import { taskEnd, taskFailure, taskSpan } from "./method-telemetry.ts";
import type { NativeAgent } from "./native-agent-session.ts";
import {
  type AffectedNote,
  nodeUnitOf,
  RELEASE_GATE_AFFECTED,
  RELEASE_GATE_RESULT,
  RELEASE_GATE_UNIT_ID,
  type ReleaseGate,
  ReleaseGateKind,
} from "./release-gate.ts";
import { baseFetch } from "./step-base-fetch.ts";
import { baseRefreshRelease } from "./step-base-refresh.ts";
import { budgetCheck } from "./step-budget-check.ts";
import { unitRecordPut } from "./step-unit-record-put.ts";
import { releaseRoute } from "./step-release-route.ts";
import { releaseVerify } from "./step-release-verify.ts";
import {
  type RoundScope,
  type RoundUnit,
  unitEnter,
  type UnitScope,
  unitScopeOf,
} from "./step-unit-enter.ts";
import { unitLeave } from "./step-unit-leave.ts";
import { unitRunner } from "./step-unit-runner.ts";
import { unitTurn } from "./step-unit-turn.ts";
import { verifyOwn } from "./step-verify-own.ts";
import {
  type PendingTask,
  type ProgressCtx,
  type StartCheck,
  type StartState,
  TaskResultKind,
  type TaskRunner,
  workUnitsOf,
} from "./steps-implement.ts";
import { SpanOperation } from "./telemetry.ts";
import { NO_UNCHANGED_TURNS, type OpenMerge } from "./turn-gate.ts";
import { VerificationMemo } from "./verification-memo.ts";

const FIRST_UNIT = 0;
const NEXT_UNIT = 1;

export const RELEASE_GATE_LOOP = "release_gate";

export interface ImplementInput extends FoundryControl {
  claim: MethodClaim;
  setup: ExecutionSetup;
  revision: Revision;
  root: string;
  workspaceKey: string;
  checkouts: readonly CheckoutRef[];
  heads: ReadonlyMap<string, Commit>;
  gitPaths: ReadonlyMap<string, GitPaths>;
  setupEntries: readonly SetupEntry[];
  baseHead: BaseHead;
  affectedTests: readonly AffectedTest[];
  plan: StartCheck;
  setupPending: boolean;
  setupInstruction: string | null;
  progress: ProgressCtx;
  agent: NativeAgent;
}

export interface ImplementResult {
  heads: ReadonlyMap<string, Commit>;
  currentUnit: TaskContent | null;
  completedUnits: ReadonlySet<string>;
  reports: ReadonlyMap<string, string>;
  route: ReleaseGate | null;
  progress: ProgressCtx;
  openMerge?: OpenMerge;
}

export const revisionsFrame: LoopFrame<UnitScope> = {
  reads: [],
  note: "until the unit passes; scope of the unit",
  init: (_ctx, outer) => {
    const unit = outer as UnitScope;
    return unit.result === null ? unit : null;
  },
  body: [stepNode(unitTurn), stepNode(verifyOwn)],
  next: (_ctx, scope) => (scope.passed ? null : scope),
};

function withSetupInstruction(
  pending: readonly PendingTask[],
  instruction: string | null,
): readonly PendingTask[] {
  const [first, ...rest] = pending;
  if (instruction === null || !first || first.instruction !== null)
    return pending;
  return [{ ...first, instruction }, ...rest];
}

function unitsFrame(runner: TaskRunner | null): LoopFrame<UnitScope> {
  return {
    reads: ["state"],
    note: "one frame per unit of the round; span worker.task",
    init: (ctx, outer) => {
      const round = outer as RoundScope;
      const { state } = ctx;
      assert.ok(
        round.units.filter((unit) => unit.node === null).length <=
          workUnitsOf(state.input.claim.node_id, state.revision).length,
      );
      return unitScopeOf(round, FIRST_UNIT);
    },
    body: [
      stepNode(unitEnter),
      ...(runner === null ? [] : [stepNode(unitRunner)]),
      loopNode("revisions", revisionsFrame),
      stepNode(unitRecordPut),
      stepNode(unitLeave),
    ],
    next: (_ctx, scope) => unitScopeOf(scope.round, scope.index + NEXT_UNIT),
    span: (_ctx, scope, spans) =>
      taskSpan(spans, scope.unit, scope.node?.round ?? null),
    end: (ctx, scope, ended) => {
      const count = ctx.state.revisionCount;
      if (ended.outcome === FrameOutcome.Stop)
        return taskFailure(ended.error, count);
      if (ended.outcome === FrameOutcome.BudgetEnd)
        return taskEnd({ kind: TaskResultKind.BudgetEnd }, count);
      assert.ok(scope.result);
      return taskEnd(scope.result, count);
    },
  };
}

export const releaseGateFrame: LoopFrame<AffectedNote> = {
  reads: ["state"],
  endReads: ["route"],
  note: "one frame per round; span worker.release_gate; a planned round resets the unchanged-turn count",
  init: (ctx, outer) => {
    const round = outer as RoundScope | null;
    if (round?.planned) ctx.state.unchangedTurns = NO_UNCHANGED_TURNS;
    return { verdict: null };
  },
  body: [
    stepNode(baseFetch),
    stepNode(baseRefreshRelease),
    stepNode(releaseVerify),
    stepNode(releaseRoute),
  ],
  next: () => null,
  span: (_ctx, _scope, spans) => ({
    key: spans.key(SpanOperation.ReleaseGate),
    operation: SpanOperation.ReleaseGate,
  }),
  end: (ctx, scope, ended) => {
    if (ended.outcome === FrameOutcome.Stop)
      return { status: SpanStatus.Error };
    const gate =
      ended.outcome === FrameOutcome.BudgetEnd
        ? { kind: ReleaseGateKind.BudgetEnd }
        : ctx.route;
    return {
      status: SpanStatus.Ok,
      attributes: {
        [RELEASE_GATE_RESULT]: gate.kind,
        ...(scope.verdict === null
          ? {}
          : { [RELEASE_GATE_AFFECTED]: scope.verdict }),
        ...("unit" in gate ? { [RELEASE_GATE_UNIT_ID]: gate.unit.id } : {}),
      },
    };
  },
};

function releaseRoundsFrame(runner: TaskRunner | null): LoopFrame<RoundScope> {
  return {
    reads: ["plan", "state"],
    endReads: ["route"],
    note: "until the release gate passes; a routed failure gives the next round",
    init: ({ plan, state }) => {
      const units: RoundUnit[] = withSetupInstruction(
        plan.pending,
        state.setupInstruction,
      ).map((pending) => ({ ...pending, node: null }));
      if (plan.node !== null)
        units.push({
          task: nodeUnitOf(state.input.claim.node_id, state.revision),
          instruction: null,
          node: plan.node,
        });
      return { units, planned: true, runner };
    },
    body: [
      stepNode(budgetCheck),
      loopNode("units", unitsFrame(runner)),
      loopNode(RELEASE_GATE_LOOP, releaseGateFrame),
    ],
    next: ({ route, state }) => {
      if (route.kind !== ReleaseGateKind.Routed) return null;
      state.ports.log.log("release failure routed", { task_id: route.unit.id });
      return {
        units: [
          { task: route.unit, instruction: route.instruction, node: null },
        ],
        planned: false,
        runner,
      };
    },
  };
}

export function implementTasksNodes(runner: TaskRunner | null): ChainNode[] {
  return [loopNode("release_rounds", releaseRoundsFrame(runner))];
}

function stateOf(input: ImplementInput, ports: ImplementPorts): StartState {
  return {
    input: { claim: input.claim, setup: input.setup, env: input.env },
    cancel: input.cancel,
    ports,
    agent: input.agent,
    revision: input.revision,
    root: input.root,
    workspaceKey: input.workspaceKey,
    checkouts: input.checkouts.map((checkout) => {
      const head = input.heads.get(checkout.binding_id);
      const gitPaths = input.gitPaths.get(checkout.binding_id);
      assert.ok(head !== undefined && gitPaths !== undefined);
      return { ...checkout, head, gitPaths };
    }),
    nodeBranch: input.claim.node_branch,
    setup: [...input.setupEntries],
    affectedTests: [...input.affectedTests],
    base: input.baseHead,
    setupPending: input.setupPending,
    setupInstruction: input.setupInstruction,
    memo: new VerificationMemo(),
    verificationTimedOut: false,
    verdict: null,
    cleared: null,
    refreshed: null,
    ...input.progress,
  };
}

function resultOf(ctx: ExecutionCtx): ImplementResult {
  const { state } = ctx;
  return {
    heads: new Map(
      state.checkouts.map((checkout) => [checkout.binding_id, checkout.head]),
    ),
    currentUnit: state.task ?? null,
    completedUnits: ctx.completedUnits,
    reports: ctx.reports,
    route: "route" in ctx ? ctx.route : null,
    progress: {
      unchangedTurns: state.unchangedTurns,
      lastVerification: state.lastVerification,
      revisionCount: state.revisionCount,
    },
    ...(state.openMerge === undefined ? {} : { openMerge: state.openMerge }),
  };
}

export function runImplementTasks(
  nodes: readonly ChainNode[],
  input: ImplementInput,
  host: FoundryHost<ImplementPorts>,
): Promise<FoundryEnd<ImplementResult>> {
  return runTasks(
    {
      nodes,
      seed: {
        state: stateOf(input, host.ports),
        plan: input.plan,
        completedUnits: new Set(),
        reports: new Map(),
      },
      resultOf,
    },
    input,
    host,
  );
}

export function foundryImplement(
  input: ImplementInput,
  host: FoundryHost<ImplementPorts>,
): Promise<FoundryEnd<ImplementResult>> {
  return runImplementTasks(implementTasksNodes(null), input, host);
}

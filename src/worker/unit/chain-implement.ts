import assert from "node:assert/strict";
import type { Revision } from "../../mission/contract.ts";
import { SpanStatus } from "../../tracking/contract.ts";
import {
  BudgetEndKind,
  type Chain,
  chain,
  ChainId,
  type ChainNode,
  FrameOutcome,
  type LoopFrame,
  loopNode,
  stepNode,
} from "./chain.ts";
import { verificationCommands } from "./evaluation-input.ts";
import {
  phaseSpan,
  taskEnd,
  taskFailure,
  taskSpan,
} from "./method-telemetry.ts";
import {
  type AffectedNote,
  nodeUnitOf,
  RELEASE_GATE_AFFECTED,
  RELEASE_GATE_RESULT,
  RELEASE_GATE_UNIT_ID,
  ReleaseGateKind,
} from "./release-gate.ts";
import { affectedDeclaration } from "./step-affected-declaration.ts";
import { agentOpenImplement } from "./step-agent-open.ts";
import { baseFetch } from "./step-base-fetch.ts";
import { baseRefreshClaim, baseRefreshRelease } from "./step-base-refresh.ts";
import { branchPush, branchPushStop } from "./step-branch-push.ts";
import { budgetCheck } from "./step-budget-check.ts";
import {
  checkpointGateExit,
  checkpointGateRestore,
} from "./step-checkpoint-gate.ts";
import { doneRecordPut } from "./step-done-record-put.ts";
import { envSetupLive } from "./step-env-setup.ts";
import { evidenceHead } from "./step-evidence-head.ts";
import {
  executionRelease,
  executionReleaseBudgetEnd,
} from "./step-execution-release.ts";
import {
  inputsReadAttemptEvidence,
  inputsReadPrior,
} from "./step-inputs-read.ts";
import { releaseRoute } from "./step-release-route.ts";
import { releaseVerify } from "./step-release-verify.ts";
import { reportCoder } from "./step-report-coder.ts";
import { setupEntriesLive } from "./step-setup-entries.ts";
import { stateOpen } from "./step-state-open.ts";
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
import { unitsPlan } from "./step-units-plan.ts";
import { verifyOwn } from "./step-verify-own.ts";
import { workspaceNode } from "./step-workspace-node.ts";
import {
  type PendingTask,
  TaskResultKind,
  type TaskRunner,
  workUnitsOf,
} from "./steps-implement.ts";
import { Phase, type SpanEnd, SpanOperation } from "./telemetry.ts";
import { NO_UNCHANGED_TURNS } from "./turn-gate.ts";

const ONE_FRAME = true;
const FIRST_UNIT = 0;
const NEXT_UNIT = 1;
const NODE_TASK_COUNT = "kanthord.node.task_count";
const NODE_VERIFICATION_COUNT = "kanthord.node.verification_count";
const NODE_BINDING_COUNT = "kanthord.node.binding_count";

function nodeShapeEnd(revision: Revision): SpanEnd {
  return {
    status: SpanStatus.Ok,
    attributes: {
      [NODE_TASK_COUNT]: revision.tasks.length,
      [NODE_VERIFICATION_COUNT]: verificationCommands(revision).length,
      [NODE_BINDING_COUNT]: revision.content.bindings.length,
    },
  };
}

function phaseFrame(phase: Phase, body: readonly ChainNode[]): LoopFrame<true> {
  return {
    reads: [],
    note: `one frame; span worker.phase ${phase}`,
    init: () => ONE_FRAME,
    body,
    next: () => null,
    span: () => phaseSpan(phase),
  };
}

export function implementWorkspaceNodes(): ChainNode[] {
  return [
    stepNode(inputsReadAttemptEvidence),
    stepNode(workspaceNode),
    stepNode(setupEntriesLive),
    stepNode(affectedDeclaration),
    stepNode(envSetupLive),
  ];
}

function prepareWorkspaceFrame(): LoopFrame<true> {
  return {
    ...phaseFrame(Phase.Prepare, implementWorkspaceNodes()),
    reads: ["revision"],
    end: (ctx, _scope, ended) =>
      ended.outcome === FrameOutcome.Next
        ? nodeShapeEnd(ctx.revision)
        : { status: SpanStatus.Error },
  };
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
      stepNode(doneRecordPut),
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
      loopNode("release_gate", releaseGateFrame),
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

export function implementChain(runner: TaskRunner | null = null): Chain {
  return chain(ChainId.Implement)
    .phase(Phase.Prepare)
    .step(inputsReadPrior)
    .loop("prepare.workspace", prepareWorkspaceFrame())
    .step(agentOpenImplement)
    .step(stateOpen)
    .phase(Phase.Start)
    .loop(
      "start",
      phaseFrame(Phase.Start, [
        stepNode(baseRefreshClaim),
        stepNode(unitsPlan),
      ]),
    )
    .phase(Phase.Tasks)
    .loop(
      "tasks",
      phaseFrame(Phase.Tasks, [
        loopNode("release_rounds", releaseRoundsFrame(runner)),
      ]),
    )
    .phase(Phase.Finish)
    .loop(
      "finish",
      phaseFrame(Phase.Finish, [
        stepNode(reportCoder),
        stepNode(branchPush),
        stepNode(evidenceHead),
      ]),
    )
    .step(executionRelease)
    .budgetEnd({
      kind: BudgetEndKind.Exit,
      nodes: [
        loopNode(
          "finish",
          phaseFrame(Phase.Finish, [
            stepNode(checkpointGateExit),
            stepNode(branchPush),
          ]),
        ),
        stepNode(executionReleaseBudgetEnd),
      ],
    })
    .onStop([stepNode(checkpointGateRestore), stepNode(branchPushStop)])
    .build();
}

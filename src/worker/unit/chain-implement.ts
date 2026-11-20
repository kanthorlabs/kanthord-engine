import type { Revision, TaskContent } from "../../mission/contract.ts";
import { SpanStatus } from "../../tracking/contract.ts";
import {
  BudgetEndKind,
  type Chain,
  chain,
  ChainId,
  type ChainNode,
  type ChainTasks,
  type ExecutionCtx,
  FrameOutcome,
  type LoopFrame,
  loopNode,
  namedBranch,
  parallelNode,
  soloBranch,
  stepNode,
} from "./chain.ts";
import {
  IMPLEMENT_HOST_PORTS,
  IMPLEMENT_PORTS,
  type ImplementHostPorts,
  type ImplementPorts,
} from "./foundry-ports.ts";
import type { FoundryControl } from "./foundry.ts";
import {
  type ImplementInput,
  type ImplementResult,
  implementTasksNodes,
  phaseFrame,
  runImplementTasks,
} from "./foundry-implement.ts";
import { verificationCommands } from "./review-scope.ts";
import { affectedDeclaration } from "./step-affected-declaration.ts";
import { agentOpenImplement } from "./step-agent-open.ts";
import { baseRefreshClaim } from "./step-base-refresh.ts";
import { branchPush, branchPushStop } from "./step-branch-push.ts";
import {
  checkpointGateExit,
  checkpointGateRestore,
} from "./step-checkpoint-gate.ts";
import { envSetupLive } from "./step-env-setup-host.ts";
import { evidenceHead } from "./step-evidence-head.ts";
import {
  executionRelease,
  executionReleaseBudgetEnd,
} from "./step-execution-release.ts";
import {
  inputsReadAttemptEvidence,
  inputsReadRevisionPrior,
} from "./step-inputs-read-host.ts";
import { reportCoder } from "./step-report-coder.ts";
import { setupEntriesLive } from "./step-setup-entries-host.ts";
import { stateOpen } from "./step-state-open.ts";
import { unitsPlan } from "./step-units-plan.ts";
import { workspaceNode } from "./step-workspace-node.ts";
import type { TaskRunner } from "./steps-implement.ts";
import { Phase, type SpanEnd } from "./telemetry.ts";

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

export function implementWorkspaceNodes(): ChainNode[] {
  return [
    stepNode(inputsReadAttemptEvidence),
    stepNode(workspaceNode),
    stepNode(setupEntriesLive),
    stepNode(affectedDeclaration),
    stepNode(envSetupLive),
  ];
}

function prepareFrame(): LoopFrame<true> {
  return {
    ...phaseFrame(Phase.Prepare, [
      parallelNode("prepare.inputs", [
        soloBranch(stepNode(inputsReadRevisionPrior)),
        namedBranch("workspace", implementWorkspaceNodes()),
      ]),
    ]),
    endReads: ["revision"],
    end: (ctx, _scope, ended) =>
      ended.outcome === FrameOutcome.Next
        ? nodeShapeEnd(ctx.revision)
        : { status: SpanStatus.Error },
  };
}

export function implementInputOf(
  ctx: ExecutionCtx,
  control: FoundryControl,
): ImplementInput {
  const { state } = ctx;
  return {
    ...control,
    claim: ctx.claim,
    setup: ctx.setup,
    revision: state.revision,
    root: state.root,
    workspaceKey: state.workspaceKey,
    checkouts: state.checkouts.map(({ binding_id, name, directory }) => ({
      binding_id,
      name,
      directory,
    })),
    heads: new Map(
      state.checkouts.map((checkout) => [checkout.binding_id, checkout.head]),
    ),
    gitPaths: new Map(
      state.checkouts.map((checkout) => [
        checkout.binding_id,
        checkout.gitPaths,
      ]),
    ),
    setupEntries: state.setup,
    baseHead: state.base,
    affectedTests: state.affectedTests,
    plan: ctx.plan,
    setupPending: state.setupPending,
    setupInstruction: state.setupInstruction,
    progress: {
      unchangedTurns: state.unchangedTurns,
      lastVerification: state.lastVerification,
      revisionCount: state.revisionCount,
    },
    agent: state.agent,
  };
}

function mergeImplement(ctx: ExecutionCtx, result: ImplementResult): void {
  const { state } = ctx;
  for (const checkout of state.checkouts) {
    const head = result.heads.get(checkout.binding_id);
    if (head !== undefined) checkout.head = head;
  }
  const task: TaskContent | null = result.currentUnit;
  if (task !== null) state.task = task;
  Object.assign(state, result.progress);
  ctx.completedUnits = result.completedUnits;
  ctx.reports = result.reports;
  if (result.route !== null) ctx.route = result.route;
}

function implementPortsOf(ports: ImplementHostPorts): ImplementPorts {
  return {
    telemetry: ports.telemetry,
    secrets: ports.secrets,
    log: ports.log,
    evidence: ports.evidence,
    repository: ports.repository,
    releaseTrees: ports.releaseTrees,
    unitRecords: ports.unitRecords,
  };
}

function implementTasks(
  runner: TaskRunner | null,
): ChainTasks<ImplementHostPorts> {
  const nodes = implementTasksNodes(runner);
  return {
    name: "foundryImplement",
    ports: IMPLEMENT_PORTS,
    nodes,
    async run(ctx, control, host) {
      const end = await runImplementTasks(
        nodes,
        implementInputOf(ctx, control),
        {
          capabilities: host.capabilities,
          ports: implementPortsOf(host.ports),
        },
      );
      mergeImplement(ctx, end.result);
      return end;
    },
  };
}

export function implementChain(
  runner: TaskRunner | null = null,
): Chain<ImplementHostPorts> {
  return chain<ImplementHostPorts>(ChainId.Implement, IMPLEMENT_HOST_PORTS)
    .phase(Phase.Prepare)
    .loop("prepare", prepareFrame())
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
    .tasks(implementTasks(runner))
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

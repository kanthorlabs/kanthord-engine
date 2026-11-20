import assert from "node:assert/strict";
import type { TaskContent } from "../../mission/contract.ts";
import { BudgetLimit } from "../../scheduler/contract.ts";
import { ExecutionBudget } from "./budget.ts";
import { loopNode, StepKind, stepNode } from "./chain.ts";
import { implementChain } from "./chain-implement.ts";
import { affectedDeclaration } from "./step-affected-declaration.ts";
import { inputsReadAttemptEvidence } from "./step-inputs-read-host.ts";
import { setupEntriesLive } from "./step-setup-entries-host.ts";
import { workspaceNode } from "./step-workspace-node.ts";
import { releaseGateFrame, revisionsFrame } from "./foundry-implement.ts";
import { type ChainIo, runChain, runNodes } from "./chain-runner.ts";
import type { ExecutionRun } from "./execution-run.ts";
import type { ImplementHostPorts } from "./foundry-ports.ts";
import {
  EndReason,
  type ExecutionEnd,
  ExecutionStop,
} from "./execution-stop.ts";
import { type ReleaseGate, ReleaseGateKind } from "./release-gate.ts";
import { unitRecordPut } from "./step-unit-record-put.ts";
import { type HostInput, hostOf, seedOf } from "./chain-host.ts";
import { openUnit, unitScopeOf } from "./step-unit-enter.ts";
import {
  type StartState,
  type TaskResult,
  TaskResultKind,
  type TaskRunner,
} from "./steps-implement.ts";
import { Phase } from "./telemetry.ts";
import { WorkspaceKind } from "./workspace-layout.ts";
import { implementHostPorts, workerPorts } from "./worker-ports.ts";

const FIRST_UNIT = 0;

export function stateIo(state: HostedState): ChainIo<ImplementHostPorts> {
  return {
    run: state.run,
    budget: state.agent.budget,
    capabilities: [],
    resources: new AsyncDisposableStack(),
    host: hostOf(state.input),
    ports: implementHostPorts(state.input, {
      run: state.run,
      budget: state.agent.budget,
      open: () => assert.fail("The state holds the agent."),
    }),
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
      seed: {
        ...seedOf(state.input),
        revision: state.revision,
        state,
        workspace: { root: state.root, checkouts: state.checkouts },
        setupEntries: state.setup,
        baseHead: state.base,
      },
      from: Phase.Start,
    },
    io,
  );
}

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
      nodes: [loopNode("revisions", revisionsFrame), stepNode(unitRecordPut)],
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

export interface HostedState extends StartState {
  run: ExecutionRun;
  input: HostInput;
}

export async function prepareStepsWorkspace(
  input: HostInput,
  run: ExecutionRun,
) {
  const resources = new AsyncDisposableStack();
  try {
    const { kind, ctx } = await runNodes(
      {
        nodes: [
          stepNode(inputsReadAttemptEvidence),
          stepNode(workspaceNode),
          stepNode(setupEntriesLive),
          stepNode(affectedDeclaration),
        ],
        seed: seedOf(input),
      },
      {
        run,
        budget: new ExecutionBudget({
          ...input.claim,
          resource_budget: input.setup.resource_budget,
        }),
        capabilities: [],
        resources,
        host: hostOf(input),
        ports: workerPorts(input, run),
      },
    );
    if (kind === StepKind.BudgetEnd)
      throw new ExecutionStop(EndReason.BudgetEnd, BudgetLimit.WallTime);
    assert.ok(ctx.baseHead);
    return {
      ...ctx.workspace,
      workspaceKey: input.workspaces.nodeKey(input.claim.node_id),
      nodeBranch: input.claim.node_branch,
      setup: ctx.setupEntries,
      affectedTests: ctx.affectedTests,
      base: ctx.baseHead,
      setupPending: false,
      setupInstruction: null,
    };
  } catch (error) {
    await resources.disposeAsync();
    throw error;
  }
}

export async function releaseGate(state: HostedState): Promise<ReleaseGate> {
  const end = await runNodes(
    {
      nodes: [loopNode("release_gate", releaseGateFrame)],
      seed: { state },
    },
    stateIo(state),
  );
  return end.kind === StepKind.BudgetEnd
    ? { kind: ReleaseGateKind.BudgetEnd }
    : end.ctx.route;
}

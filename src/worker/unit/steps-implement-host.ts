import assert from "node:assert/strict";
import type { TaskContent } from "../../mission/contract.ts";
import { BudgetLimit } from "../../scheduler/contract.ts";
import { ExecutionBudget } from "./budget.ts";
import { loopNode, StepKind, stepNode } from "./chain.ts";
import {
  implementChain,
  implementWorkspaceNodes,
  releaseGateFrame,
  revisionsFrame,
} from "./chain-implement.ts";
import { type ChainIo, runChain, runNodes } from "./chain-runner.ts";
import {
  EndReason,
  type ExecutionEnd,
  type ExecutionRun,
  ExecutionStop,
} from "./execution-run.ts";
import { type ReleaseGate, ReleaseGateKind } from "./release-gate.ts";
import { doneRecordPut } from "./step-done-record-put.ts";
import { hostOf, seedOf } from "./step-support.ts";
import { openUnit, unitScopeOf } from "./step-unit-enter.ts";
import {
  type StepsInput,
  type StepsState,
  type TaskResult,
  TaskResultKind,
  type TaskRunner,
} from "./steps-implement.ts";
import { Phase } from "./telemetry.ts";
import { WorkspaceKind } from "./workspace.ts";
import { workerPorts } from "./worker-ports.ts";

const FIRST_UNIT = 0;

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

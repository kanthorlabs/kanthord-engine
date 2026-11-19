import { background } from "../../kernel/context.ts";
import { type ChainNode, type ChainStep, NodeKind } from "./chain.ts";
import { tasksPrepareChain } from "./chain-tasks-prepare.ts";
import { EndReason, type ExecutionStop } from "./execution-stop.ts";
import {
  type ImplementResult,
  implementTasksNodes,
} from "./foundry-implement.ts";
import { operationsInProgress } from "./local-git.ts";
import { ReleaseGateKind } from "./release-gate.ts";
import type { TasksPlan } from "./tasks-seed.ts";
import { localGit, type LocalTrees } from "./tasks-trees.ts";

export const RunEndKind = {
  Completed: "completed",
  BudgetEnd: "budget_end",
  Stop: "stop",
  Failed: "failed",
  Diagnostic: "diagnostic",
} as const;
export type RunEndKind = (typeof RunEndKind)[keyof typeof RunEndKind];

export interface RunEnd {
  end: RunEndKind;
  stop: ExecutionStop | null;
  step: string | null;
  result: ImplementResult | null;
  input: unknown;
}

const VerifyCheck = {
  Heads: 3,
  CleanTrees: 5,
  Route: 6,
  StopCode: 7,
} as const;

export interface CheckResult {
  check: number;
  applies: boolean;
  passed: boolean;
}

export interface VerifyInput {
  end: RunEnd;
  trees: LocalTrees;
  plan: TasksPlan;
  env: Readonly<Record<string, string>>;
  until: string | null;
}

const VERIFY_DEADLINE_MS = 60000;
const WILDCARD = "*";
const CODE_SEPARATOR = "/";
const CLEAN_STATUS = "";
const NO_OPERATIONS = 0;
const REQUESTED_STOPS: readonly string[] = [
  EndReason.WorkerStopped,
  EndReason.HumanPaused,
  EndReason.InstanceArchived,
  EndReason.Revoked,
  EndReason.ProviderFailed,
];

function gitCall(input: VerifyInput) {
  return {
    env: input.env,
    context: background,
    deadline: Date.now() + VERIFY_DEADLINE_MS,
  };
}

async function headsMatch(input: VerifyInput): Promise<CheckResult> {
  const { result } = input.end;
  if (result === null)
    return { check: VerifyCheck.Heads, applies: false, passed: true };
  for (const checkout of input.trees.workspace.checkouts) {
    const head = (
      await localGit(checkout.directory, ["rev-parse", "HEAD"], gitCall(input))
    ).trim();
    if (result.heads.get(checkout.binding_id) !== head)
      return { check: VerifyCheck.Heads, applies: true, passed: false };
  }
  return { check: VerifyCheck.Heads, applies: true, passed: true };
}

async function treesClean(input: VerifyInput): Promise<CheckResult> {
  if (input.end.end !== RunEndKind.Completed)
    return { check: VerifyCheck.CleanTrees, applies: false, passed: true };
  for (const checkout of input.trees.workspace.checkouts) {
    const status = await localGit(
      checkout.directory,
      ["status", "--porcelain", "--untracked-files=all"],
      gitCall(input),
    );
    const operations = await operationsInProgress(
      input.env,
      checkout.directory,
      background,
      VERIFY_DEADLINE_MS,
    );
    if (status.trim() !== CLEAN_STATUS || operations.length > NO_OPERATIONS)
      return { check: VerifyCheck.CleanTrees, applies: true, passed: false };
  }
  return { check: VerifyCheck.CleanTrees, applies: true, passed: true };
}

function routeHolds(input: VerifyInput): CheckResult {
  if (input.end.end !== RunEndKind.Completed)
    return { check: VerifyCheck.Route, applies: false, passed: true };
  const route = input.end.result?.route ?? null;
  const passed =
    input.until === null
      ? route?.kind === ReleaseGateKind.Passed
      : route === null;
  return { check: VerifyCheck.Route, applies: true, passed };
}

function stepsOf(nodes: readonly ChainNode[]): ChainStep[] {
  return nodes.flatMap((node) =>
    node.kind === NodeKind.Step ? [node.step] : stepsOf(node.frame.body),
  );
}

function listed(stop: ExecutionStop, stops: readonly string[]): boolean {
  const text =
    stop.code === null
      ? stop.reason
      : `${stop.reason}${CODE_SEPARATOR}${stop.code}`;
  return stops.some((entry) =>
    entry.endsWith(WILDCARD)
      ? text.startsWith(entry.slice(0, -WILDCARD.length))
      : entry === text,
  );
}

function stopListed(input: VerifyInput): CheckResult {
  const { stop, step } = input.end;
  if (stop === null)
    return { check: VerifyCheck.StopCode, applies: false, passed: true };
  const known =
    REQUESTED_STOPS.includes(stop.reason) ||
    (stop.reason === EndReason.OperationFailed && stop.code !== null);
  const steps = stepsOf([
    ...tasksPrepareChain(new Set()).phases.flatMap(({ nodes }) => nodes),
    ...implementTasksNodes(null),
  ]);
  const owner = steps.find((entry) => entry.id === step);
  const passed = known || (owner !== undefined && listed(stop, owner.stops));
  return { check: VerifyCheck.StopCode, applies: true, passed };
}

export async function verifyRun(input: VerifyInput): Promise<CheckResult[]> {
  return [
    await headsMatch(input),
    await treesClean(input),
    routeHolds(input),
    stopListed(input),
  ];
}

import assert from "node:assert/strict";
import { readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Context } from "../../kernel/context.ts";
import type { WorkPrompt } from "../../agent/prompt-composer.ts";
import { EndReason } from "./execution-run.ts";
import type { NativeAgent } from "./native-agent.ts";
import {
  abortMerge,
  commitWork,
  concludeMerge,
  conflictMarkerFiles,
  containsCommit,
  discardChanges,
  forceBranch,
  headCommit,
  isClean,
  MERGE_HEAD,
  mergeHeadOf,
  operationsInProgress,
  quitOperations,
  softReset,
  symbolicHead,
} from "./local-git.ts";
import type { StepsState } from "./steps-implement.ts";
import { SCRATCH_DIRECTORY, type WorkspaceCheckout } from "./workspace.ts";

export const GateMode = {
  Write: "write",
  Conflict: "conflict",
  Checkpoint: "checkpoint",
} as const;
export type GateMode = (typeof GateMode)[keyof typeof GateMode];
export const TurnViolation = {
  BranchChanged: "worker.turn.branch_changed",
  HistoryRewritten: "worker.turn.history_rewritten",
  GitInProgress: "worker.turn.git_in_progress",
  MergeMissing: "worker.turn.merge_missing",
} as const;
export type TurnViolation = (typeof TurnViolation)[keyof typeof TurnViolation];
export const MERGE_MARKERS_LEFT = "worker.merge.markers_left";
const NO_ENTRIES = 0;
const NO_UNCHANGED_TURNS = 0;
const SINGLE_CHECKOUT = 1;
const SCRATCH_ENTRY = basename(SCRATCH_DIRECTORY);
const DETACHED = "a detached HEAD";

export interface ConflictMerge {
  directory: string;
  commit: string;
  files: readonly string[];
}
interface GateTurn {
  mode: GateMode;
  message: string;
  merge: ConflictMerge | null;
}
interface Violation {
  code: TurnViolation;
  detail: string;
}
export interface GatedAgent extends NativeAgent {
  changed(): boolean;
}

export function isTurnViolation(code: string | null): boolean {
  return Object.values<string | null>(TurnViolation).includes(code);
}

export function gatedAgent(
  state: StepsState,
  message: string,
  merge: ConflictMerge | null = null,
): GatedAgent {
  assert.ok(message);
  const agent = state.agent;
  const turn: GateTurn = {
    mode: merge === null ? GateMode.Write : GateMode.Conflict,
    message,
    merge,
  };
  let changed = false;
  const gated = async (work: () => Promise<void>): Promise<void> => {
    const before = state.checkouts.map((checkout) => checkout.head);
    changed = false;
    await work();
    if (agent.budget.exhausted()) return;
    const context = agent.budget.cleanupContext(state.run.operationContext);
    try {
      changed = await runGate(state, turn, before, context);
    } finally {
      context.cancel();
    }
    if (changed) state.unchangedTurns = NO_UNCHANGED_TURNS;
  };
  return {
    budget: agent.budget,
    composition: agent.composition,
    prompt: (work: WorkPrompt) => gated(() => agent.prompt(work)),
    instruct: (work: WorkPrompt, text: string) =>
      gated(() => agent.instruct(work, text)),
    changed: () => changed,
    lastText: () => agent.lastText(),
    abort: () => agent.abort(),
    closeTrace: (status) => agent.closeTrace(status),
    dispose: () => agent.dispose(),
  };
}

export async function checkpointGate(
  state: StepsState,
  message: string,
  context: Context,
): Promise<boolean> {
  return runGate(
    state,
    { mode: GateMode.Checkpoint, message, merge: null },
    state.checkouts.map((checkout) => checkout.head),
    context,
  );
}

async function runGate(
  state: StepsState,
  turn: GateTurn,
  before: readonly string[],
  context: Context,
): Promise<boolean> {
  assert.equal(before.length, state.checkouts.length);
  const remaining = remainingOf(state);
  if (turn.mode === GateMode.Checkpoint)
    for (const checkout of state.checkouts)
      if (mergeHeadOf(checkout.directory) !== null)
        await abortMerge(
          state.input.env,
          checkout.directory,
          context,
          remaining(),
        );
  for (const [index, checkout] of state.checkouts.entries()) {
    const violation = await violationOf(
      state,
      checkout,
      before[index]!,
      mergeOf(turn, checkout),
      context,
    );
    if (violation !== null) await violate(state, before, violation, context);
  }
  let changed = false;
  for (const [index, checkout] of state.checkouts.entries())
    if (await settleCheckout(state, checkout, before[index]!, turn, context))
      changed = true;
  removeRootEntries(state);
  return changed;
}

function mergeOf(
  turn: GateTurn,
  checkout: WorkspaceCheckout,
): ConflictMerge | null {
  return turn.merge?.directory === checkout.directory ? turn.merge : null;
}

function remainingOf(state: StepsState): () => number {
  return () => state.input.claim.expired_at - Date.now();
}

async function violationOf(
  state: StepsState,
  checkout: WorkspaceCheckout,
  before: string,
  merge: ConflictMerge | null,
  context: Context,
): Promise<Violation | null> {
  const env = state.input.env;
  const directory = checkout.directory;
  const remaining = remainingOf(state);
  const branch = `refs/heads/${state.nodeBranch}`;
  const head = await symbolicHead(env, directory, context, remaining());
  if (head !== branch)
    return {
      code: TurnViolation.BranchChanged,
      detail: `The HEAD of checkout ${checkout.name} is ${head ?? DETACHED}, not ${branch}.`,
    };
  if (!(await containsCommit(env, directory, before, context, remaining())))
    return {
      code: TurnViolation.HistoryRewritten,
      detail: `The HEAD of checkout ${checkout.name} does not contain ${before}.`,
    };
  const operations = operationsInProgress(directory).filter(
    (operation) => merge === null || operation !== MERGE_HEAD,
  );
  if (merge !== null && mergeHeadOf(directory) !== merge.commit)
    return {
      code: TurnViolation.MergeMissing,
      detail: `Checkout ${checkout.name} holds no open merge of ${merge.commit}.`,
    };
  if (operations.length > NO_ENTRIES)
    return {
      code: TurnViolation.GitInProgress,
      detail: `Checkout ${checkout.name} has a git operation in progress: ${operations.join(", ")}.`,
    };
  return null;
}

async function violate(
  state: StepsState,
  before: readonly string[],
  violation: Violation,
  context: Context,
): Promise<never> {
  for (const [index, checkout] of state.checkouts.entries())
    await restoreCheckout(
      state.input.env,
      checkout,
      state.nodeBranch,
      before[index]!,
      context,
      remainingOf(state),
    );
  return state.run.stop(
    EndReason.OperationFailed,
    violation.code,
    await state.run.reasonOf(new Error(violation.detail)),
  );
}

async function settleCheckout(
  state: StepsState,
  checkout: WorkspaceCheckout,
  before: string,
  turn: GateTurn,
  context: Context,
): Promise<boolean> {
  const env = state.input.env;
  const directory = checkout.directory;
  const remaining = remainingOf(state);
  if ((await headCommit(env, directory, context, remaining())) !== before)
    await softReset(env, directory, before, context, remaining());
  const merge = mergeOf(turn, checkout);
  let changed = true;
  if (merge === null)
    changed =
      (await commitWork(env, directory, turn.message, context, remaining())) !==
      null;
  else {
    await refuseMarkers(state, checkout, merge, context);
    await concludeMerge(env, directory, context, remaining());
  }
  checkout.head = await headCommit(env, directory, context, remaining());
  await assertInvariant(env, checkout, state.nodeBranch, context, remaining);
  return changed;
}

async function refuseMarkers(
  state: StepsState,
  checkout: WorkspaceCheckout,
  merge: ConflictMerge,
  context: Context,
): Promise<void> {
  const remaining = remainingOf(state);
  const left = await conflictMarkerFiles(
    state.input.env,
    checkout.directory,
    merge.files,
    context,
    remaining(),
  );
  if (left.length === NO_ENTRIES) return;
  await abortMerge(state.input.env, checkout.directory, context, remaining());
  state.run.stop(EndReason.OperationFailed, MERGE_MARKERS_LEFT);
}

export async function restoreCheckout(
  env: NodeJS.ProcessEnv,
  checkout: WorkspaceCheckout,
  branch: string,
  target: string,
  context: Context,
  remaining: () => number,
): Promise<void> {
  const directory = checkout.directory;
  await quitOperations(env, directory, context, remaining());
  await forceBranch(env, directory, branch, target, context, remaining());
  await discardChanges(env, directory, context, remaining());
  checkout.head = target;
  await assertInvariant(env, checkout, branch, context, remaining);
}

async function assertInvariant(
  env: NodeJS.ProcessEnv,
  checkout: WorkspaceCheckout,
  branch: string,
  context: Context,
  remaining: () => number,
): Promise<void> {
  const directory = checkout.directory;
  assert.equal(
    await symbolicHead(env, directory, context, remaining()),
    `refs/heads/${branch}`,
  );
  assert.equal(
    await headCommit(env, directory, context, remaining()),
    checkout.head,
  );
  assert.ok(await isClean(env, directory, context, remaining()));
  assert.deepEqual(operationsInProgress(directory), []);
}

export function removeRootEntries(state: StepsState): void {
  if (state.checkouts.length === SINGLE_CHECKOUT) return;
  const kept = new Set([SCRATCH_ENTRY]);
  for (const checkout of state.checkouts) {
    assert.equal(dirname(checkout.directory), state.root);
    kept.add(basename(checkout.directory));
  }
  const removed = readdirSync(state.root).filter((entry) => !kept.has(entry));
  for (const entry of removed)
    rmSync(join(state.root, entry), { recursive: true, force: true });
  if (removed.length > NO_ENTRIES)
    state.run.log("root entries removed", { entries: removed });
}

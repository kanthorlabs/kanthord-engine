import assert from "node:assert/strict";
import type { PromptTemplate } from "../../agent/contract.ts";
import { readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Context } from "../../kernel/context.ts";
import {
  commitMessage,
  commitTypeOf,
  isCommitMessage,
} from "../../kernel/commit-message.ts";
import type { TaskContent } from "../../mission/contract.ts";
import type { WorkPrompt } from "../../agent/prompt-composer.ts";
import {
  COLLECTION_MAX,
  SpanStatus,
  type Attributes,
} from "../../tracking/contract.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import { gitFailure } from "./method-telemetry.ts";
import type { NativeAgent } from "./native-agent.ts";
import {
  abortMerge,
  changedFiles,
  commitWork,
  concludeMerge,
  conflictMarkerFiles,
  containsCommit,
  discardChanges,
  forceBranch,
  headCommit,
  isCommitted,
  MERGE_HEAD,
  mergeHeadOf,
  operationsInProgress,
  quitOperations,
  softReset,
  symbolicHead,
} from "./local-git.ts";
import { MERGE_MARKERS_LEFT, TurnViolation } from "./stop-codes.ts";
import type { StepsState } from "./steps-implement.ts";
import { SpanOperation, type SpanEnd } from "./telemetry.ts";
import { SCRATCH_DIRECTORY, type WorkspaceCheckout } from "./workspace.ts";

export const GateMode = {
  Write: "write",
  Conflict: "conflict",
  Checkpoint: "checkpoint",
} as const;
export type GateMode = (typeof GateMode)[keyof typeof GateMode];
export { MERGE_MARKERS_LEFT, TurnViolation } from "./stop-codes.ts";
export const ViolationEnd = {
  Stop: "stop",
  Restore: "restore",
} as const;
export type ViolationEnd = (typeof ViolationEnd)[keyof typeof ViolationEnd];
const NO_ENTRIES = 0;
const NO_UNCHANGED_TURNS = 0;
const SINGLE_CHECKOUT = 1;
const SCRATCH_ENTRY = basename(SCRATCH_DIRECTORY);
const DETACHED = "a detached HEAD";
const MERGE_SUBJECT = "merge";
const GATE_MODE_ATTRIBUTE = "kanthord.gate.mode";
const GATE_CHANGED_ATTRIBUTE = "kanthord.gate.changed";
const GATE_VIOLATION_ATTRIBUTE = "kanthord.gate.violation";
const CHANGED_FILE_COUNT_ATTRIBUTE = "kanthord.git.changed_file_count";
const CHANGED_FILES_ATTRIBUTE = "kanthord.git.changed_files";
const CHANGED_FILES_MAX_BYTES = 16384;
const PATH_PREFIX_SEPARATOR = ":";

export interface ConflictMerge {
  directory: string;
  commit: string;
  files: readonly string[];
}
interface GateTurn {
  mode: GateMode;
  message: string;
  merge: ConflictMerge | null;
  violationEnd: ViolationEnd;
}
interface Violation {
  code: TurnViolation;
  detail: string;
}
export interface GatedAgent extends NativeAgent {
  changed(): boolean;
  commits(): ReadonlySet<string>;
}

export function unitCommitMessage(
  state: Pick<StepsState, "revision">,
  unit: TaskContent,
): string {
  return commitMessage(
    commitTypeOf(state.revision.content.commit_type),
    unit.content.name,
    unit.id,
  );
}

export function mergeCommitMessage(
  state: Pick<StepsState, "revision" | "input">,
  base: string,
): string {
  return commitMessage(
    commitTypeOf(state.revision.content.commit_type),
    `${MERGE_SUBJECT} ${base}`,
    state.input.claim.node_id,
  );
}

export function isTurnViolation(code: string | null): boolean {
  return Object.values<string | null>(TurnViolation).includes(code);
}

export function gatedAgent(
  state: StepsState,
  message: string,
  merge: ConflictMerge | null = null,
): GatedAgent {
  assert.ok(isCommitMessage(message));
  const agent = state.agent;
  const turn: GateTurn = {
    mode: merge === null ? GateMode.Write : GateMode.Conflict,
    message,
    merge,
    violationEnd: ViolationEnd.Stop,
  };
  let changed = false;
  const commits = new Set<string>();
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
    for (const [index, checkout] of state.checkouts.entries())
      if (checkout.head !== before[index]) commits.add(checkout.head);
    if (changed) state.unchangedTurns = NO_UNCHANGED_TURNS;
  };
  return {
    budget: agent.budget,
    prompt: (work: WorkPrompt) => gated(() => agent.prompt(work)),
    instruct: (work: WorkPrompt, text: string, template: PromptTemplate) =>
      gated(() => agent.instruct(work, text, template)),
    changed: () => changed,
    commits: () => commits,
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
  violationEnd: ViolationEnd,
): Promise<boolean> {
  assert.ok(isCommitMessage(message));
  return runGate(
    state,
    { mode: GateMode.Checkpoint, message, merge: null, violationEnd },
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
  let violated: TurnViolation | null = null;
  const changedPaths: string[] = [];
  return state.run.spans.within(
    {
      key: state.run.spans.key(SpanOperation.Gate),
      operation: SpanOperation.Gate,
      attributes: { [GATE_MODE_ATTRIBUTE]: turn.mode },
    },
    async () => {
      const remaining = remainingOf(state);
      if (turn.mode === GateMode.Checkpoint)
        for (const checkout of state.checkouts)
          if (
            (await mergeHeadOf(
              state.input.env,
              checkout.directory,
              context,
              remaining(),
            )) !== null
          )
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
        if (violation === null) continue;
        violated = violation.code;
        const detail = await violate(state, before, violation, context);
        if (turn.violationEnd === ViolationEnd.Restore) return false;
        state.run.stop(EndReason.OperationFailed, violation.code, detail);
      }
      let changed = false;
      for (const [index, checkout] of state.checkouts.entries()) {
        if (
          await settleCheckout(state, checkout, before[index]!, turn, context)
        )
          changed = true;
        changedPaths.push(
          ...(await changedPathsOf(state, checkout, before[index]!, context)),
        );
      }
      removeRootEntries(state);
      return changed;
    },
    (changed) => ({
      status: SpanStatus.Ok,
      attributes: {
        [GATE_CHANGED_ATTRIBUTE]: changed,
        [CHANGED_FILE_COUNT_ATTRIBUTE]: changedPaths.length,
        [CHANGED_FILES_ATTRIBUTE]: boundedPaths(changedPaths),
        ...violationAttributes(violated),
      },
    }),
    (error) => gateFailure(violated)(error),
  );
}

async function changedPathsOf(
  state: StepsState,
  checkout: WorkspaceCheckout,
  before: string,
  context: Context,
): Promise<string[]> {
  if (checkout.head === before) return [];
  const paths = await changedFiles(
    state.input.env,
    checkout.directory,
    before,
    checkout.head,
    context,
    remainingOf(state)(),
  );
  if (state.checkouts.length === SINGLE_CHECKOUT) return paths;
  return paths.map((path) => `${checkout.name}${PATH_PREFIX_SEPARATOR}${path}`);
}

function boundedPaths(paths: readonly string[]): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    bytes += Buffer.byteLength(path);
    if (kept.length >= COLLECTION_MAX || bytes > CHANGED_FILES_MAX_BYTES) break;
    kept.push(path);
  }
  return kept;
}

function violationAttributes(violation: TurnViolation | null): Attributes {
  return violation === null ? {} : { [GATE_VIOLATION_ATTRIBUTE]: violation };
}

function gateFailure(
  violation: TurnViolation | null,
): (error: unknown) => SpanEnd {
  return (error) => {
    const attributes = violationAttributes(violation);
    if (error instanceof ExecutionStop)
      return { status: SpanStatus.Error, attributes };
    return { ...gitFailure(error), attributes };
  };
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
  const operations = (
    await operationsInProgress(env, directory, context, remaining())
  ).filter((operation) => merge === null || operation !== MERGE_HEAD);
  if (
    merge !== null &&
    (await mergeHeadOf(env, directory, context, remaining())) !== merge.commit
  )
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
): Promise<string | null> {
  for (const [index, checkout] of state.checkouts.entries())
    await restoreCheckout(
      state.input.env,
      checkout,
      state.nodeBranch,
      before[index]!,
      context,
      remainingOf(state),
    );
  const detail = await state.run.reasonOf(new Error(violation.detail));
  state.run.log("turn violation", { code: violation.code, detail });
  return detail;
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
    await concludeMerge(env, directory, turn.message, context, remaining());
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
  assert.ok(await isCommitted(env, directory, context, remaining()));
  assert.deepEqual(
    await operationsInProgress(env, directory, context, remaining()),
    [],
  );
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

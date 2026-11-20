import assert from "node:assert/strict";
import type { PromptTemplate } from "../../agent/contract.ts";
import { perCheckout } from "./per-checkout.ts";
import { readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Context } from "../../kernel/context.ts";
import { REASON_MAX_LENGTH } from "../../kernel/probe.ts";
import {
  commitMessage,
  commitTypeOf,
  isCommitMessage,
} from "../../kernel/commit-message.ts";
import type { TaskContent } from "../../mission/contract.ts";
import type { WorkPrompt } from "../../agent/prompt-composer.ts";
import {
  type Attributes,
  COLLECTION_MAX,
  SpanStatus,
} from "../../tracking/contract.ts";
import { EndReason, ExecutionStop } from "./execution-stop.ts";
import { CodedError } from "../../kernel/errors.ts";
import type { NativeAgent } from "./native-agent-session.ts";
import {
  abortMerge,
  commitStaged,
  concludeMerge,
  conflictMarkerFiles,
  containsCommit,
  discardChanges,
  forceBranch,
  type GitCall,
  type GitOperation,
  type GitPaths,
  GitProcessCount,
  type GitStatus,
  HEAD_OUTSIDE_BRANCHES,
  livePaths,
  MERGE_HEAD,
  mergeCommitsSince,
  mergeHeadAt,
  operationsOf,
  quitOperations,
  readStatus,
  softReset,
  stageWork,
  symbolicHead,
  unmergedPaths,
} from "./local-git.ts";
import { MERGE_MARKERS_LEFT, TurnViolation } from "./stop-codes.ts";
import type { StepsState } from "./steps-implement.ts";
import { type SpanEnd, SpanOperation } from "./telemetry.ts";
import { type NodeCheckout, SCRATCH_DIRECTORY } from "./workspace-layout.ts";

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
export const NO_UNCHANGED_TURNS = 0;
const SINGLE_CHECKOUT = 1;
const SCRATCH_ENTRY = basename(SCRATCH_DIRECTORY);
const DETACHED = "a detached HEAD";
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const ORDINARY_ENTRY = "1";
const RENAMED_ENTRY = "2";
const UNCHANGED_INDEX = ".";
const MERGE_SUBJECT = "merge";
const GATE_MODE_ATTRIBUTE = "kanthord.gate.mode";
const GATE_CHANGED_ATTRIBUTE = "kanthord.gate.changed";
const GATE_VIOLATION_ATTRIBUTE = "kanthord.gate.violation";
const CHANGED_FILE_COUNT_ATTRIBUTE = "kanthord.git.changed_file_count";
const CHANGED_FILES_ATTRIBUTE = "kanthord.git.changed_files";
const PROCESS_COUNT_ATTRIBUTE = "kanthord.git.process_count";
const ERROR_TYPE_ATTRIBUTE = "error.type";
const CHANGED_FILES_MAX_BYTES = 16384;
const PATH_PREFIX_SEPARATOR = ":";

export interface ConflictMerge {
  directory: string;
  commit: string;
  files: readonly string[];
  markerless: readonly string[];
  message: string;
}
export interface OpenMerge extends ConflictMerge {
  resolved: boolean;
}
export interface CheckpointTurn {
  message: string;
  merge: ConflictMerge | null;
  context: Context;
  violationEnd: ViolationEnd;
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
interface Inspection {
  violation: Violation | null;
  status: GitStatus;
}
interface Settled {
  changed: boolean;
  paths: string[];
}
export interface CheckoutFacts {
  status: GitStatus;
  operations: readonly GitOperation[];
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
    const context = agent.budget.cleanupContext(state.cancel);
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
    completeReply: () => agent.completeReply(),
    abort: () => agent.abort(),
    closeTrace: (status) => agent.closeTrace(status),
    close: () => agent.close(),
  };
}

export async function checkpointGate(
  state: StepsState,
  turn: CheckpointTurn,
): Promise<boolean> {
  assert.ok(isCommitMessage(turn.message));
  return runGate(
    state,
    {
      mode: GateMode.Checkpoint,
      message: turn.message,
      merge: turn.merge,
      violationEnd: turn.violationEnd,
    },
    state.checkouts.map((checkout) => checkout.head),
    turn.context,
  );
}

function gateMerges(
  state: StepsState,
  turn: GateTurn,
  context: Context,
): Promise<(ConflictMerge | null)[]> {
  if (turn.mode !== GateMode.Checkpoint)
    return Promise.resolve(
      state.checkouts.map((checkout) => mergeOf(turn, checkout)),
    );
  return perCheckout(state.checkouts, (checkout) =>
    keptMerge(state, checkout, { merge: mergeOf(turn, checkout), context }),
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
  const processes = new GitProcessCount();
  return state.ports.telemetry.within(
    {
      key: state.ports.telemetry.key(SpanOperation.Gate),
      operation: SpanOperation.Gate,
      attributes: { [GATE_MODE_ATTRIBUTE]: turn.mode },
    },
    () =>
      processes.within(async () => {
        const merges = await gateMerges(state, turn, context);
        const inspections = await perCheckout(
          state.checkouts,
          (checkout, index) =>
            inspect(state, checkout, before[index]!, {
              merge: merges[index]!,
              context,
            }),
        );
        const violation =
          inspections.find((inspection) => inspection.violation !== null)
            ?.violation ?? null;
        if (violation !== null) {
          violated = violation.code;
          const detail = await violate(state, before, violation, context);
          if (turn.violationEnd === ViolationEnd.Restore) return false;
          throw new ExecutionStop(EndReason.OperationFailed, violation.code, {
            detail,
          });
        }
        const settled = await perCheckout(state.checkouts, (checkout, index) =>
          settleCheckout(state, checkout, {
            before: before[index]!,
            status: inspections[index]!.status,
            turn,
            merge: merges[index]!,
            context,
          }),
        );
        for (const [index, checkout] of state.checkouts.entries())
          changedPaths.push(
            ...prefixedPaths(state, checkout, settled[index]!.paths),
          );
        const changed = settled.some((entry) => entry.changed);
        removeRootEntries(state);
        return changed;
      }),
    (changed) => ({
      status: SpanStatus.Ok,
      attributes: {
        [GATE_CHANGED_ATTRIBUTE]: changed,
        [CHANGED_FILE_COUNT_ATTRIBUTE]: changedPaths.length,
        [CHANGED_FILES_ATTRIBUTE]: boundedPaths(changedPaths),
        [PROCESS_COUNT_ATTRIBUTE]: processes.count,
        ...violationAttributes(violated),
      },
    }),
    (error) => gateFailure(violated, processes)(error),
  );
}

function prefixedPaths(
  state: StepsState,
  checkout: NodeCheckout,
  paths: readonly string[],
): string[] {
  if (state.checkouts.length === SINGLE_CHECKOUT) return [...paths];
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
  processes: GitProcessCount,
): (error: unknown) => SpanEnd {
  return (error) => ({
    status: SpanStatus.Error,
    attributes: {
      [PROCESS_COUNT_ATTRIBUTE]: processes.count,
      ...violationAttributes(violation),
      ...errorTypeAttributes(error),
    },
  });
}

function errorTypeAttributes(error: unknown): Attributes {
  return error instanceof CodedError
    ? { [ERROR_TYPE_ATTRIBUTE]: error.code }
    : {};
}

function mergeOf(turn: GateTurn, checkout: NodeCheckout): ConflictMerge | null {
  return turn.merge?.directory === checkout.directory ? turn.merge : null;
}

function remainingOf(state: StepsState): () => number {
  return () => state.input.claim.expired_at - Date.now();
}

function callOf(
  state: StepsState,
  checkout: NodeCheckout,
  context: Context,
): GitCall {
  return {
    env: state.input.env,
    directory: checkout.directory,
    context,
    deadlineMs: remainingOf(state)(),
  };
}

interface InspectOptions {
  merge: ConflictMerge | null;
  context: Context;
}

async function inspect(
  state: StepsState,
  checkout: NodeCheckout,
  before: string,
  options: InspectOptions,
): Promise<Inspection> {
  const call = () => callOf(state, checkout, options.context);
  const status = await readStatus(call());
  if (status.branch !== state.nodeBranch)
    return {
      violation: {
        code: TurnViolation.BranchChanged,
        detail: `The HEAD of checkout ${checkout.name} is ${await headRefOf(status, call)}, not refs/heads/${state.nodeBranch}.`,
      },
      status,
    };
  const history =
    status.head === before
      ? null
      : await historyViolation(state, checkout, before, options);
  return {
    violation:
      history ??
      operationViolation(
        checkout,
        options.merge,
        await livePaths(call(), checkout.gitPaths),
      ),
    status,
  };
}

async function headRefOf(
  status: GitStatus,
  call: () => GitCall,
): Promise<string> {
  if (status.branch === null) return DETACHED;
  if (status.branch !== HEAD_OUTSIDE_BRANCHES)
    return `refs/heads/${status.branch}`;
  return (await symbolicHead(call())) ?? DETACHED;
}

async function historyViolation(
  state: StepsState,
  checkout: NodeCheckout,
  before: string,
  options: InspectOptions,
): Promise<Violation | null> {
  const env = state.input.env;
  const directory = checkout.directory;
  const { merge, context } = options;
  const remaining = remainingOf(state);
  if (!(await containsCommit(env, directory, before, context, remaining())))
    return {
      code: TurnViolation.HistoryRewritten,
      detail: `The HEAD of checkout ${checkout.name} does not contain ${before}.`,
    };
  const foreign = (
    await mergeCommitsSince(env, directory, before, context, remaining())
  ).find(
    ({ parents }) =>
      merge === null ||
      parents.some((parent) => parent !== before && parent !== merge.commit),
  );
  if (foreign === undefined) return null;
  return {
    code: TurnViolation.ForeignMerge,
    detail: `Checkout ${checkout.name} holds merge commit ${foreign.commit}. A turn merges no branch; the worker merges the base itself.`,
  };
}

function operationViolation(
  checkout: NodeCheckout,
  merge: ConflictMerge | null,
  paths: GitPaths,
): Violation | null {
  const operations = operationsOf(paths).filter(
    (operation) => merge === null || operation !== MERGE_HEAD,
  );
  if (merge !== null && mergeHeadAt(paths) !== merge.commit)
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

async function keptMerge(
  state: StepsState,
  checkout: NodeCheckout,
  options: InspectOptions,
): Promise<ConflictMerge | null> {
  const { merge, context } = options;
  const paths = await livePaths(
    callOf(state, checkout, context),
    checkout.gitPaths,
  );
  if (!operationsOf(paths).includes(MERGE_HEAD)) return null;
  if (merge !== null && mergeHeadAt(paths) === merge.commit) return merge;
  await abortMerge(
    state.input.env,
    checkout.directory,
    context,
    remainingOf(state)(),
  );
  return null;
}

async function violate(
  state: StepsState,
  before: readonly string[],
  violation: Violation,
  context: Context,
): Promise<string | null> {
  await perCheckout(state.checkouts, (checkout, index) =>
    restoreCheckout(
      state.input.env,
      checkout,
      state.nodeBranch,
      before[index]!,
      context,
      remainingOf(state),
    ),
  );
  const detail = await state.ports.secrets.redact(
    String(new Error(violation.detail)),
    REASON_MAX_LENGTH,
  );
  state.ports.log.log("turn violation", { code: violation.code, detail });
  return detail;
}

interface SettleInput {
  before: string;
  status: GitStatus;
  turn: GateTurn;
  merge: ConflictMerge | null;
  context: Context;
}

async function settleCheckout(
  state: StepsState,
  checkout: NodeCheckout,
  input: SettleInput,
): Promise<Settled> {
  const { before, status, merge, context } = input;
  if (
    merge === null &&
    status.head === before &&
    status.entries.length === NO_ENTRIES
  )
    return { changed: false, paths: [] };
  if (status.head !== before)
    await softReset(
      state.input.env,
      checkout.directory,
      before,
      context,
      remainingOf(state)(),
    );
  const settled =
    merge === null
      ? await commitTurn(state, checkout, input)
      : await concludeConflict(state, checkout, { merge, input });
  const after = await readStatus(callOf(state, checkout, context));
  checkout.head = after.head;
  assertInvariant(
    {
      status: after,
      operations: operationsOf(
        await livePaths(callOf(state, checkout, context), checkout.gitPaths),
      ),
    },
    state.nodeBranch,
    settled.changed ? after.head : before,
  );
  return settled;
}

async function commitTurn(
  state: StepsState,
  checkout: NodeCheckout,
  input: SettleInput,
): Promise<Settled> {
  const paths = await stageWork(callOf(state, checkout, input.context));
  if (paths.length === NO_ENTRIES) return { changed: false, paths };
  await commitStaged(
    callOf(state, checkout, input.context),
    input.turn.message,
  );
  return { changed: true, paths };
}

interface ConflictSettle {
  merge: ConflictMerge;
  input: SettleInput;
}

async function concludeConflict(
  state: StepsState,
  checkout: NodeCheckout,
  conflict: ConflictSettle,
): Promise<Settled> {
  const { context } = conflict.input;
  await refuseMarkers(state, checkout, conflict.merge, context);
  const paths = await concludeMerge(
    callOf(state, checkout, context),
    conflict.merge.message,
  );
  return { changed: true, paths };
}

async function refuseMarkers(
  state: StepsState,
  checkout: NodeCheckout,
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
  if (
    left.length === NO_ENTRIES &&
    (await unmergedMarkerless(state, checkout, { merge, context })).length ===
      NO_ENTRIES
  )
    return;
  await abortMerge(state.input.env, checkout.directory, context, remaining());
  throw new ExecutionStop(EndReason.OperationFailed, MERGE_MARKERS_LEFT);
}

interface MarkerlessCheck {
  merge: ConflictMerge;
  context: Context;
}

function unmergedMarkerless(
  state: StepsState,
  checkout: NodeCheckout,
  check: MarkerlessCheck,
): Promise<string[]> {
  if (check.merge.markerless.length === NO_ENTRIES) return Promise.resolve([]);
  return unmergedPaths(
    callOf(state, checkout, check.context),
    check.merge.markerless,
  );
}

export async function restoreCheckout(
  env: NodeJS.ProcessEnv,
  checkout: NodeCheckout,
  branch: string,
  target: string,
  context: Context,
  remaining: () => number,
): Promise<void> {
  const directory = checkout.directory;
  const call = (): GitCall => ({
    env,
    directory,
    context,
    deadlineMs: remaining(),
  });
  const paths = await livePaths(call(), checkout.gitPaths);
  await quitOperations(call(), paths);
  await forceBranch(env, directory, branch, target, context, remaining());
  await discardChanges(env, directory, context, remaining());
  checkout.head = target;
  assertInvariant(
    {
      status: await readStatus(call()),
      operations: operationsOf(paths),
    },
    branch,
    target,
  );
}

export function assertInvariant(
  facts: CheckoutFacts,
  branch: string,
  head: string,
): void {
  assert.equal(facts.status.branch, branch);
  assert.match(facts.status.head, COMMIT_PATTERN);
  assert.equal(facts.status.head, head);
  assert.ok(
    facts.status.entries.every(
      ({ kind, index, gitlink }) =>
        (kind === ORDINARY_ENTRY || kind === RENAMED_ENTRY) &&
        (index === UNCHANGED_INDEX || gitlink),
    ),
  );
  assert.deepEqual(facts.operations, []);
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
    state.ports.log.log("root entries removed", { entries: removed });
}

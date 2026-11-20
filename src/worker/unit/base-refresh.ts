import { perCheckout } from "./per-checkout.ts";
import { relative } from "node:path";
import {
  type Context,
  ContextCancelled,
  DeadlineExceeded,
} from "../../kernel/context.ts";
import { PromptTemplate, type PromptTemplates } from "../../agent/contract.ts";
import { renderWorkPrompt } from "../../agent/prompt-composer.ts";
import { renderTemplate, templateUses } from "../../agent/prompt-templates.ts";
import {
  commitOf,
  conflictMarkerFiles,
  type GitCall,
  headCommit,
  isAncestor,
  mergeBase,
  mergeRef,
  nodeSideBodies,
  rangeFileDiff,
  rangeLog,
} from "./local-git.ts";
import { implementRepositoriesOf, type StepsState } from "./steps-implement.ts";
import { mergedBranchesOf } from "./setup-repository.ts";
import type { WorkspaceCheckout } from "./workspace-layout.ts";
import { type ImplementPorts, PortResultKind } from "./foundry-ports.ts";
import {
  ConflictEnd,
  conflictEnd,
  GitStep,
  withinGit,
} from "./method-telemetry.ts";
import { ExecutionStop, portStop } from "./execution-stop.ts";
import { MERGE_MARKERS_LEFT } from "./stop-codes.ts";
import { SpanOperation } from "./telemetry.ts";
import {
  type ConflictMerge,
  gatedAgent,
  mergeCommitMessage,
} from "./turn-gate.ts";

const NO_FILES = 0;

export const RefreshResult = {
  Current: "current",
  Merged: "merged",
  BudgetEnd: "budget_end",
} as const;
export type RefreshResult = (typeof RefreshResult)[keyof typeof RefreshResult];

export const BASE_CHANGES = "base_changes";
export const BASE_CHANGES_MAX_BYTES = 16384;
export const BASE_CHANGES_CUT = `The base-side changes stop here because they are larger than ${BASE_CHANGES_MAX_BYTES} bytes.`;
const BASE_COMMITS_HEADING = "Base commits since the merge base:";
const BASE_DIFF_HEADING = "Base diff since the merge base:";
const FILE_HEADING = "## ";
const LINE_END = "\n";
const LINE_END_BYTES = 1;
const NO_BYTES = 0;
const NO_TEXT = "";

export interface ConflictPrompt {
  binding: string;
  directory: string;
  base_branch: string;
  base_changes?: string;
}

export function conflictInstruction(
  templates: PromptTemplates,
  conflict: ConflictPrompt,
  files: readonly string[],
): string {
  return renderTemplate(templates, PromptTemplate.Conflict, {
    ...conflict,
    files: files.join(", "),
  });
}

export function nodeWork(state: StepsState) {
  return renderWorkPrompt(state.input.setup.templates, {
    node_id: state.input.claim.node_id,
    revision: state.input.claim.pinned_revision,
    content: state.revision.content,
    repositories: implementRepositoriesOf(state),
    affected_tests: state.affectedTests,
    tasks: state.revision.tasks,
  });
}

export async function refreshAtClaim(
  state: StepsState,
): Promise<RefreshResult> {
  let result: RefreshResult = RefreshResult.Current;
  for (const checkout of state.checkouts) {
    const merged = await mergeAtClaim(state, checkout);
    if (merged === RefreshResult.BudgetEnd) return merged;
    if (merged === RefreshResult.Merged) result = merged;
  }
  return result;
}

async function mergeAtClaim(
  state: StepsState,
  checkout: WorkspaceCheckout,
): Promise<RefreshResult> {
  const context = state.agent.budget.cleanupContext(state.cancel);
  try {
    let result: RefreshResult = RefreshResult.Current;
    for (const branch of mergedBranchesOf(state, checkout)) {
      const merged = await mergeUnder(state, checkout, branch, context);
      if (merged === RefreshResult.BudgetEnd) return merged;
      if (merged === RefreshResult.Merged) result = merged;
    }
    return result;
  } finally {
    context.cancel();
  }
}

async function mergeUnder(
  state: StepsState,
  checkout: WorkspaceCheckout,
  base: string,
  context: Context,
): Promise<RefreshResult> {
  const env = state.input.env;
  const directory = checkout.directory;
  const remaining = () => state.input.claim.expired_at - Date.now();
  const ref = `origin/${base}`;
  if (await isAncestor(env, directory, ref, context, remaining()))
    return RefreshResult.Current;
  const commit = await commitOf(env, directory, ref, context, remaining());
  const message = mergeCommitMessage(state, base);
  const conflicts = await withinGit(
    state.ports.telemetry,
    GitStep.MergeBase,
    () => mergeRef(env, directory, ref, message, context, remaining()),
  );
  if (conflicts.length > NO_FILES) {
    const marked = await conflictMarkerFiles(
      env,
      directory,
      conflicts,
      context,
      remaining(),
    );
    const merge: ConflictMerge = {
      directory,
      commit,
      files: conflicts,
      markerless: conflicts.filter((file) => !marked.includes(file)),
      message,
    };
    if (await conflictTurn(state, { checkout, base, merge, context })) {
      const left = await markersLeft(state, merge, context);
      state.openMerge = {
        ...merge,
        resolved:
          merge.markerless.length === NO_FILES && left.length === NO_FILES,
      };
      return RefreshResult.BudgetEnd;
    }
  } else checkout.head = await headCommit(env, directory, context, remaining());
  state.ports.log.log("base merged", {
    binding: checkout.name,
    base_branch: base,
    commit: checkout.head,
    conflicts: conflicts.length,
  });
  return RefreshResult.Merged;
}

interface ConflictTurn {
  checkout: WorkspaceCheckout;
  base: string;
  merge: ConflictMerge;
  context: Context;
}

async function conflictTurn(
  state: StepsState,
  turn: ConflictTurn,
): Promise<boolean> {
  const { checkout, base, merge } = turn;
  await noteConflictOwners(state, turn);
  const templates = state.input.setup.templates;
  const prompt: ConflictPrompt = {
    binding: checkout.name,
    directory: relative(state.root, merge.directory) || ".",
    base_branch: base,
  };
  const instruction = conflictInstruction(
    templates,
    templateUses(templates[PromptTemplate.Conflict], BASE_CHANGES)
      ? {
          ...prompt,
          base_changes: await withinGit(
            state.ports.telemetry,
            GitStep.MergeBase,
            () => baseChanges(state, turn),
          ),
        }
      : prompt,
    merge.files,
  );
  return measuredConflict(state, merge.files.length, () =>
    gatedAgent(state, merge.message, merge).instruct(
      nodeWork(state),
      instruction,
      PromptTemplate.Conflict,
    ),
  );
}

interface KeptLines {
  lines: string[];
  bytes: number;
}

async function baseChanges(
  state: StepsState,
  turn: ConflictTurn,
): Promise<string> {
  const { merge, context } = turn;
  const call = (): GitCall => ({
    env: state.input.env,
    directory: merge.directory,
    context,
    deadlineMs: state.input.claim.expired_at - Date.now(),
  });
  const from = await mergeBase(
    state.input.env,
    merge.directory,
    "HEAD",
    merge.commit,
    context,
    call().deadlineMs,
  );
  const kept: KeptLines = { lines: [], bytes: NO_BYTES };
  for (const file of merge.files) {
    const range = { from, to: merge.commit, file };
    const section = [
      `${FILE_HEADING}${file}`,
      BASE_COMMITS_HEADING,
      ...linesOf(await rangeLog(call(), range)),
      BASE_DIFF_HEADING,
      ...linesOf(await rangeFileDiff(call(), range)),
    ];
    if (!keepWithinLimit(kept, section))
      return [...kept.lines, BASE_CHANGES_CUT].join(LINE_END);
  }
  return kept.lines.join(LINE_END);
}

function linesOf(output: string): string[] {
  const text = output.trimEnd();
  return text === NO_TEXT ? [] : text.split(LINE_END);
}

function keepWithinLimit(kept: KeptLines, lines: readonly string[]): boolean {
  const cutBytes = Buffer.byteLength(BASE_CHANGES_CUT);
  for (const line of lines) {
    const bytes = Buffer.byteLength(line) + LINE_END_BYTES;
    if (kept.bytes + bytes + cutBytes > BASE_CHANGES_MAX_BYTES) return false;
    kept.lines.push(line);
    kept.bytes += bytes;
  }
  return true;
}

async function noteConflictOwners(
  state: StepsState,
  turn: ConflictTurn,
): Promise<void> {
  const owners = await touchedUnits(state, turn);
  const known = state.conflictOwners;
  state.conflictOwners =
    owners === null || known === null
      ? null
      : [...new Set([...(known ?? []), ...owners])];
}

async function touchedUnits(
  state: StepsState,
  turn: ConflictTurn,
): Promise<string[] | null> {
  const units = new Set([
    state.input.claim.node_id,
    ...state.revision.tasks.map((task) => task.id),
  ]);
  try {
    const bodies = await nodeSideBodies(
      {
        env: state.input.env,
        directory: turn.merge.directory,
        context: turn.context,
        deadlineMs: state.input.claim.expired_at - Date.now(),
      },
      { merged: turn.merge.commit, files: turn.merge.files },
    );
    return bodies.filter((body) => units.has(body));
  } catch (error) {
    if (cancelled(turn.context, error)) throw error;
    return null;
  }
}

function cancelled(context: Context, error: unknown): boolean {
  return (
    context.signal.aborted ||
    error instanceof ContextCancelled ||
    error instanceof DeadlineExceeded
  );
}

async function measuredConflict(
  state: StepsState,
  fileCount: number,
  turn: () => Promise<void>,
): Promise<boolean> {
  const spans = state.ports.telemetry;
  const budget = state.agent.budget;
  const spanId = spans.start({
    key: spans.key(SpanOperation.Conflict),
    operation: SpanOperation.Conflict,
  });
  const before = budget.endedTurnCount();
  const record = (end: ConflictEnd) =>
    spans.end(
      spanId,
      conflictEnd({
        end,
        fileCount,
        modelTurns: budget.endedTurnCount() - before,
      }),
    );
  try {
    await turn();
  } catch (error) {
    record(failedConflictEnd(state, error));
    throw error;
  }
  const exhausted = budget.exhausted();
  record(exhausted ? ConflictEnd.BudgetEnd : ConflictEnd.Resolved);
  return exhausted;
}

function failedConflictEnd(state: StepsState, error: unknown): ConflictEnd {
  if (error instanceof ExecutionStop)
    return error.code === MERGE_MARKERS_LEFT
      ? ConflictEnd.MarkersLeft
      : ConflictEnd.Stop;
  return state.agent.budget.exhausted()
    ? ConflictEnd.BudgetEnd
    : ConflictEnd.Stop;
}

function markersLeft(
  state: StepsState,
  merge: ConflictMerge,
  context: Context,
): Promise<string[]> {
  return conflictMarkerFiles(
    state.input.env,
    merge.directory,
    merge.files,
    context,
    state.input.claim.expired_at - Date.now(),
  );
}

export async function fetchAtRelease(
  state: StepsState,
  ports: ImplementPorts,
): Promise<void> {
  const context = state.agent.budget.cleanupContext(state.cancel);
  try {
    await perCheckout(state.checkouts, async (checkout) => {
      const fetched = await ports.repository.fetchBase(checkout, {
        context,
        deadline: state.input.claim.expired_at,
      });
      if (fetched.kind === PortResultKind.Failed) throw portStop(fetched);
    });
  } finally {
    context.cancel();
  }
}

export async function refreshAtRelease(
  state: StepsState,
  ports: ImplementPorts,
): Promise<RefreshResult> {
  await fetchAtRelease(state, ports);
  return refreshAtClaim(state);
}

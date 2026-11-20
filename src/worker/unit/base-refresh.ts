import { perCheckout } from "./per-checkout.ts";
import { relative } from "node:path";
import type { Context } from "../../kernel/context.ts";
import { PromptTemplate, type PromptTemplates } from "../../agent/contract.ts";
import { renderWorkPrompt } from "../../agent/prompt-composer.ts";
import { renderTemplate } from "../../agent/prompt-templates.ts";
import {
  commitOf,
  conflictMarkerFiles,
  headCommit,
  isAncestor,
  mergeRef,
  nodeSideBodies,
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

export function conflictInstruction(
  templates: PromptTemplates,
  conflict: { binding: string; directory: string; base_branch: string },
  files: readonly string[],
): string {
  return renderTemplate(templates, PromptTemplate.Conflict, {
    binding: conflict.binding,
    directory: conflict.directory,
    base_branch: conflict.base_branch,
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
      message,
    };
    await conflictTurn(state, { checkout, base, merge, context });
    if (state.agent.budget.exhausted()) {
      const left = await markersLeft(state, merge, context);
      const everyMarked = conflicts.every((file) => marked.includes(file));
      state.openMerge = {
        ...merge,
        resolved: everyMarked && left.length === NO_FILES,
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
): Promise<void> {
  const { checkout, base, merge } = turn;
  await noteConflictOwners(state, turn);
  const instruction = conflictInstruction(
    state.input.setup.templates,
    {
      binding: checkout.name,
      directory: relative(state.root, merge.directory) || ".",
      base_branch: base,
    },
    merge.files,
  );
  await measuredConflict(state, merge.files.length, () =>
    gatedAgent(state, merge.message, merge).instruct(
      nodeWork(state),
      instruction,
      PromptTemplate.Conflict,
    ),
  );
}

async function noteConflictOwners(
  state: StepsState,
  turn: ConflictTurn,
): Promise<void> {
  const bodies = await nodeSideBodies(
    {
      env: state.input.env,
      directory: turn.merge.directory,
      context: turn.context,
      deadlineMs: state.input.claim.expired_at - Date.now(),
    },
    { merged: turn.merge.commit, files: turn.merge.files },
  );
  state.conflictOwners = [
    ...new Set([...(state.conflictOwners ?? []), ...bodies]),
  ];
}

async function measuredConflict(
  state: StepsState,
  fileCount: number,
  turn: () => Promise<void>,
): Promise<void> {
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
  record(budget.exhausted() ? ConflictEnd.BudgetEnd : ConflictEnd.Resolved);
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

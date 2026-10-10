import { renderWorkPrompt } from "../agent/prompt-composer.ts";
import { EndReason } from "./execution-run.ts";
import {
  abortMerge,
  concludeMerge,
  conflictMarkerFiles,
  headCommit,
  isAncestor,
  mergeRef,
  resetTo,
} from "./local-git.ts";
import type { StepsState } from "./steps-objective.ts";

const NO_FILES = 0;

export const RefreshResult = {
  Current: "current",
  Merged: "merged",
  BudgetEnd: "budget_end",
} as const;
export type RefreshResult = (typeof RefreshResult)[keyof typeof RefreshResult];

function baseBranchOf(state: StepsState): string {
  return state.input.setup.repositories[0]!.strategy.base_branch;
}

export function conflictInstruction(
  baseBranch: string,
  files: readonly string[],
): string {
  return `The merge of origin/${baseBranch} into the node branch conflicts. Resolve every conflict in these files so that the base branch change and the node work both stay intact: ${files.join(", ")}. Remove every conflict marker. Do not commit and do not abort the merge.`;
}

function nodeWork(state: StepsState) {
  return renderWorkPrompt({
    node_id: state.input.claim.node_id,
    revision: state.input.claim.pinned_revision,
    content: state.revision.content,
  });
}

export async function refreshAtClaim(
  state: StepsState,
): Promise<RefreshResult> {
  const budget = state.agent.budget;
  const context = state.run.operationContext;
  const base = baseBranchOf(state);
  const ref = `origin/${base}`;
  if (await isAncestor(state.directory, ref, context, budget.remainingMs()))
    return RefreshResult.Current;
  const conflicts = await mergeRef(
    state.directory,
    ref,
    context,
    budget.remainingMs(),
  );
  if (conflicts.length > NO_FILES) {
    await state.agent.instruct(
      nodeWork(state),
      conflictInstruction(base, conflicts),
    );
    if (budget.exhausted()) {
      await abortMerge(state.directory, context, budget.remainingMs());
      return RefreshResult.BudgetEnd;
    }
    const left = await conflictMarkerFiles(
      state.directory,
      conflicts,
      context,
      budget.remainingMs(),
    );
    if (left.length > NO_FILES) {
      await abortMerge(state.directory, context, budget.remainingMs());
      state.run.stop(EndReason.OperationFailed);
    }
    await concludeMerge(state.directory, context, budget.remainingMs());
  }
  state.head = await headCommit(state.directory, context, budget.remainingMs());
  state.run.log("base merged", {
    base_branch: base,
    commit: state.head,
    conflicts: conflicts.length,
  });
  return RefreshResult.Merged;
}

export async function refreshBeforeRelease(
  state: StepsState,
  verifyAll: () => Promise<boolean>,
): Promise<boolean> {
  const budget = state.agent.budget;
  const context = state.run.cleanupContext();
  const remaining = () => state.input.claim.expired_at - Date.now();
  try {
    const base = baseBranchOf(state);
    await state.input.transport.fetchBase(
      state.directory,
      base,
      context,
      remaining(),
    );
    const ref = `origin/${base}`;
    if (await isAncestor(state.directory, ref, context, remaining()))
      return true;
    const before = state.head;
    const conflicts = await mergeRef(
      state.directory,
      ref,
      context,
      remaining(),
    );
    if (conflicts.length > NO_FILES) {
      await abortMerge(state.directory, context, remaining());
      return false;
    }
    state.head = await headCommit(state.directory, context, remaining());
    if (!budget.exhausted() && (await verifyAll())) {
      state.run.log("base merged", {
        base_branch: base,
        commit: state.head,
        conflicts: NO_FILES,
      });
      return true;
    }
    await resetTo(state.directory, before, context, remaining());
    state.head = before;
    return false;
  } finally {
    context.cancel();
  }
}

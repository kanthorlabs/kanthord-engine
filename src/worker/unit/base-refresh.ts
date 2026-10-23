import { relative } from "node:path";
import type { Context } from "../../kernel/context.ts";
import { PromptTemplate, type PromptTemplates } from "../../agent/contract.ts";
import { renderWorkPrompt } from "../../agent/prompt-composer.ts";
import { renderTemplate } from "../../agent/prompt-templates.ts";
import {
  abortMerge,
  commitOf,
  headCommit,
  isAncestor,
  mergeRef,
  resetTo,
  taskCommitMessage,
} from "./local-git.ts";
import {
  repositoryOf,
  implementRepositoriesOf,
  type StepsState,
} from "./steps-implement.ts";
import { sshAccessOf, type WorkspaceCheckout } from "./workspace.ts";
import { GitStep, withinGit } from "./method-telemetry.ts";
import { gatedAgent } from "./turn-gate.ts";

const NO_FILES = 0;
const NO_MERGES = 0;

export const RefreshResult = {
  Current: "current",
  Merged: "merged",
  BudgetEnd: "budget_end",
} as const;
export type RefreshResult = (typeof RefreshResult)[keyof typeof RefreshResult];

function baseBranchOf(
  state: Pick<StepsState, "input">,
  checkout: WorkspaceCheckout,
): string {
  return repositoryOf(state, checkout).strategy.base_branch;
}

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
  const context = state.agent.budget.cleanupContext(state.run.operationContext);
  try {
    return await mergeUnder(state, checkout, context);
  } finally {
    context.cancel();
  }
}

async function mergeUnder(
  state: StepsState,
  checkout: WorkspaceCheckout,
  context: Context,
): Promise<RefreshResult> {
  const env = state.input.env;
  const directory = checkout.directory;
  const remaining = () => state.input.claim.expired_at - Date.now();
  const base = baseBranchOf(state, checkout);
  const ref = `origin/${base}`;
  if (await isAncestor(env, directory, ref, context, remaining()))
    return RefreshResult.Current;
  const commit = await commitOf(env, directory, ref, context, remaining());
  const conflicts = await mergeRef(env, directory, ref, context, remaining());
  if (conflicts.length > NO_FILES) {
    await gatedAgent(
      state,
      taskCommitMessage(state.input.claim.node_id, state.input.claim.attempt),
      { directory, commit, files: conflicts },
    ).instruct(
      nodeWork(state),
      conflictInstruction(
        state.input.setup.templates,
        {
          binding: checkout.name,
          directory: relative(state.root, directory) || ".",
          base_branch: base,
        },
        conflicts,
      ),
    );
    if (state.agent.budget.exhausted()) return RefreshResult.BudgetEnd;
  } else checkout.head = await headCommit(env, directory, context, remaining());
  state.run.log("base merged", {
    binding: checkout.name,
    base_branch: base,
    commit: checkout.head,
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
  const merged: { checkout: WorkspaceCheckout; before: string }[] = [];
  const reset = async () => {
    for (const { checkout, before } of merged) {
      await resetTo(
        state.input.env,
        checkout.directory,
        before,
        context,
        remaining(),
      );
      checkout.head = before;
    }
  };
  try {
    for (const checkout of state.checkouts) {
      const base = baseBranchOf(state, checkout);
      await withinGit(state.run.spans, GitStep.FetchBase, () =>
        state.input.transport.fetchBase(
          checkout.directory,
          base,
          context,
          remaining(),
          sshAccessOf(state.input.sshAccess, checkout.binding_id),
        ),
      );
      const ref = `origin/${base}`;
      if (
        await isAncestor(
          state.input.env,
          checkout.directory,
          ref,
          context,
          remaining(),
        )
      )
        continue;
      const before = checkout.head;
      const conflicts = await withinGit(
        state.run.spans,
        GitStep.MergeBase,
        () =>
          mergeRef(
            state.input.env,
            checkout.directory,
            ref,
            context,
            remaining(),
          ),
      );
      if (conflicts.length > NO_FILES) {
        await abortMerge(
          state.input.env,
          checkout.directory,
          context,
          remaining(),
        );
        await reset();
        return false;
      }
      merged.push({ checkout, before });
      checkout.head = await headCommit(
        state.input.env,
        checkout.directory,
        context,
        remaining(),
      );
    }
    if (merged.length === NO_MERGES) return true;
    if (!budget.exhausted() && (await verifyAll())) {
      for (const { checkout } of merged)
        state.run.log("base merged", {
          binding: checkout.name,
          base_branch: baseBranchOf(state, checkout),
          commit: checkout.head,
          conflicts: NO_FILES,
        });
      return true;
    }
    await reset();
    return false;
  } finally {
    context.cancel();
  }
}

import { relative } from "node:path";
import type { Context } from "../../kernel/context.ts";
import { PromptTemplate, type PromptTemplates } from "../../agent/contract.ts";
import { renderWorkPrompt } from "../../agent/prompt-composer.ts";
import { renderTemplate } from "../../agent/prompt-templates.ts";
import {
  commitOf,
  headCommit,
  isAncestor,
  mergeRef,
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

export async function refreshAtRelease(
  state: StepsState,
): Promise<RefreshResult> {
  const context = state.agent.budget.cleanupContext(state.run.operationContext);
  const remaining = () => state.input.claim.expired_at - Date.now();
  try {
    for (const checkout of state.checkouts)
      await withinGit(state.run.spans, GitStep.FetchBase, () =>
        state.input.transport.fetchBase(
          checkout.directory,
          baseBranchOf(state, checkout),
          context,
          remaining(),
          sshAccessOf(state.input.sshAccess, checkout.binding_id),
        ),
      );
  } finally {
    context.cancel();
  }
  return refreshAtClaim(state);
}

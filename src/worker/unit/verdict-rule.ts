import type { Context } from "../../kernel/context.ts";
import { containsCommit, hasCommit, hasWorkSince } from "./local-git.ts";
import type { JudgedCommit } from "./node-reads.ts";
import type { StepsState } from "./steps-implement.ts";
import type { WorkspaceCheckout } from "./workspace.ts";

export interface JudgedCheckout {
  checkout: WorkspaceCheckout;
  commit: string;
}

export async function judgedCheckouts(
  state: StepsState,
  judged: readonly JudgedCommit[],
): Promise<JudgedCheckout[]> {
  return withinCleanup(state, async (context, remaining) => {
    const found: JudgedCheckout[] = [];
    for (const checkout of state.checkouts) {
      const commit = judged.find(
        (entry) => entry.binding_id === checkout.binding_id,
      )?.commit;
      if (commit === undefined) continue;
      if (await onHistory(state, checkout, commit, context, remaining))
        found.push({ checkout, commit });
      else
        state.run.log("judged commit off the node history", {
          binding: checkout.name,
          commit,
        });
    }
    return found;
  });
}

async function onHistory(
  state: StepsState,
  checkout: WorkspaceCheckout,
  commit: string,
  context: Context,
  remaining: () => number,
): Promise<boolean> {
  const env = state.input.env;
  return (
    (await hasCommit(env, checkout.directory, commit, context, remaining())) &&
    (await containsCommit(
      env,
      checkout.directory,
      commit,
      context,
      remaining(),
    ))
  );
}

export async function verdictRuleHolds(
  state: StepsState,
  judged: readonly JudgedCheckout[],
): Promise<boolean> {
  return withinCleanup(state, async (context, remaining) => {
    for (const { checkout, commit } of judged)
      if (
        await hasWorkSince(
          state.input.env,
          checkout.directory,
          commit,
          context,
          remaining(),
        )
      )
        return true;
    return false;
  });
}

async function withinCleanup<T>(
  state: StepsState,
  work: (context: Context, remaining: () => number) => Promise<T>,
): Promise<T> {
  const context = state.agent.budget.cleanupContext(state.run.operationContext);
  try {
    return await work(context, () => state.input.claim.expired_at - Date.now());
  } finally {
    context.cancel();
  }
}

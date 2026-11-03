import { CancellationContext, type Context } from "../kernel/context.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import type { Store } from "../kernel/store.ts";
import {
  HANDOVER_HEAD_READ_MS,
  type MissionPromptPins,
  type PromptBase,
  type PromptCommits,
  type RepositoryBindingIdsOf,
} from "./contract.ts";

export interface PromptPinDependencies {
  store: Store;
  missionPromptPins: MissionPromptPins;
  promptBase?: PromptBase;
  repositoryBindingIdsOf: RepositoryBindingIdsOf;
}

export async function unpinnedPromptCommits(
  dependencies: PromptPinDependencies,
  execution: ExecutionClaim,
  deadline: number,
  context: Context,
): Promise<PromptCommits | null> {
  const { promptBase } = dependencies;
  const bindingIds = dependencies.store.transaction((tx) => {
    if (
      dependencies.missionPromptPins.attemptPromptCommits(
        tx,
        execution.nodeId,
        execution.attempt,
      ) !== null
    )
      return null;
    return (
      promptBase?.instructionBindingsOf(
        tx,
        dependencies.repositoryBindingIdsOf(
          tx,
          execution.nodeId,
          execution.pinnedRevision,
        ),
      ) ?? []
    );
  });
  if (bindingIds === null) return null;
  if (promptBase === undefined) return [];
  const read = new CancellationContext(
    context,
    Math.min(deadline, Date.now() + HANDOVER_HEAD_READ_MS),
  );
  try {
    return await Promise.all(
      bindingIds.map(async (bindingId) => ({
        binding_id: bindingId,
        commit: await promptBase.baseCommitOf(bindingId, read),
      })),
    );
  } finally {
    read.cancel();
  }
}

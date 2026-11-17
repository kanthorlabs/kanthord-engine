import type { Context } from "../../kernel/context.ts";
import { DeadlineKind, type Step, type StopCode } from "./chain.ts";
import { headCommit } from "./local-git.ts";
import { GitStep, withinGit } from "./method-telemetry.ts";
import { readPushRecord, writePushRecord } from "./push-record.ts";
import { next } from "./step-support.ts";
import type { StepsState } from "./steps-implement.ts";
import { sshAccessOf } from "./workspace.ts";

const STOPS: readonly StopCode[] = [
  "operation_failed/repository.connector.git_failed",
  "operation_failed/repository.node_branch.taken",
];

async function pushNodeBranches(
  state: StepsState,
  context: Context,
): Promise<void> {
  const remaining = () => state.input.claim.expired_at - Date.now();
  for (const checkout of state.checkouts) {
    const key = {
      nodeKey: state.input.workspaces.nodeKey(state.input.claim.node_id),
      nodeBranch: state.nodeBranch,
      bindingId: checkout.binding_id,
    };
    const head = await headCommit(
      state.input.env,
      checkout.directory,
      context,
      remaining(),
    );
    writePushRecord(key, {
      confirmed: readPushRecord(key)?.confirmed ?? null,
      pending: head,
    });
    await state.input.transport.pushNodeBranch(
      checkout.directory,
      state.nodeBranch,
      context,
      remaining(),
      sshAccessOf(state.input.sshAccess, checkout.binding_id),
    );
    writePushRecord(key, { confirmed: head, pending: null });
  }
}

export const branchPush: Step<unknown, "state", never> = {
  id: "branch.push",
  deadline: DeadlineKind.Cleanup,
  reads: ["state"],
  writes: [],
  stops: STOPS,
  note: "per checkout; push record around each push",
  async run({ state }, scope, io) {
    await withinGit(io.spans, GitStep.Push, () =>
      pushNodeBranches(state, io.context),
    );
    return next(scope);
  },
};

export const branchPushStop: Step<unknown, "state", never> = {
  id: "branch.push(stop)",
  deadline: DeadlineKind.Cleanup,
  reads: ["state"],
  writes: [],
  stops: [],
  note: "per checkout; no worker.git span; a failure logs checkpoint failed",
  async run({ state }, scope, io) {
    await pushNodeBranches(state, io.context);
    return next(scope);
  },
};

import assert from "node:assert/strict";
import type { Context } from "../../kernel/context.ts";
import type { SshAccess } from "../../repository/contract.ts";
import { DeadlineKind, type StopCode } from "./chain.ts";
import type { Step, StepHost } from "./chain-host.ts";
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

interface PushCtx {
  state: StepsState;
  sshAccess: ReadonlyMap<string, SshAccess>;
}

async function pushNodeBranches(
  ctx: PushCtx,
  host: StepHost,
  context: Context,
): Promise<void> {
  const { state } = ctx;
  const { workspaces, transport } = host;
  assert.ok(workspaces && transport, "A push needs a worker host.");
  const remaining = () => state.input.claim.expired_at - Date.now();
  for (const checkout of state.checkouts) {
    const key = {
      nodeKey: workspaces.nodeKey(state.input.claim.node_id),
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
    await transport.pushNodeBranch(
      checkout.directory,
      state.nodeBranch,
      context,
      remaining(),
      sshAccessOf(ctx.sshAccess, checkout.binding_id),
    );
    writePushRecord(key, { confirmed: head, pending: null });
  }
}

export const branchPush: Step<unknown, "state" | "sshAccess", never> = {
  id: "branch.push",
  deadline: DeadlineKind.Cleanup,
  reads: ["state", "sshAccess"],
  writes: [],
  stops: STOPS,
  note: "per checkout; push record around each push",
  async run(ctx, scope, io) {
    await withinGit(io.spans, GitStep.Push, () =>
      pushNodeBranches(ctx, io.host, io.context),
    );
    return next(scope);
  },
};

export const branchPushStop: Step<unknown, "state" | "sshAccess", never> = {
  id: "branch.push(stop)",
  deadline: DeadlineKind.Cleanup,
  reads: ["state", "sshAccess"],
  writes: [],
  stops: [],
  note: "per checkout; no worker.git span; a failure logs checkpoint failed",
  async run(ctx, scope, io) {
    await pushNodeBranches(ctx, io.host, io.context);
    return next(scope);
  },
};

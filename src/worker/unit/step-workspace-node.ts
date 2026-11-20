import assert from "node:assert/strict";
import { AssetKind } from "../../mission/contract.ts";
import { DeadlineKind } from "./chain.ts";
import type { Step } from "./chain-host.ts";
import { next, wallDeadlineOf } from "./step-support.ts";
import { hostInputOf } from "./chain-host.ts";
import { resolveGitPaths } from "./local-git.ts";
import { restoreCheckout } from "./turn-gate.ts";
import { type NodeCheckout, WorkspaceKind } from "./workspace-layout.ts";

const NO_CHECKOUTS = 0;

export const workspaceNode: Step<
  unknown,
  "claim" | "setup" | "sshAccess" | "attemptEvidence",
  "workspace"
> = {
  id: "workspace.node",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "sshAccess", "attemptEvidence"],
  writes: ["workspace"],
  stops: [
    "operation_failed/repository.node_checkout.pending_rebuild",
    "operation_failed/repository.node_branch.missing",
    "operation_failed/repository.connector.git_failed",
  ],
  note: "one coder checkout per binding at the node branch; restore to the read head",
  async run(ctx, scope, io) {
    const input = hostInputOf(ctx, io);
    assert.ok(input.setup.repositories.length > NO_CHECKOUTS);
    assert.equal(input.claim.execution_id, input.setup.execution_id);
    const pushed = new Set(
      ctx.attemptEvidence.flatMap((evidence) =>
        evidence.assets.flatMap((asset) =>
          asset.kind === AssetKind.Repository ? [asset.address.binding_id] : [],
        ),
      ),
    );
    const deadline = wallDeadlineOf(ctx);
    const workspace = await input.workspaces.prepareImplement({
      env: input.env,
      nodeId: input.claim.node_id,
      nodeBranch: input.claim.node_branch,
      pushed,
      repositories: input.setup.repositories,
      log: (msg, fields) => io.run.log(msg, fields),
      transport: input.transport,
      sshAccess: input.sshAccess,
      context: io.run.operationContext,
      deadlineMs: deadline - Date.now(),
    });
    io.resources.defer(() =>
      input.workspaces.release(
        input.workspaces.nodeKey(input.claim.node_id),
        WorkspaceKind.Node,
      ),
    );
    const checkouts: NodeCheckout[] = [];
    for (const checkout of workspace.checkouts) {
      const node = Object.assign(checkout, {
        gitPaths: await resolveGitPaths({
          env: input.env,
          directory: checkout.directory,
          context: io.run.operationContext,
          deadlineMs: deadline - Date.now(),
        }),
      });
      await restoreCheckout(
        input.env,
        node,
        input.claim.node_branch,
        node.head,
        io.run.operationContext,
        () => deadline - Date.now(),
      );
      checkouts.push(node);
    }
    return next(scope, { workspace: { ...workspace, checkouts } });
  },
};

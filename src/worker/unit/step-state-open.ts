import assert from "node:assert/strict";
import { DeadlineKind } from "./chain.ts";
import type { Step } from "./chain-host.ts";
import { next } from "./step-support.ts";
import { VerificationMemo } from "./verification-memo.ts";

export const stateOpen: Step<
  unknown,
  | "claim"
  | "setup"
  | "revision"
  | "prior"
  | "workspace"
  | "setupEntries"
  | "affectedTests"
  | "baseHead"
  | "setupPending"
  | "setupInstruction"
  | "agent",
  "state"
> = {
  id: "state.open",
  deadline: DeadlineKind.Work,
  reads: [
    "claim",
    "setup",
    "revision",
    "prior",
    "workspace",
    "setupEntries",
    "affectedTests",
    "baseHead",
    "setupPending",
    "setupInstruction",
    "agent",
  ],
  writes: ["state"],
  stops: [],
  note: "the live implement state of the later phases",
  async run(ctx, scope, io) {
    assert.ok(ctx.baseHead);
    return next(scope, {
      state: {
        input: { claim: ctx.claim, setup: ctx.setup, env: io.host.env },
        workspaceKey: io.host.workspaces.nodeKey(ctx.claim.node_id),
        cancel: io.run.operationContext,
        ports: io.ports,
        revision: ctx.revision,
        agent: ctx.agent,
        ...ctx.workspace,
        nodeBranch: ctx.claim.node_branch,
        setup: ctx.setupEntries,
        affectedTests: ctx.affectedTests,
        base: ctx.baseHead,
        setupPending: ctx.setupPending,
        setupInstruction: ctx.setupInstruction,
        verdict: ctx.prior.verdict,
        cleared: ctx.prior.cleared,
        unchangedTurns: 0,
        refreshed: null,
        lastVerification: null,
        revisionCount: 0,
        memo: new VerificationMemo(),
        verificationTimedOut: false,
      },
    });
  },
};

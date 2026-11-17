import assert from "node:assert/strict";
import { DeadlineKind, type Step } from "./chain.ts";
import { next, stepsInputOf } from "./step-support.ts";
import { VerificationMemo } from "./verification-memo.ts";

export const stateOpen: Step<
  unknown,
  | "claim"
  | "setup"
  | "sshAccess"
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
    "sshAccess",
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
        input: stepsInputOf(ctx, io),
        run: io.run,
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
      },
    });
  },
};

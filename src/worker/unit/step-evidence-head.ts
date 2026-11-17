import { DeadlineKind, type Step } from "./chain.ts";
import { EndReason } from "./execution-run.ts";
import { PortResultKind } from "./foundry-ports.ts";
import { headCommit } from "./local-git.ts";
import { next } from "./step-support.ts";
import { HEAD_COMMIT_SUBJECT } from "./steps-implement.ts";

export const evidenceHead: Step<unknown, "claim" | "state", never> = {
  id: "evidence.head",
  deadline: DeadlineKind.Cleanup,
  reads: ["claim", "state"],
  writes: [],
  stops: [],
  note: "port: evidence.submit; the pushed head of each binding",
  async run({ claim, state }, scope, io) {
    for (const checkout of state.checkouts)
      checkout.head = await headCommit(
        state.input.env,
        checkout.directory,
        io.context,
        claim.expired_at - Date.now(),
      );
    const submitted = await io.ports.evidence.submit(
      {
        subject: HEAD_COMMIT_SUBJECT,
        assets: state.checkouts.map((checkout) => ({
          kind: "repository",
          address: {
            kind: "repository",
            binding_id: checkout.binding_id,
            commit: checkout.head,
          },
        })),
      },
      io.run.operationContext,
      { halt: true },
    );
    if (submitted.kind === PortResultKind.Failed)
      io.run.stop(EndReason.OperationFailed, submitted.code);
    return next(scope);
  },
};

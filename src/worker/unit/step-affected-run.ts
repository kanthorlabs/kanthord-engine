import assert from "node:assert/strict";
import { AssetKind } from "../../mission/contract.ts";
import { ExecutionIntent } from "../contract.ts";
import {
  type AffectedEvidence,
  affectedEvidenceOf,
  type AffectedResult,
  type AffectedVerdict,
  runAffected,
} from "./affected.ts";
import {
  DeadlineKind,
  type ExecutionCtx,
  type FoundryIo,
  type FoundryStep,
} from "./chain.ts";
import { verificationCommands } from "./review-scope.ts";
import {
  environmentDigestsOf,
  VerificationContext,
} from "./method-telemetry.ts";
import {
  budgetEnd,
  budgetMapped,
  next,
  stopsReturned,
} from "./step-support.ts";
import { type TestedInput, verificationPassed } from "./verification.ts";

const NO_ITEMS = 0;

export interface AffectedStep {
  results: AffectedResult[];
  verdict: AffectedVerdict;
  document: AffectedEvidence | null;
}

type AffectedKeys =
  | "claim"
  | "setup"
  | "revision"
  | "reviewWorkspace"
  | "testedInput"
  | "baseHead"
  | "setupFailure"
  | "verification";

function headOf(testedInput: TestedInput, bindingId: string): string {
  const addresses = Array.isArray(testedInput) ? testedInput : [testedInput];
  const address = addresses.find(
    (entry) =>
      entry.kind === AssetKind.Repository && entry.binding_id === bindingId,
  );
  assert.ok(address?.kind === AssetKind.Repository);
  return address.commit;
}

async function affectedResults(
  ctx: Readonly<Pick<ExecutionCtx, AffectedKeys>>,
  io: FoundryIo,
): Promise<AffectedResult[] | null> {
  assert.ok(ctx.baseHead);
  const results: AffectedResult[] = [];
  for (const checkout of ctx.reviewWorkspace.checkouts) {
    const repository = ctx.setup.repositories.find(
      (entry) => entry.name === checkout.name,
    );
    assert.ok(repository);
    const result = await runAffected({
      env: io.env,
      context: io.context,
      deadline: io.budget.wallDeadline(),
      exhausted: () => io.budget.exhausted(),
      spans: io.ports.telemetry,
      scope: VerificationContext.Evaluation,
      workspaceKey: ctx.reviewWorkspace.key,
      checkout: {
        binding_id: repository.binding_id,
        name: checkout.name,
        directory: checkout.directory,
        base_branch: checkout.base_branch,
        head: headOf(ctx.testedInput, repository.binding_id),
      },
      digests: environmentDigestsOf(ctx.setup.repositories),
      base: ctx.baseHead,
    });
    if ("budgetEnd" in result) return null;
    results.push(result);
  }
  return results;
}

function runnable(ctx: Readonly<Pick<ExecutionCtx, AffectedKeys>>): boolean {
  return (
    ctx.setup.intent === ExecutionIntent.Implement &&
    ctx.reviewWorkspace.checkouts.length > NO_ITEMS &&
    ctx.setupFailure === null &&
    verificationPassed(
      ctx.verification.verification,
      verificationCommands(ctx.revision),
    )
  );
}

export const affectedRunEvaluation: FoundryStep<
  unknown,
  AffectedKeys,
  "affected"
> = {
  foundry: true,
  id: "affected.run(evaluation)",
  ports: [],
  deadline: DeadlineKind.Work,
  reads: [
    "claim",
    "setup",
    "revision",
    "reviewWorkspace",
    "testedInput",
    "baseHead",
    "setupFailure",
    "verification",
  ],
  writes: ["affected"],
  stops: [
    "operation_failed/worker.verification.infrastructure_failed",
    "environment_failed/affected_invalid",
    "environment_failed/affected_timeout",
    "environment_failed/command_absent",
  ],
  note: "implement intent, one checkout or more, setup and verify.all passed; budget end",
  async run(ctx, scope, io) {
    if (!runnable(ctx)) return next(scope, { affected: null });
    return stopsReturned(scope, () =>
      budgetMapped(io, scope, async () => {
        const results = await affectedResults(ctx, io);
        if (results === null) return budgetEnd(scope);
        const evidence = affectedEvidenceOf(results);
        return next(scope, {
          affected: {
            results,
            verdict: evidence.verdict,
            document: evidence.repositories.length > NO_ITEMS ? evidence : null,
          },
        });
      }),
    );
  },
};

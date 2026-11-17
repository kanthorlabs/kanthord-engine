import { canonicalJSON } from "../../kernel/json.ts";
import { AFFECTED_SUBJECT } from "./affected.ts";
import { DeadlineKind, type FoundryStep } from "./chain.ts";
import type { EvaluationPorts } from "./foundry-ports.ts";
import {
  ROUND_PATCH_MEDIA_TYPE,
  ROUND_PATCH_SUBJECT,
  roundPatchContent,
} from "./round-patch.ts";
import { next, stopsReturned, submittedEvidence } from "./step-support.ts";

export const VERIFICATION_SUBJECT = "Evaluation verification results";

function jsonAsset(value: unknown) {
  return {
    kind: "produced" as const,
    content: {
      media_type: "application/json",
      encoding: "base64" as const,
      data: Buffer.from(canonicalJSON(value)).toString("base64"),
    },
  };
}

export const evidencePublishVerification: FoundryStep<
  unknown,
  "verification",
  "verificationEvidence",
  EvaluationPorts
> = {
  foundry: true,
  id: "evidence.publish(verification)",
  deadline: DeadlineKind.Work,
  reads: ["verification"],
  writes: ["verificationEvidence"],
  stops: [],
  note: "port: evidence.submit",
  run(ctx, scope, io) {
    return stopsReturned(scope, async () => {
      const verification = ctx.verification.verification;
      const verificationEvidence = await submittedEvidence(io, {
        subject: VERIFICATION_SUBJECT,
        assets: [jsonAsset(verification.results)],
        verification,
      });
      return next(scope, { verificationEvidence });
    });
  },
};

export const evidencePublishAffected: FoundryStep<
  unknown,
  "affected",
  "affectedEvidence",
  EvaluationPorts
> = {
  foundry: true,
  id: "evidence.publish(affected)",
  deadline: DeadlineKind.Work,
  reads: ["affected"],
  writes: ["affectedEvidence"],
  stops: [],
  note: "port: evidence.submit; only when the affected step holds a document",
  run(ctx, scope, io) {
    return stopsReturned(scope, async () => {
      const document = ctx.affected?.document;
      if (document == null) return next(scope, { affectedEvidence: null });
      const affectedEvidence = await submittedEvidence(io, {
        subject: AFFECTED_SUBJECT,
        assets: [jsonAsset(document)],
      });
      return next(scope, { affectedEvidence });
    });
  },
};

export const evidencePublishPatches: FoundryStep<
  unknown,
  "placed",
  "patchEvidence",
  EvaluationPorts
> = {
  foundry: true,
  id: "evidence.publish(patches)",
  deadline: DeadlineKind.Work,
  reads: ["placed"],
  writes: ["patchEvidence"],
  stops: [],
  note: "port: evidence.submit",
  run(ctx, scope, io) {
    return stopsReturned(scope, async () => {
      const patchEvidence: string[] = [];
      for (const patch of ctx.placed.patches) {
        const submitted = await submittedEvidence(io, {
          subject: ROUND_PATCH_SUBJECT,
          assets: [
            {
              kind: "produced",
              content: {
                media_type: ROUND_PATCH_MEDIA_TYPE,
                encoding: "base64",
                data: roundPatchContent(patch.text).toString("base64"),
              },
            },
          ],
        });
        patchEvidence.push(submitted);
      }
      return next(scope, { patchEvidence });
    });
  },
};

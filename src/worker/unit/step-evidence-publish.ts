import { canonicalJSON } from "../../kernel/json.ts";
import { AFFECTED_SUBJECT } from "./affected.ts";
import { DeadlineKind, type Step } from "./chain.ts";
import { VERIFICATION_SUBJECT } from "./evaluation.ts";
import type { EvaluationPorts } from "./foundry-ports.ts";
import {
  ROUND_PATCH_MEDIA_TYPE,
  ROUND_PATCH_SUBJECT,
  roundPatchContent,
} from "./round-patch.ts";
import { next, submittedEvidence } from "./step-support.ts";

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

export const evidencePublishVerification: Step<
  unknown,
  "verification",
  "verificationEvidence",
  EvaluationPorts
> = {
  id: "evidence.publish(verification)",
  deadline: DeadlineKind.Work,
  reads: ["verification"],
  writes: ["verificationEvidence"],
  stops: [],
  note: "port: evidence.submit",
  async run(ctx, scope, io) {
    const verification = ctx.verification.verification;
    const verificationEvidence = await submittedEvidence(io, {
      subject: VERIFICATION_SUBJECT,
      assets: [jsonAsset(verification.results)],
      verification,
    });
    return next(scope, { verificationEvidence });
  },
};

export const evidencePublishAffected: Step<
  unknown,
  "affected",
  "affectedEvidence",
  EvaluationPorts
> = {
  id: "evidence.publish(affected)",
  deadline: DeadlineKind.Work,
  reads: ["affected"],
  writes: ["affectedEvidence"],
  stops: [],
  note: "port: evidence.submit; only when the affected step holds a document",
  async run(ctx, scope, io) {
    if (ctx.affected?.document == null)
      return next(scope, { affectedEvidence: null });
    const affectedEvidence = await submittedEvidence(io, {
      subject: AFFECTED_SUBJECT,
      assets: [jsonAsset(ctx.affected.document)],
    });
    return next(scope, { affectedEvidence });
  },
};

export const evidencePublishPatches: Step<
  unknown,
  "placed",
  "patchEvidence",
  EvaluationPorts
> = {
  id: "evidence.publish(patches)",
  deadline: DeadlineKind.Work,
  reads: ["placed"],
  writes: ["patchEvidence"],
  stops: [],
  note: "port: evidence.submit",
  async run(ctx, scope, io) {
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
  },
};

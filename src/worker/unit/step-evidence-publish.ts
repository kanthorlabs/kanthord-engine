import { canonicalJSON } from "../../kernel/json.ts";
import { AFFECTED_SUBJECT } from "./affected.ts";
import { DeadlineKind, type Step } from "./chain.ts";
import { VERIFICATION_SUBJECT } from "./evaluation.ts";
import {
  ROUND_PATCH_MEDIA_TYPE,
  ROUND_PATCH_SUBJECT,
  roundPatchContent,
} from "./round-patch.ts";
import { next } from "./step-support.ts";

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
  "claim" | "verification",
  "verificationEvidence"
> = {
  id: "evidence.publish(verification)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "verification"],
  writes: ["verificationEvidence"],
  stops: [],
  async run(ctx, scope, io) {
    const verification = ctx.verification.verification;
    const recorded = await io.run.submitEvidence(ctx.claim.node_id, {
      subject: VERIFICATION_SUBJECT,
      assets: [jsonAsset(verification.results)],
      verification,
    });
    return next(scope, { verificationEvidence: recorded.id });
  },
};

export const evidencePublishAffected: Step<
  unknown,
  "claim" | "affected",
  "affectedEvidence"
> = {
  id: "evidence.publish(affected)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "affected"],
  writes: ["affectedEvidence"],
  stops: [],
  note: "only when the affected step holds a document",
  async run(ctx, scope, io) {
    if (ctx.affected?.document == null)
      return next(scope, { affectedEvidence: null });
    const recorded = await io.run.submitEvidence(ctx.claim.node_id, {
      subject: AFFECTED_SUBJECT,
      assets: [jsonAsset(ctx.affected.document)],
    });
    return next(scope, { affectedEvidence: recorded.id });
  },
};

export const evidencePublishPatches: Step<
  unknown,
  "claim" | "placed",
  "patchEvidence"
> = {
  id: "evidence.publish(patches)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "placed"],
  writes: ["patchEvidence"],
  stops: [],
  async run(ctx, scope, io) {
    const patchEvidence: string[] = [];
    for (const patch of ctx.placed.patches) {
      const submitted = await io.run.submitEvidence(ctx.claim.node_id, {
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
      patchEvidence.push(submitted.id);
    }
    return next(scope, { patchEvidence });
  },
};

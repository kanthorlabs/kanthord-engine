import type { HttpError } from "../../contract/errors.ts";
import { httpError } from "../../contract/errors.ts";
import { NodeWriteError } from "../../../commands/node/refusal.ts";
import { ClaimNodeError } from "../../../commands/node/claim-node.ts";
import { HeartbeatNodeError } from "../../../commands/node/heartbeat-node.ts";
import { ReleaseNodeError } from "../../../commands/node/release-node.ts";

export function toHttpError(
  error: unknown,
  presented?: Readonly<{ subject: string; fence: number }>,
): HttpError {
  if (error instanceof NodeWriteError) {
    switch (error.refusal) {
      case "project-not-found":
      case "node-not-found":
        return httpError("not-found", error.message);
      case "kind-mismatch":
        return httpError("invalid-request", error.message, details(error));
      case "stale-revision":
        return httpError("stale-revision", error.message, details(error));
      case "plan-invalid":
        return httpError("plan-invalid", error.message, details(error));
      case "illegal-transition":
        return httpError("illegal-transition", error.message, details(error));
      case "binding-in-use":
        return httpError("binding-in-use", error.message, details(error));
    }
  }
  if (error instanceof ClaimNodeError) {
    return claimRefusal(error);
  }
  if (error instanceof HeartbeatNodeError) {
    return heartbeatRefusal(error, presented);
  }
  if (error instanceof ReleaseNodeError) {
    return releaseRefusal(error, presented);
  }
  throw error;
}

function claimRefusal(error: ClaimNodeError): HttpError {
  switch (error.refusal) {
    case "node-not-found":
      return httpError("not-found", error.message);
    case "initiative-not-claimable":
      return httpError("invalid-request", error.message, {
        refusal: "initiative-not-claimable",
      });
    case "plan-incomplete":
      return httpError("plan-invalid", error.message, {
        findings: details(error).findings,
      });
    case "drive-mode-pinned":
      return httpError("illegal-transition", error.message, {
        refusal: "drive-mode-pinned",
        pinnedDriver: details(error).pinnedDriver,
        claimDriver: details(error).claimDriver,
      });
    case "illegal-transition":
      return httpError("illegal-transition", error.message, {
        refusal: "node-state",
        state: details(error).state,
        admitted: details(error).admitted,
      });
    case "ancestor-not-startable":
      return httpError("illegal-transition", error.message, {
        refusal: "ancestor-not-startable",
        ancestorId: details(error).ancestorId,
        state: details(error).state,
        admitted: details(error).admitted,
      });
    case "lease-held":
      return leaseHeld(error, undefined);
  }
}

function heartbeatRefusal(
  error: HeartbeatNodeError,
  presented: Readonly<{ subject: string; fence: number }> | undefined,
): HttpError {
  switch (error.refusal) {
    case "node-not-found":
      return httpError("not-found", error.message);
    case "initiative-not-claimable":
      return httpError("invalid-request", error.message, {
        refusal: "initiative-not-claimable",
      });
    case "lease-held":
      return leaseHeld(error, presented);
  }
}

function releaseRefusal(
  error: ReleaseNodeError,
  presented: Readonly<{ subject: string; fence: number }> | undefined,
): HttpError {
  switch (error.refusal) {
    case "node-not-found":
      return httpError("not-found", error.message);
    case "initiative-not-claimable":
      return httpError("invalid-request", error.message, {
        refusal: "initiative-not-claimable",
      });
    case "lease-held":
      return leaseHeld(error, presented);
    case "no-active-run":
      return httpError("illegal-transition", error.message, {
        refusal: "node-state",
        state: "ready",
        admitted: ["ready", "running"],
      });
    case "no-open-attempt":
      return httpError("illegal-transition", error.message, {
        refusal: "node-state",
        state: "running",
        admitted: ["ready", "running"],
      });
    case "illegal-transition":
      return httpError("illegal-transition", error.message, {
        refusal: "node-state",
        state: details(error).state,
        admitted: details(error).admitted,
      });
  }
}

function leaseHeld(
  error: ClaimNodeError | HeartbeatNodeError | ReleaseNodeError,
  presented: Readonly<{ subject: string; fence: number }> | undefined,
): HttpError {
  const refusal = details(error);
  if (refusal.subject !== undefined) {
    return httpError("lease-held", error.message, {
      refusal: "held-by-other",
      subject: refusal.subject,
      holder: refusal.holder,
      holderKind: refusal.holderKind,
      fence: refusal.fence,
      expiresAt: refusal.expiresAt,
      relation: refusal.relation,
    });
  }
  if (presented !== undefined) {
    return httpError("lease-held", error.message, {
      refusal: "stale-fence",
      subject: presented.subject,
      presentedFence: presented.fence,
    });
  }
  throw error;
}

function details(
  error:
    NodeWriteError | ClaimNodeError | HeartbeatNodeError | ReleaseNodeError,
): Readonly<Record<string, unknown>> {
  return (error.details ?? {}) as Readonly<Record<string, unknown>>;
}

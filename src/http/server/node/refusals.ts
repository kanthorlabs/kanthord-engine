import { HttpError, httpError } from "../../contract/errors.ts";
import { NodeWriteError } from "../../../commands/node/refusal.ts";
import { ClaimNodeError } from "../../../commands/node/claim-node.ts";
import { HeartbeatNodeError } from "../../../commands/node/heartbeat-node.ts";
import { ReleaseNodeError } from "../../../commands/node/release-node.ts";
import { ReportOutcomeError } from "../../../commands/outcome/report-outcome.ts";
import { ReportObjectiveError } from "../../../commands/outcome/report-objective.ts";
import { CloseObjectiveError } from "../../../commands/outcome/close-objective.ts";
import { ListProjectNodeError } from "../../../queries/node/list-project-node.ts";

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
  if (error instanceof ReportOutcomeError) {
    return reportOutcomeRefusal(error, presented);
  }
  if (error instanceof ReportObjectiveError) {
    return reportObjectiveRefusal(error, presented);
  }
  if (error instanceof CloseObjectiveError) {
    return closeObjectiveRefusal(error);
  }
  if (error instanceof ListProjectNodeError) {
    switch (error.refusal) {
      case "project-not-found":
        return httpError("not-found", error.message);
    }
  }
  throw error;
}

function reportOutcomeRefusal(
  error: ReportOutcomeError,
  presented: Readonly<{ subject: string; fence: number }> | undefined,
): HttpError {
  switch (error.refusal) {
    case "node-not-found":
      return httpError("not-found", error.message);
    case "initiative-not-reportable":
    case "body-kind-mismatch":
      return httpError("invalid-request", error.message, {
        refusal: error.refusal,
      });
    case "actor-forbidden":
      return httpError("actor-forbidden", error.message);
    case "illegal-transition":
      return outcomeTransitionRefusal(error);
    case "lease-held":
      return leaseHeld(error, presented);
  }
}

function reportObjectiveRefusal(
  error: ReportObjectiveError,
  presented: Readonly<{ subject: string; fence: number }> | undefined,
): HttpError {
  switch (error.refusal) {
    case "actor-forbidden":
      return httpError("actor-forbidden", error.message);
    case "illegal-transition":
      return outcomeTransitionRefusal(error);
    case "lease-held":
      return leaseHeld(error, presented);
  }
}

function closeObjectiveRefusal(error: CloseObjectiveError): HttpError {
  switch (error.refusal) {
    case "actor-forbidden":
      return httpError("actor-forbidden", error.message);
    case "illegal-transition":
      return outcomeTransitionRefusal(error);
    case "acknowledgement-required":
      return new HttpError("acknowledgement-required", error.message);
  }
}

function outcomeTransitionRefusal(
  error: ReportOutcomeError | ReportObjectiveError | CloseObjectiveError,
): HttpError {
  const refusal = details(error);
  if (refusal.state !== undefined) {
    return httpError("illegal-transition", error.message, {
      refusal: "node-state",
      state: refusal.state,
      admitted: refusal.admitted,
    });
  }
  if (refusal.runDriver !== undefined) {
    return httpError("illegal-transition", error.message, {
      refusal: "run-driver",
      runDriver: refusal.runDriver,
      expectedDriver: refusal.expectedDriver,
    });
  }
  if (refusal.guard !== undefined) {
    return httpError("illegal-transition", error.message, {
      refusal: refusal.guard,
    });
  }
  return httpError("not-found", error.message);
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
    case "run-driver-mismatch":
      return httpError("illegal-transition", error.message, {
        refusal: "run-driver",
        runDriver: details(error).runDriver,
        expectedDriver: details(error).claimDriver,
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
  error:
    | ClaimNodeError
    | HeartbeatNodeError
    | ReleaseNodeError
    | ReportOutcomeError
    | ReportObjectiveError,
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
    | NodeWriteError
    | ClaimNodeError
    | HeartbeatNodeError
    | ReleaseNodeError
    | ReportOutcomeError
    | ReportObjectiveError
    | CloseObjectiveError,
): Readonly<Record<string, unknown>> {
  return (error.details ?? {}) as Readonly<Record<string, unknown>>;
}

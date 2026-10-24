import { DeadlineExceeded } from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { ResourceFailureReason } from "../kernel/health.ts";
import { HostKeyErrorCode, RepositoryErrorCode } from "./contract.ts";
import { SshAgentErrorCode } from "./ssh-agent.ts";

export const GIT_DEADLINE_EXCEEDED = "Git deadline exceeded";

const GIT_FAILURE_LINES: readonly (readonly [RegExp, ResourceFailureReason])[] =
  [
    [
      new RegExp(`: ${GIT_DEADLINE_EXCEEDED}$`, "m"),
      ResourceFailureReason.DeadlineExceeded,
    ],
    [
      /REMOTE HOST IDENTIFICATION HAS CHANGED/,
      ResourceFailureReason.HostKeyChanged,
    ],
    [/Host key verification failed/, ResourceFailureReason.HostKeyUnknown],
    [/Permission denied \(publickey/, ResourceFailureReason.KeyRefused],
    [/Repository not found/, ResourceFailureReason.RepositoryNotFound],
    [
      /The project you were looking for could not be found/,
      ResourceFailureReason.RepositoryNotFound,
    ],
    [/Could not resolve hostname/, ResourceFailureReason.HostUnreachable],
    [/Connection timed out/, ResourceFailureReason.HostUnreachable],
    [/Connection refused/, ResourceFailureReason.HostUnreachable],
    [/Operation timed out/, ResourceFailureReason.HostUnreachable],
    [/No route to host/, ResourceFailureReason.HostUnreachable],
    [/Network is unreachable/, ResourceFailureReason.HostUnreachable],
  ];

export function classifyGitFailure(stderr: string): ResourceFailureReason {
  for (const [line, reason] of GIT_FAILURE_LINES)
    if (line.test(stderr)) return reason;
  return ResourceFailureReason.Unclassified;
}

const REFUSAL_REASONS: ReadonlyMap<string, ResourceFailureReason> = new Map([
  [SshAgentErrorCode.Failed, ResourceFailureReason.IdentityUnavailable],
  [RepositoryErrorCode.SshKeyLegacy, ResourceFailureReason.IdentityUnavailable],
  [HostKeyErrorCode.Unpinned, ResourceFailureReason.HostKeyUnknown],
]);

export function gitFailureReason(error: unknown): ResourceFailureReason {
  if (error instanceof DeadlineExceeded)
    return ResourceFailureReason.DeadlineExceeded;
  const refusal =
    error instanceof Diagnostic || error instanceof OperationError
      ? REFUSAL_REASONS.get(error.code)
      : undefined;
  if (refusal !== undefined) return refusal;
  if (!(error instanceof Diagnostic) || !(error.cause instanceof Error))
    return ResourceFailureReason.Unclassified;
  return classifyGitFailure(error.cause.message);
}

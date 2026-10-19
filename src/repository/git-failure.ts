import { Diagnostic } from "../kernel/errors.ts";
import { ResourceFailureReason } from "../kernel/health.ts";

const GIT_FAILURE_LINES: readonly (readonly [RegExp, ResourceFailureReason])[] =
  [
    [/Host key verification failed/, ResourceFailureReason.HostKeyUnknown],
    [/Permission denied \(publickey/, ResourceFailureReason.KeyRefused],
    [/Repository not found/, ResourceFailureReason.RepositoryNotFound],
    [/Could not resolve hostname/, ResourceFailureReason.HostUnreachable],
    [/Connection timed out/, ResourceFailureReason.HostUnreachable],
    [/Connection refused/, ResourceFailureReason.HostUnreachable],
  ];

export function classifyGitFailure(stderr: string): ResourceFailureReason {
  for (const [line, reason] of GIT_FAILURE_LINES)
    if (line.test(stderr)) return reason;
  return ResourceFailureReason.Unclassified;
}

export function gitFailureReason(error: unknown): ResourceFailureReason {
  if (!(error instanceof Diagnostic) || !(error.cause instanceof Error))
    return ResourceFailureReason.Unclassified;
  return classifyGitFailure(error.cause.message);
}

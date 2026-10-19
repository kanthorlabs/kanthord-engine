import { Diagnostic } from "../kernel/errors.ts";
import { ResourceFailureReason } from "../kernel/health.ts";

const GIT_FAILURE_LINES: readonly (readonly [RegExp, ResourceFailureReason])[] =
  [
    [
      /REMOTE HOST IDENTIFICATION HAS CHANGED/,
      ResourceFailureReason.Unclassified,
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

export function gitFailureReason(error: unknown): ResourceFailureReason {
  if (!(error instanceof Diagnostic) || !(error.cause instanceof Error))
    return ResourceFailureReason.Unclassified;
  return classifyGitFailure(error.cause.message);
}

import { DEADLINE_EXCEEDED_CODE, DeadlineExceeded } from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { ResourceFailureReason } from "../kernel/health.ts";
import { HostKeyErrorCode, RepositoryErrorCode } from "./contract.ts";
import { SshAgentErrorCode } from "./ssh-agent.ts";

export const GIT_DEADLINE_EXCEEDED = "Git deadline exceeded";

export const PushRefusalKind = {
  NonFastForward: "non_fast_forward",
  Rule: "rule",
} as const;
export type PushRefusalKind =
  (typeof PushRefusalKind)[keyof typeof PushRefusalKind];
export interface PushRefusal {
  kind: PushRefusalKind;
  detail: string;
}

const NON_FAST_FORWARD_STDERR =
  /! \[rejected\][^\n]*(fetch first|non-fast-forward)/;
const RULE_REFUSAL_STDERR = /GH006|GH013|protected branch/;
const GIT_EXIT_PREFIX = /^.*?git exited with \d+: /;
const MAX_CAUSE_DEPTH = 8;
const NO_CHARACTERS = 0;

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
  [DEADLINE_EXCEEDED_CODE, ResourceFailureReason.DeadlineExceeded],
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

function stderrOf(error: unknown): string {
  let failure = error;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && failure instanceof Error && failure.cause;
    depth++
  )
    failure = failure.cause;
  return failure instanceof Error ? failure.message : "";
}

function firstLineOf(stderr: string): string {
  return (
    stderr
      .replace(GIT_EXIT_PREFIX, "")
      .split("\n")
      .find((line) => line.trim().length > NO_CHARACTERS)
      ?.trim() ?? ""
  );
}

export function pushRefusalOf(error: unknown): PushRefusal | null {
  const stderr = stderrOf(error);
  if (RULE_REFUSAL_STDERR.test(stderr))
    return { kind: PushRefusalKind.Rule, detail: firstLineOf(stderr) };
  if (NON_FAST_FORWARD_STDERR.test(stderr))
    return {
      kind: PushRefusalKind.NonFastForward,
      detail: firstLineOf(stderr),
    };
  return null;
}

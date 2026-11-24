import { Diagnostic, diagnostic, diagnosticRows } from "../../kernel/errors.ts";
import {
  FailureClass,
  InternalFailure,
  RunEnd,
} from "../../agent/agent-contract.ts";
import type { AgentOpenError } from "../../agent/agent-contract.ts";
import type { RunFailure, SecretWarning } from "../../agent/agent-contract.ts";
import { ExitCode } from "./constants.ts";

const OPEN_FAILED = "cli.run.agent.open_failed";
const START_REFUSED = "cli.run.agent.start_refused";
const PROVIDER_RETRYABLE = "cli.run.agent.provider_retryable";
const PROVIDER_FAILED = "cli.run.agent.provider_failed";
const INTERNAL_ERROR = "cli.run.agent.internal_error";
const SECRET_EXPOSED = "cli.run.agent.secret_exposed";
const SECRET_EXPOSED_MSG =
  "model output holds a known secret; rotate that credential";

export const RunExitCode = {
  Stopped: 2,
  BudgetEnd: 4,
  Failed: 5,
  Retryable: 75,
} as const;

export const CLASS_NONE = "none";
export const CLASS_RETRYABLE = "retryable";
export const CLASS_TERMINAL = "terminal";

export function agentExitCode(end: RunEnd, failure: RunFailure | null): number {
  if (end === RunEnd.Completed) return ExitCode.Success;
  if (end === RunEnd.Stopped) return RunExitCode.Stopped;
  if (end === RunEnd.BudgetEnd) return RunExitCode.BudgetEnd;
  if (failure?.class === FailureClass.Retryable) return RunExitCode.Retryable;
  return RunExitCode.Failed;
}

export function agentClassValue(
  end: RunEnd,
  failure: RunFailure | null,
): string {
  if (end === RunEnd.Completed) return CLASS_NONE;
  if (failure?.class === FailureClass.Retryable) return CLASS_RETRYABLE;
  return CLASS_TERMINAL;
}

function reasonField(reason: string): [string, string][] {
  return [["reason", reason.replace(/[\r\n]+/g, " ")]];
}

export function printStartRefused(reason: string): void {
  const diag = new Diagnostic(
    START_REFUSED,
    "run agent: a start precondition is not met.",
    { fields: reasonField(reason) },
  );
  process.stderr.write(`${diagnostic(diag)}\n${diagnosticRows(diag)}`);
}

export function printOpenFailed(error: AgentOpenError): void {
  const diag = new Diagnostic(
    OPEN_FAILED,
    "run agent: the agent open failed.",
    { fields: reasonField(error.message) },
  );
  process.stderr.write(`${diagnostic(diag)}\n${diagnosticRows(diag)}`);
}

export function printPostResultDiagnostic(failure: RunFailure): void {
  const isInternal = failure.kind === InternalFailure.Internal;
  const isRetryable = failure.class === FailureClass.Retryable;
  const code = isInternal
    ? INTERNAL_ERROR
    : isRetryable
      ? PROVIDER_RETRYABLE
      : PROVIDER_FAILED;
  const message = isInternal
    ? "run agent: the agent run ended with an internal error."
    : isRetryable
      ? "run agent: the provider request failed; the error may be temporary."
      : "run agent: the provider request failed.";
  const diag = new Diagnostic(code, message, {
    fields: reasonField(failure.reason),
  });
  process.stderr.write(`${diagnostic(diag)}\n${diagnosticRows(diag)}`);
}

export function printSecretWarnings(warnings: readonly SecretWarning[]): void {
  for (const warning of warnings) {
    process.stderr.write(
      `${JSON.stringify({ code: SECRET_EXPOSED, msg: SECRET_EXPOSED_MSG, rule: warning.rule, count: warning.count })}\n`,
    );
  }
}

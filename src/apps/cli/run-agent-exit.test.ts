import assert from "node:assert/strict";
import { test } from "node:test";
import { ExitCode } from "./constants.ts";
import {
  agentClassValue,
  agentExitCode,
  CLASS_NONE,
  CLASS_RETRYABLE,
  CLASS_TERMINAL,
  handleOpenFailed,
  printOpenFailed,
  printPostResultDiagnostic,
  RunExitCode,
  stoppedBySignalExit,
} from "./run-agent-exit.ts";
import {
  AgentOpenError,
  FailureClass,
  InternalFailure,
  RunEnd,
} from "../../agent/agent-contract.ts";
import type { RunFailure } from "../../agent/agent-contract.ts";

const PROVIDER_FAILURE = "unavailable" as const;
const NO_STDERR_LINES = 0;

function terminalFailure(
  kind: typeof PROVIDER_FAILURE = PROVIDER_FAILURE,
): RunFailure {
  return { kind, class: FailureClass.Terminal, reason: "failed" };
}

function retryableFailure(): RunFailure {
  return {
    kind: PROVIDER_FAILURE,
    class: FailureClass.Retryable,
    reason: "retry",
  };
}

function internalFailure(): RunFailure {
  return {
    kind: InternalFailure.Internal,
    class: FailureClass.Terminal,
    reason: "internal",
  };
}

test("agentExitCode returns 0 for completed", () => {
  assert.equal(agentExitCode(RunEnd.Completed, null), ExitCode.Success);
});

test("agentExitCode returns 2 for stopped", () => {
  assert.equal(agentExitCode(RunEnd.Stopped, null), RunExitCode.Stopped);
});

test("agentExitCode returns 4 for budget_end", () => {
  assert.equal(agentExitCode(RunEnd.BudgetEnd, null), RunExitCode.BudgetEnd);
});

test("agentExitCode returns 5 for terminal failed", () => {
  assert.equal(
    agentExitCode(RunEnd.Failed, terminalFailure()),
    RunExitCode.Failed,
  );
});

test("agentExitCode returns 5 for internal failed", () => {
  assert.equal(
    agentExitCode(RunEnd.Failed, internalFailure()),
    RunExitCode.Failed,
  );
});

test("agentExitCode returns 75 for retryable failed", () => {
  assert.equal(
    agentExitCode(RunEnd.Failed, retryableFailure()),
    RunExitCode.Retryable,
  );
});

test("agentClassValue returns none for completed", () => {
  assert.equal(agentClassValue(RunEnd.Completed, null), CLASS_NONE);
});

test("agentClassValue returns terminal for stopped", () => {
  assert.equal(agentClassValue(RunEnd.Stopped, null), CLASS_TERMINAL);
});

test("agentClassValue returns terminal for budget_end", () => {
  assert.equal(agentClassValue(RunEnd.BudgetEnd, null), CLASS_TERMINAL);
});

test("agentClassValue returns terminal for terminal failed", () => {
  assert.equal(
    agentClassValue(RunEnd.Failed, terminalFailure()),
    CLASS_TERMINAL,
  );
});

test("agentClassValue returns retryable for retryable failed", () => {
  assert.equal(
    agentClassValue(RunEnd.Failed, retryableFailure()),
    CLASS_RETRYABLE,
  );
});

test("printOpenFailed writes cli.run.agent.open_failed to stderr", () => {
  const error = new AgentOpenError("agent.open_failed", "open error msg");
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    printOpenFailed(error);
  } finally {
    process.stderr.write = original;
  }
  assert.ok(lines.some((l) => l.includes("cli.run.agent.open_failed")));
  assert.ok(lines.some((l) => l.includes("open error msg")));
});

test("printPostResultDiagnostic writes provider_failed for terminal failure", () => {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    printPostResultDiagnostic(terminalFailure());
  } finally {
    process.stderr.write = original;
  }
  assert.ok(lines.some((l) => l.includes("cli.run.agent.provider_failed")));
});

test("printPostResultDiagnostic writes provider_retryable for retryable failure", () => {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    printPostResultDiagnostic(retryableFailure());
  } finally {
    process.stderr.write = original;
  }
  assert.ok(lines.some((l) => l.includes("cli.run.agent.provider_retryable")));
});

test("printPostResultDiagnostic writes internal_error for internal failure", () => {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    printPostResultDiagnostic(internalFailure());
  } finally {
    process.stderr.write = original;
  }
  assert.ok(lines.some((l) => l.includes("cli.run.agent.internal_error")));
});

test("stoppedBySignalExit returns exit code 2", () => {
  const err = stoppedBySignalExit();
  assert.equal(err.exitCode, RunExitCode.Stopped);
});

test("handleOpenFailed with aborted signal returns stopped exit without stderr", () => {
  const signal = AbortSignal.abort();
  const error = new AgentOpenError("agent.open_failed", "aborted");
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  let result;
  try {
    result = handleOpenFailed(error, signal);
  } finally {
    process.stderr.write = original;
  }
  assert.equal(result.exitCode, RunExitCode.Stopped);
  assert.equal(lines.length, NO_STDERR_LINES);
});

test("handleOpenFailed with active signal returns open_failed exit with stderr", () => {
  const signal = new AbortController().signal;
  const error = new AgentOpenError("agent.open_failed", "open error");
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  let result;
  try {
    result = handleOpenFailed(error, signal);
  } finally {
    process.stderr.write = original;
  }
  assert.equal(result.exitCode, ExitCode.Failure);
  assert.ok(lines.some((l) => l.includes("cli.run.agent.open_failed")));
});

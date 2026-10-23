import { addAbortListener } from "node:events";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { Context } from "../../kernel/context.ts";
import { killProcessGroup } from "../../kernel/process-group.ts";
import { redactReason } from "../../kernel/probe.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import { childEnvironment } from "./tool-table.ts";
import { COMMAND_LIMIT_MS } from "./budget.ts";
import type { WorkspaceCheckout } from "./workspace.ts";

export type TestedInput =
  | { kind: "repository"; binding_id: string; commit: string }
  | { kind: "produced"; sha256: string }
  | { kind: "object"; location: string; version?: string; sha256?: string }
  | { kind: "repository"; binding_id: string; commit: string }[];
const SINGLE_CHECKOUT = 1;

export function testedInputOf(
  checkouts: readonly WorkspaceCheckout[],
): TestedInput {
  assert.ok(checkouts.length >= SINGLE_CHECKOUT);
  const addresses = checkouts.map((checkout) => ({
    kind: "repository" as const,
    binding_id: checkout.binding_id,
    commit: checkout.head,
  }));
  return addresses.length === SINGLE_CHECKOUT ? addresses[0]! : addresses;
}
export interface Verification {
  tested_input: TestedInput;
  results: {
    command: string;
    exit_code: number | null;
    signal: string | null;
    timed_out: boolean;
  }[];
}
export const VerificationClass = {
  BudgetEnd: "budget_end",
  CodeFailure: "code_failure",
  Infrastructure: "infrastructure",
  Pass: "pass",
} as const;
export type VerificationClass =
  (typeof VerificationClass)[keyof typeof VerificationClass];
export const VERIFICATION_INFRASTRUCTURE_FAILED =
  "worker.verification.infrastructure_failed";
export interface VerificationRun {
  verification: Verification;
  outputs: string[];
  flaky: boolean[];
  outcome: VerificationClass;
}
const SUCCESS = 0;
const SIGNAL_EXIT_FIRST = 129;
const SIGNAL_EXIT_LAST = 192;
const PROCESS_ABSENT = "ESRCH";
const OUTPUT_TAIL_BYTES = 4096;
const OUTPUT_GRACE_MS = 1000;
export const CommandEnd = {
  Exit: "exit",
  CommandLimit: "command_limit",
  WallDeadline: "wall_deadline",
  Cancelled: "cancelled",
  SpawnError: "spawn_error",
} as const;
export type CommandEnd = (typeof CommandEnd)[keyof typeof CommandEnd];
export interface CommandRun {
  result: Verification["results"][number];
  output: string;
  end: CommandEnd;
}
export interface CommandAttempt {
  command: string;
  index: number;
  run: number;
}
export type CommandObserver = (
  attempt: CommandAttempt,
  execute: () => Promise<CommandRun>,
) => Promise<CommandRun>;
const FIRST_RUN = 1;
const FIRST_RERUN = 2;
export interface VerificationInput {
  observe?: CommandObserver;
  directory: string;
  commands: readonly string[];
  tested_input: TestedInput;
  deadline: number;
  context: Context;
  env: NodeJS.ProcessEnv;
  commandLimitMs?: number;
  reruns?: number;
  exhausted?: () => boolean;
}

function outputTail(chunks: Buffer[]): string {
  const output = Buffer.concat(chunks);
  return output
    .subarray(Math.max(0, output.length - OUTPUT_TAIL_BYTES))
    .toString("utf8");
}

function observedCommand(
  attempt: CommandAttempt,
  input: VerificationInput,
): Promise<CommandRun> {
  assert.ok(attempt.run >= FIRST_RUN);
  assert.ok(attempt.index < input.commands.length);
  const execute = () => runCommand(attempt.command, input);
  return input.observe ? input.observe(attempt, execute) : execute();
}

function runCommand(
  command: string,
  input: VerificationInput,
): Promise<CommandRun> {
  assert.ok(command);
  assert.ok(Number.isSafeInteger(input.deadline));
  const deadline = Math.min(
    input.deadline,
    Date.now() + (input.commandLimitMs ?? COMMAND_LIMIT_MS),
  );
  const timeoutEnd =
    deadline === input.deadline
      ? CommandEnd.WallDeadline
      : CommandEnd.CommandLimit;
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      cwd: input.directory,
      env: childEnvironment(input.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const chunks: Buffer[] = [];
    let kept = 0;
    const keep = (chunk: Buffer) => {
      chunks.push(chunk);
      kept += chunk.length;
      for (
        let first = chunks[0];
        first && kept - first.length >= OUTPUT_TAIL_BYTES;
        first = chunks[0]
      ) {
        chunks.shift();
        kept -= first.length;
      }
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let killEnd: CommandEnd | null = null;
    const kill = () => {
      if (!child.pid) return;
      try {
        killProcessGroup(child.pid);
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === PROCESS_ABSENT
        ))
          reject(error);
      }
    };
    const timer = setTimeout(
      () => {
        killEnd ??= timeoutEnd;
        kill();
      },
      Math.max(SUCCESS, deadline - Date.now()),
    );
    const cancellation = addAbortListener(input.context.signal, () => {
      killEnd ??= CommandEnd.Cancelled;
      kill();
    });
    let finished = false;
    const finish = (
      exitCode: number | null,
      signal: string | null,
      end: CommandEnd,
    ) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cancellation[Symbol.dispose]();
      const timedOut =
        end === CommandEnd.CommandLimit || end === CommandEnd.WallDeadline;
      resolve({
        result: { command, exit_code: exitCode, signal, timed_out: timedOut },
        output: outputTail(chunks),
        end,
      });
    };
    child.once("error", () => finish(null, null, CommandEnd.SpawnError));
    child.once("exit", (exitCode, signal) => {
      const end = killEnd ?? CommandEnd.Exit;
      const grace = setTimeout(
        () => finish(exitCode, signal, end),
        OUTPUT_GRACE_MS,
      );
      child.once("close", () => {
        clearTimeout(grace);
        finish(exitCode, signal, end);
      });
    });
  });
}

function signalExit(exitCode: number | null): boolean {
  return (
    exitCode !== null &&
    exitCode >= SIGNAL_EXIT_FIRST &&
    exitCode <= SIGNAL_EXIT_LAST
  );
}

function classOf(ran: CommandRun, exhausted: boolean): VerificationClass {
  if (exhausted || ran.end === CommandEnd.WallDeadline)
    return VerificationClass.BudgetEnd;
  if (ran.end === CommandEnd.CommandLimit || ran.end === CommandEnd.Cancelled)
    return VerificationClass.CodeFailure;
  if (
    ran.end === CommandEnd.SpawnError ||
    ran.result.signal !== null ||
    signalExit(ran.result.exit_code)
  )
    return VerificationClass.Infrastructure;
  return ran.result.exit_code === SUCCESS
    ? VerificationClass.Pass
    : VerificationClass.CodeFailure;
}

function unstartedClass(input: VerificationInput): VerificationClass | null {
  if (input.context.signal.aborted) return VerificationClass.CodeFailure;
  if (Date.now() >= input.deadline) return VerificationClass.BudgetEnd;
  return null;
}

async function classifiedCommand(
  command: string,
  index: number,
  input: VerificationInput,
): Promise<{ ran: CommandRun; outcome: VerificationClass; runs: number }> {
  const exhausted = input.exhausted ?? (() => false);
  const ran = await observedCommand({ command, index, run: FIRST_RUN }, input);
  const outcome = classOf(ran, exhausted());
  if (outcome !== VerificationClass.Infrastructure)
    return { ran, outcome, runs: FIRST_RUN };
  const unstarted = unstartedClass(input);
  if (unstarted !== null) return { ran, outcome: unstarted, runs: FIRST_RUN };
  const rerun = await observedCommand(
    { command, index, run: FIRST_RERUN },
    input,
  );
  return {
    ran: rerun,
    outcome: classOf(rerun, exhausted()),
    runs: FIRST_RERUN,
  };
}

export async function runVerificationsWithOutput(
  input: VerificationInput,
): Promise<VerificationRun> {
  assert.ok(input.directory);
  assert.ok(Number.isSafeInteger(input.deadline));
  const results: Verification["results"] = [];
  const outputs: string[] = [];
  const flaky: boolean[] = [];
  let outcome: VerificationClass = VerificationClass.Pass;
  for (const [index, command] of input.commands.entries()) {
    const unstarted = unstartedClass(input);
    if (unstarted !== null) {
      outcome = unstarted;
      break;
    }
    const classified = await classifiedCommand(command, index, input);
    results.push(classified.ran.result);
    outputs.push(classified.ran.output);
    outcome = classified.outcome;
    if (outcome === VerificationClass.Pass) {
      flaky.push(false);
      continue;
    }
    flaky.push(
      outcome === VerificationClass.CodeFailure &&
        !classified.ran.result.timed_out &&
        (await passesOnRerun(command, index, input, classified.runs)),
    );
    break;
  }
  return {
    verification: { tested_input: input.tested_input, results },
    outputs,
    flaky,
    outcome,
  };
}

async function passesOnRerun(
  command: string,
  index: number,
  input: VerificationInput,
  runs: number,
): Promise<boolean> {
  for (let rerun = 0; rerun < (input.reruns ?? 0); rerun++) {
    if (Date.now() >= input.deadline || input.context.signal.aborted)
      return false;
    const attempt = { command, index, run: runs + FIRST_RUN + rerun };
    if ((await observedCommand(attempt, input)).result.exit_code === SUCCESS)
      return true;
  }
  return false;
}

export function infrastructureStop(run: VerificationRun): ExecutionStop | null {
  if (run.outcome !== VerificationClass.Infrastructure) return null;
  const result = run.verification.results.at(-1);
  assert.ok(result);
  return new ExecutionStop(
    EndReason.OperationFailed,
    VERIFICATION_INFRASTRUCTURE_FAILED,
    redactReason(
      JSON.stringify({
        exit_code: result.exit_code,
        signal: result.signal,
        timed_out: result.timed_out,
        command: result.command,
      }),
    ),
  );
}

export async function runVerifications(
  input: VerificationInput,
): Promise<Verification> {
  return (await runVerificationsWithOutput(input)).verification;
}

export function verificationPassed(
  verification: Verification,
  commands: readonly string[],
): boolean {
  assert.ok(verification.results);
  assert.ok(commands);
  return (
    verification.results.length === commands.length &&
    verification.results.every(
      (result, index) =>
        result.command === commands[index] && result.exit_code === SUCCESS,
    )
  );
}

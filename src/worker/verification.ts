import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { Context } from "../kernel/context.ts";
import { childEnvironment } from "./tool-table.ts";

export type TestedInput =
  | { kind: "repository"; binding_id: string; commit: string }
  | { kind: "produced"; sha256: string }
  | { kind: "object"; location: string; version?: string; sha256?: string }
  | { kind: "repository"; binding_id: string; commit: string }[];
export interface Verification {
  tested_input: TestedInput;
  results: {
    command: string;
    exit_code: number | null;
    signal: string | null;
    timed_out: boolean;
  }[];
}
export interface VerificationRun {
  verification: Verification;
  outputs: string[];
  flaky: boolean[];
}
const SUCCESS = 0;
const PROCESS_ABSENT = "ESRCH";
const OUTPUT_TAIL_BYTES = 4096;
const OUTPUT_GRACE_MS = 1000;
export const COMMAND_LIMIT_MS = 600000;
export interface VerificationInput {
  directory: string;
  commands: readonly string[];
  tested_input: TestedInput;
  deadline: number;
  context: Context;
  commandLimitMs?: number;
  reruns?: number;
}

function outputTail(chunks: Buffer[]): string {
  const output = Buffer.concat(chunks);
  return output
    .subarray(Math.max(0, output.length - OUTPUT_TAIL_BYTES))
    .toString("utf8");
}

function runCommand(
  command: string,
  input: VerificationInput,
): Promise<{ result: Verification["results"][number]; output: string }> {
  assert.ok(command);
  assert.ok(Number.isSafeInteger(input.deadline));
  const deadline = Math.min(
    input.deadline,
    Date.now() + (input.commandLimitMs ?? COMMAND_LIMIT_MS),
  );
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      cwd: input.directory,
      env: childEnvironment(process.env),
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
    let timedOut = false;
    const kill = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
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
        timedOut = true;
        kill();
      },
      Math.max(SUCCESS, deadline - Date.now()),
    );
    const unsubscribe = input.context.onCancel(kill);
    let finished = false;
    const finish = (exitCode: number | null, signal: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      resolve({
        result: { command, exit_code: exitCode, signal, timed_out: timedOut },
        output: outputTail(chunks),
      });
    };
    child.once("error", () => finish(null, null));
    child.once("exit", (exitCode, signal) => {
      const grace = setTimeout(() => finish(exitCode, signal), OUTPUT_GRACE_MS);
      child.once("close", () => {
        clearTimeout(grace);
        finish(exitCode, signal);
      });
    });
  });
}

export async function runVerificationsWithOutput(
  input: VerificationInput,
): Promise<VerificationRun> {
  assert.ok(input.directory);
  assert.ok(Number.isSafeInteger(input.deadline));
  const results: Verification["results"] = [];
  const outputs: string[] = [];
  const flaky: boolean[] = [];
  for (const command of input.commands) {
    if (Date.now() >= input.deadline || input.context.err()) break;
    const { result, output } = await runCommand(command, input);
    results.push(result);
    outputs.push(output);
    if (result.exit_code === SUCCESS) {
      flaky.push(false);
      continue;
    }
    flaky.push(!result.timed_out && (await passesOnRerun(command, input)));
    break;
  }
  return {
    verification: { tested_input: input.tested_input, results },
    outputs,
    flaky,
  };
}

async function passesOnRerun(
  command: string,
  input: VerificationInput,
): Promise<boolean> {
  for (let rerun = 0; rerun < (input.reruns ?? 0); rerun++) {
    if (Date.now() >= input.deadline || input.context.err()) return false;
    if ((await runCommand(command, input)).result.exit_code === SUCCESS)
      return true;
  }
  return false;
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

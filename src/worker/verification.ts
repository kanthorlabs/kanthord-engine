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
const SUCCESS = 0;
const PROCESS_ABSENT = "ESRCH";
export interface VerificationInput {
  directory: string;
  commands: readonly string[];
  tested_input: TestedInput;
  deadline: number;
  context: Context;
}

function runCommand(
  command: string,
  input: VerificationInput,
): Promise<Verification["results"][number]> {
  assert.ok(command);
  assert.ok(Number.isSafeInteger(input.deadline));
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      cwd: input.directory,
      env: childEnvironment(process.env),
      stdio: "ignore",
      detached: true,
    });
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
      Math.max(SUCCESS, input.deadline - Date.now()),
    );
    const unsubscribe = input.context.onCancel(kill);
    const finish = (exitCode: number | null, signal: string | null) => {
      clearTimeout(timer);
      unsubscribe();
      resolve({ command, exit_code: exitCode, signal, timed_out: timedOut });
    };
    child.once("error", () => finish(null, null));
    child.once("exit", finish);
  });
}

export async function runVerifications(
  input: VerificationInput,
): Promise<Verification> {
  assert.ok(input.directory);
  assert.ok(Number.isSafeInteger(input.deadline));
  const results: Verification["results"] = [];
  for (const command of input.commands) {
    if (Date.now() >= input.deadline || input.context.err()) break;
    const result = await runCommand(command, input);
    results.push(result);
    if (result.exit_code !== SUCCESS) break;
  }
  return { tested_input: input.tested_input, results };
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

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../../kernel/context.ts";
import { ensureDirectory } from "../../kernel/files.ts";
import { killProcessGroup } from "../../kernel/process-group.ts";
import {
  ENVIRONMENT_DIRECTORY,
  ProofPhase,
  TAIL_BYTES,
  type CommandResult,
  type ProofInput,
} from "../../project/environment-state.ts";
import { threadEnvironment } from "./thread-driver.ts";

export const HOST_PROOF_DEADLINE_MS = 1800000;
const RUN_DIRECTORY_PREFIX = "run-";
const CHECKOUT_DIRECTORY = "checkout";
const ABSENT_PROCESS = "ESRCH";
const PASSED_EXIT = 0;

export interface HostProofOptions {
  readonly stateDirectory: string;
  readonly source: NodeJS.ProcessEnv;
  readonly commandLimitMs: number;
  exportRepository(
    bindingId: string,
    commit: string,
    directory: string,
    context: Context,
  ): Promise<void>;
}

interface Step {
  phase: ProofPhase;
  command: string;
}

function endGroup(leader: number): void {
  try {
    killProcessGroup(leader);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== ABSENT_PROCESS) throw error;
  }
}

function runCommand(
  step: Step,
  cwd: string,
  env: NodeJS.ProcessEnv,
  limitMs: number,
  signal: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      while (size - chunks[0]!.length >= TAIL_BYTES)
        size -= chunks.shift()!.length;
    };
    const child = spawn("bash", ["-c", step.command], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const leader = child.pid;
    const kill = () => {
      if (leader !== undefined) endGroup(leader);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, limitMs);
    signal.addEventListener("abort", kill, { once: true });
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
    };
    if (signal.aborted) kill();
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.once("error", (error) => {
      finish();
      kill();
      reject(error);
    });
    child.once("close", (code) => {
      finish();
      resolve({
        phase: step.phase,
        command: step.command,
        exit_code: code,
        timed_out: timedOut,
        output: Buffer.concat(chunks).subarray(-TAIL_BYTES).toString("utf8"),
      });
    });
  });
}

export class HostProofs {
  private readonly options: HostProofOptions;

  constructor(options: HostProofOptions) {
    this.options = options;
  }

  async proveOnHost(
    input: ProofInput,
    signal: AbortSignal,
  ): Promise<CommandResult[]> {
    const root = join(
      this.options.stateDirectory,
      ENVIRONMENT_DIRECTORY,
      `${RUN_DIRECTORY_PREFIX}${input.run_id}`,
    );
    const checkout = join(root, CHECKOUT_DIRECTORY);
    const run = AbortSignal.any([
      signal,
      AbortSignal.timeout(HOST_PROOF_DEADLINE_MS),
    ]);
    try {
      ensureDirectory(checkout);
      await this.options.exportRepository(
        input.binding_id,
        input.commit,
        checkout,
        { signal: run, deadline: Date.now() + HOST_PROOF_DEADLINE_MS },
      );
      return await this.runSteps(input, checkout, root, run);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  private async runSteps(
    input: ProofInput,
    checkout: string,
    root: string,
    signal: AbortSignal,
  ): Promise<CommandResult[]> {
    const env = threadEnvironment(this.options.source, root);
    const steps: Step[] = [
      ...input.setup.map((command) => ({ phase: ProofPhase.Setup, command })),
      ...input.checks.map((command) => ({ phase: ProofPhase.Check, command })),
    ];
    const results: CommandResult[] = [];
    for (const step of steps) {
      if (signal.aborted) break;
      const result = await runCommand(
        step,
        checkout,
        env,
        this.options.commandLimitMs,
        signal,
      );
      if (signal.aborted) break;
      results.push(result);
      if (step.phase === ProofPhase.Setup && !passed(result)) break;
    }
    return results;
  }
}

function passed(result: CommandResult): boolean {
  return !result.timed_out && result.exit_code === PASSED_EXIT;
}

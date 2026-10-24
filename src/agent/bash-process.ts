import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { killChildTree } from "../kernel/process-group.ts";

const MILLISECONDS_PER_SECOND = 1000;
const TIMER_LIMIT_MS = 2_147_483_647;
const OUTPUT_IDLE_MS = 100;
const NO_TIMEOUT_MS = 0;
const SIGNAL_EXIT_BASE = 128;
const FAILED_EXIT = 1;
const ABORTED = "aborted";
const ARGV_TRANSPORT = "argv";

export interface ShellConfig {
  shell: string;
  args: string[];
  commandTransport?: "argv" | "stdin";
}

export interface BashProcess {
  pid: number;
  killed: boolean;
}

type ExecOptions = Parameters<BashOperations["exec"]>[2];

export function processBashOperations(
  shell: ShellConfig,
  settled: (process: BashProcess) => void,
): BashOperations {
  assert.ok(shell.shell);
  assert.equal(shell.commandTransport ?? ARGV_TRANSPORT, ARGV_TRANSPORT);
  return {
    exec: (command, cwd, options) =>
      runBash(shell, command, cwd, options, settled),
  };
}

async function runBash(
  shell: ShellConfig,
  command: string,
  cwd: string,
  options: ExecOptions,
  settled: (process: BashProcess) => void,
): Promise<{ exitCode: number | null }> {
  const { onData, signal, timeout, env } = options;
  const timeoutMs = timeoutMsOf(timeout);
  if (signal?.aborted) throw new Error(ABORTED);
  await access(cwd).catch(() => {
    throw new Error(`Working directory does not exist: ${cwd}`);
  });
  const child = spawn(shell.shell, [...shell.args, command], {
    cwd,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let killed = false;
  let killFailure: unknown = null;
  const kill = () => {
    if (killed || child.pid === undefined) return;
    killed = true;
    try {
      killChildTree({
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
      });
    } catch (error) {
      killFailure = error;
    }
  };
  const timer =
    timeoutMs === undefined ? undefined : setTimeout(kill, timeoutMs);
  signal?.addEventListener("abort", kill, { once: true });
  if (signal?.aborted) kill();
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  try {
    const exitCode = await childExit(child);
    if (killFailure !== null) throw killFailure;
    if (signal?.aborted) throw new Error(ABORTED);
    if (killed) throw new Error(`timeout:${timeout}`);
    return { exitCode: exitCode ?? signalExit(child) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
    if (child.pid !== undefined) settled({ pid: child.pid, killed });
  }
}

function timeoutMsOf(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  const timeoutMs = timeout * MILLISECONDS_PER_SECOND;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= NO_TIMEOUT_MS ||
    timeoutMs > TIMER_LIMIT_MS
  )
    throw new Error("Invalid timeout: must be a finite number of seconds");
  return timeoutMs;
}

function signalExit(child: ChildProcess): number {
  const signal = child.signalCode;
  if (signal === null) return FAILED_EXIT;
  return SIGNAL_EXIT_BASE + (osConstants.signals[signal] ?? 0);
}

function childExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let exitCode: number | null = null;
    let idle: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      clearTimeout(idle);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };
    const rearm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => finish(exitCode), OUTPUT_IDLE_MS);
    };
    child.once("error", reject);
    child.once("exit", (code) => {
      exitCode = code;
      rearm();
      child.stdout?.on("data", rearm);
      child.stderr?.on("data", rearm);
    });
    child.once("close", (code: number | null) => finish(code ?? exitCode));
  });
}

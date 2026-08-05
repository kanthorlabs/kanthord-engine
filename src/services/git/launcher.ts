import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export const LAUNCHER_SHELL = "/bin/sh";

export const LAUNCHER_SCRIPT =
  'set -C; printf "%s" "$$" > "$KANTHORD_PID_FILE" || exit 111; exec "$@"';

export const LAUNCHER_PID_FILE_FAILURE = 111;

export type SupervisedSpawnInput = Readonly<{
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
  pidFile: string;
}>;

export type SupervisedExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

export type SupervisedChild = Readonly<{
  pid: number;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<SupervisedExit>;
  signalGroup(signal: NodeJS.Signals): void;
}>;

export type SupervisedSpawnFailure = Readonly<{
  pid: undefined;
  exited: Promise<SupervisedExit>;
}>;

export type SupervisedSpawn = SupervisedChild | SupervisedSpawnFailure;

export function launcherArgv(
  input: Pick<SupervisedSpawnInput, "command" | "args">,
): readonly string[] {
  return ["-c", LAUNCHER_SCRIPT, "sh", input.command, ...input.args];
}

export function assertSignallable(pid: number | undefined): void {
  if (!isSignallable(pid)) {
    throw new Error("a supervised pid must be greater than 1");
  }
}

function isSignallable(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isInteger(pid) && pid > 1;
}

function requireSignallable(pid: number | undefined): number {
  if (!isSignallable(pid)) {
    throw new Error("a supervised pid must be greater than 1");
  }
  return pid;
}

export function spawnSupervised(input: SupervisedSpawnInput): SupervisedSpawn {
  const child = spawn(LAUNCHER_SHELL, launcherArgv(input), {
    env: { ...input.env, KANTHORD_PID_FILE: input.pidFile },
    cwd: input.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<SupervisedExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  if (child.pid === undefined) {
    return { pid: undefined, exited };
  }
  const pid = requireSignallable(child.pid);
  return {
    pid,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    signalGroup(signal: NodeJS.Signals): void {
      requireSignallable(pid);
      process.kill(-pid, signal);
    },
  };
}

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";

export const LAUNCHER_SHELL = "/bin/sh";

export const READY_FD = 3;

export const LAUNCHER_SCRIPT =
  'set -C; printf "%s" "$$" > "$KANTHORD_PID_FILE" || exit 111; printf r >&3; exec 3>&-; read -r _ || exit 112; exec 0</dev/null; exec "$@"';

export const LAUNCHER_PID_FILE_FAILURE = 111;
export const LAUNCHER_ORPHANED_FAILURE = 112;

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

function releaseOnReady(child: ChildProcessWithoutNullStreams): void {
  const ready = child.stdio[READY_FD];
  if (ready === null || ready === undefined || !("on" in ready)) {
    return;
  }
  let released = false;
  ready.on("error", () => {});
  ready.on("data", () => {
    if (released) {
      return;
    }
    released = true;
    child.stdin.write("go\n");
    child.stdin.end();
  });
}

export function spawnSupervised(input: SupervisedSpawnInput): SupervisedSpawn {
  const child = spawn(LAUNCHER_SHELL, launcherArgv(input), {
    env: { ...input.env, KANTHORD_PID_FILE: input.pidFile },
    cwd: input.cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
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
  child.stdin.on("error", () => {});
  releaseOnReady(child);
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

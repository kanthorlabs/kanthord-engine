import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { GitError, type GitPaths } from "./index.ts";
import { gitArgv, gitEnvironment } from "./environment.ts";
import { spawnSupervised, LAUNCHER_PID_FILE_FAILURE } from "./launcher.ts";
import { stripUserinfo } from "./redact.ts";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_OUTPUT_LIMIT_BYTES = 1_048_576;
export const TERMINATION_GRACE_MS = 2_000;

export type GitRunRequest = Readonly<{
  args: readonly string[];
  cwd?: string;
  extraEnv?: Readonly<Record<string, string>>;
  pidFile?: string;
  timeoutMs?: number;
  outputLimitBytes?: number;
}>;

export type GitRunResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
  args: readonly string[];
}>;

export type GitRunner = (request: GitRunRequest) => Promise<GitRunResult>;

export function createGitRunner(paths: GitPaths): GitRunner {
  return async (request: GitRunRequest): Promise<GitRunResult> => {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const outputLimitBytes =
      request.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
    const pidFile =
      request.pidFile ?? join(paths.runDirectory, `git-${randomUUID()}.pid`);
    const mintedPidFile = request.pidFile === undefined;

    const child = spawnSupervised({
      command: paths.git,
      args: gitArgv(request.args),
      env: gitEnvironment({ paths, extra: request.extraEnv }),
      cwd: request.cwd ?? paths.home,
      pidFile,
    });

    if (child.pid === undefined) {
      await child.exited;
      throw new GitError("unknown", `git ${request.args[0]} did not start`, "");
    }

    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let cancelled = false;
    let exceeded = false;
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let signalError: unknown;

    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        child.signalGroup(signal);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && code !== "EPERM") {
          signalError ??= error;
        }
      }
    };

    const cancel = (): void => {
      if (cancelled) {
        return;
      }
      cancelled = true;
      signalGroup("SIGTERM");
      graceTimer = setTimeout(() => {
        signalGroup("SIGKILL");
      }, TERMINATION_GRACE_MS);
      graceTimer.unref();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (cancelled) {
        return;
      }
      stdoutSize += chunk.length;
      if (stdoutSize > outputLimitBytes) {
        exceeded = true;
        cancel();
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (cancelled) {
        return;
      }
      stderrSize += chunk.length;
      if (stderrSize > outputLimitBytes) {
        exceeded = true;
        cancel();
        return;
      }
      stderrChunks.push(chunk);
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, timeoutMs);
    timeoutTimer.unref();

    try {
      const { code, signal } = await child.exited;
      if (signalError !== undefined) {
        throw signalError;
      }
      if (exceeded) {
        throw new GitError(
          "output-exceeded",
          `git ${request.args[0]} exceeded ${outputLimitBytes} bytes of output`,
          "",
        );
      }
      if (timedOut) {
        throw new GitError(
          "timed-out",
          `git ${request.args[0]} exceeded ${timeoutMs}ms`,
          stripUserinfo(Buffer.concat(stderrChunks).toString("utf8")),
        );
      }
      if (code === LAUNCHER_PID_FILE_FAILURE) {
        throw new GitError(
          "unknown",
          "the launcher could not create the pid file",
          "",
        );
      }
      if (code === null) {
        throw new GitError(
          "unknown",
          `git ${request.args[0]} terminated by signal ${signal}`,
          "",
        );
      }
      return {
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        args: request.args,
      };
    } finally {
      clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
      }
      if (mintedPidFile) {
        rmSync(pidFile, { force: true });
      }
    }
  };
}

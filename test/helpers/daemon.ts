import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

export type DaemonExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

export type DaemonProcess = Readonly<{
  pid: number;
  ready(): Promise<void>;
  exited(): Promise<DaemonExit>;
  stdout(): string;
  stderr(): string;
  kill(signal?: NodeJS.Signals): void;
}>;

export type LaunchInput = Readonly<{
  configPath?: string;
  home?: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}>;

const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const running: ChildProcess[] = [];

export function launchDaemon(input: LaunchInput): DaemonProcess {
  const args: string[] = [];
  if (input.configPath) {
    args.push("--config", input.configPath);
  }
  if (input.home) {
    args.push("--home", input.home);
  }
  args.push("serve");

  const child = spawn(process.execPath, [entry, ...args], {
    cwd: input.cwd ?? tmpdir(),
    env: { ...(input.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  running.push(child);

  let stdoutData = "";
  let stderrData = "";

  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutData += chunk.toString("utf8");
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrData += chunk.toString("utf8");
  });

  let exitRecord: DaemonExit | null = null;
  const exitPromise = new Promise<DaemonExit>((resolve) => {
    child.on("exit", (code, signal) => {
      exitRecord = { code, signal: signal as NodeJS.Signals | null };
      const idx = running.indexOf(child);
      if (idx !== -1) running.splice(idx, 1);
      resolve(exitRecord);
    });
  });

  return {
    get pid() {
      return child.pid!;
    },
    ready() {
      if (stdoutData.includes("kanthord: ready\n")) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(
              `daemon did not become ready within 5000 ms\nexit code: ${exitRecord?.code}\nsignal: ${exitRecord?.signal}\nstderr: ${stderrData}`,
            ),
          );
        }, 5000);

        const check = (chunk: Buffer) => {
          stdoutData += chunk.toString("utf8");
          if (stdoutData.includes("kanthord: ready\n")) {
            clearTimeout(timeout);
            child.stdout!.off("data", check);
            resolve();
          }
        };

        child.stdout!.on("data", check);

        child.on("exit", () => {
          clearTimeout(timeout);
          child.stdout!.off("data", check);
          reject(
            new Error(
              `daemon exited before ready\ncode: ${exitRecord?.code}\nsignal: ${exitRecord?.signal}\nstderr: ${stderrData}`,
            ),
          );
        });
      });
    },
    exited() {
      if (exitRecord) return Promise.resolve(exitRecord);
      return exitPromise;
    },
    stdout() {
      return stdoutData;
    },
    stderr() {
      return stderrData;
    },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      child.kill(signal);
    },
  };
}

export async function killAll(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const child of [...running]) {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
    promises.push(
      new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
      }),
    );
  }
  await Promise.all(promises);
  running.length = 0;
}

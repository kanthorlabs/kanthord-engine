import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { RecoveryError } from "../../domain/recovery.ts";
import type {
  ChildInspection,
  InspectChildInput,
  StopChildInput,
} from "./index.ts";
import { assertSignallable, spawnSupervised } from "./launcher.ts";

export const PS_CANDIDATES = ["/bin/ps", "/usr/bin/ps"] as const;
export const SUPPORTED_PLATFORMS = ["darwin", "linux"] as const;

export const PROCESS_START_READ_TIMEOUT_MS = 10_000;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const LSTART_PATTERN =
  /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

export function resolvePs(platform: string): string {
  if (!(SUPPORTED_PLATFORMS as readonly string[]).includes(platform)) {
    throw new RecoveryError(
      "platform-unsupported",
      `${platform} is not a supported platform for startup recovery`,
    );
  }
  for (const candidate of PS_CANDIDATES) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // the next candidate is tried
    }
  }
  throw new RecoveryError(
    "platform-unsupported",
    "no ps executable was found at /bin/ps or /usr/bin/ps",
  );
}

export function parseLstart(text: string): number | null {
  const match = LSTART_PATTERN.exec(text.trim());
  if (match === null) {
    return null;
  }
  const monthIndex = (MONTHS as readonly string[]).indexOf(match[1] ?? "");
  if (monthIndex === -1) {
    return null;
  }
  const day = Number(match[2]);
  const hour = Number(match[3]);
  const minute = Number(match[4]);
  const second = Number(match[5]);
  const year = Number(match[6]);
  return Date.UTC(year, monthIndex, day, hour, minute, second) / 1000;
}

export async function inspectChild(
  input: InspectChildInput,
): Promise<ChildInspection> {
  let stat;
  try {
    stat = lstatSync(input.pidFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { finding: "no-pid-file" };
    }
    return {
      finding: "pid-file-unreadable",
      detail: `${input.pidFile} is not a regular file`,
    };
  }
  if (!stat.isFile()) {
    return {
      finding: "pid-file-unreadable",
      detail: `${input.pidFile} is not a regular file`,
    };
  }
  const recordedAt = Math.floor(stat.mtimeMs / 1000);

  let content: string;
  try {
    content = readFileSync(input.pidFile, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { finding: "no-pid-file" };
    }
    return {
      finding: "pid-file-unreadable",
      detail: `${input.pidFile} is not readable`,
    };
  }

  let pid: number;
  try {
    pid = Number(content);
    assertSignallable(pid);
  } catch {
    return {
      finding: "pid-file-unreadable",
      detail: `${content} is not a signallable pid`,
    };
  }

  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return { finding: "process-absent", pid };
    }
    if (code === "EPERM") {
      return {
        finding: "liveness-unknown",
        pid,
        detail: "the process is not signallable by this user",
      };
    }
    return {
      finding: "liveness-unknown",
      pid,
      detail: "the process could not be inspected",
    };
  }

  const startSeconds = await readProcessStartSeconds(input.pidFile, pid);
  if (startSeconds === null) {
    return {
      finding: "liveness-unknown",
      pid,
      detail: "the process start time could not be read",
    };
  }
  if (startSeconds > recordedAt) {
    return {
      finding: "started-later",
      pid,
      startedAt: startSeconds,
      recordedAt,
    };
  }
  return { finding: "alive", pid, pidFile: input.pidFile };
}

async function readProcessStartSeconds(
  pidFile: string,
  pid: number,
): Promise<number | null> {
  const directory = dirname(pidFile);
  const ps = resolvePs(process.platform);
  const scratch = join(directory, `ps-${randomUUID()}.pid`);

  const child = spawnSupervised({
    command: ps,
    args: ["-o", "lstart=", "-p", String(pid)],
    env: { PATH: "", LC_ALL: "C", TZ: "UTC" },
    cwd: directory,
    pidFile: scratch,
  });

  let timedOut = false;
  let killError: unknown;

  try {
    if (child.pid === undefined) {
      try {
        await child.exited;
      } catch {
        // the ps command never started; report the unreadable start time
      }
      return null;
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.signalGroup("SIGKILL");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && code !== "EPERM") {
          killError ??= error;
        }
      }
    }, PROCESS_START_READ_TIMEOUT_MS);
    timeoutTimer.unref();

    try {
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      const { code } = await child.exited;
      if (killError !== undefined) {
        throw killError;
      }
      if (timedOut) {
        return null;
      }
      if (code !== 0) {
        return null;
      }
      return parseLstart(Buffer.concat(chunks).toString("utf8"));
    } finally {
      clearTimeout(timeoutTimer);
    }
  } finally {
    rmSync(scratch, { force: true });
  }
}

export async function stopChild(input: StopChildInput): Promise<boolean> {
  assertSignallable(input.pid);
  const pollMs = input.pollMs ?? 50;
  try {
    process.kill(-input.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return true;
    }
    throw error;
  }
  if (await groupGone(input.pid, input.graceMs, pollMs)) {
    return true;
  }
  try {
    process.kill(-input.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return true;
    }
    throw error;
  }
  return groupGone(input.pid, input.graceMs, pollMs);
}

async function groupGone(
  pid: number,
  graceMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupExists(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !groupExists(pid);
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    return true;
  }
}

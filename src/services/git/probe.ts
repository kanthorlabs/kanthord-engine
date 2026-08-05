import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { GitPaths } from "./index.ts";
import { spawnSupervised } from "./launcher.ts";

export const MINIMUM_GIT_VERSION = "2.34.0";
export const PROBE_TIMEOUT_MS = 10_000;

export type ProbeToolName = "git" | "ssh" | "sshKeyscan";

export type ProbeErrorCode =
  "tool-missing" | "tool-unreadable" | "tool-too-old";

export class ToolProbeError extends Error {
  readonly code: ProbeErrorCode;
  readonly tool: ProbeToolName;
  constructor(code: ProbeErrorCode, tool: ProbeToolName, message: string) {
    super(message);
    this.name = "ToolProbeError";
    this.code = code;
    this.tool = tool;
  }
}

export type ProbedTools = Readonly<{
  git: string;
  ssh: string;
  sshKeyscan: string;
  gitVersion: string;
  sshVersion: string;
}>;

export type ProbeInput = Readonly<{
  tools: Readonly<{ git: string; ssh: string; sshKeyscan: string }>;
  runDirectory: string;
  timeoutMs?: number;
}>;

export function parseGitVersion(text: string): string | null {
  const match = /^git version (\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) {
    return null;
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export function parseSshVersion(text: string): string | null {
  const match = /^OpenSSH_([^,\s]+)/.exec(text);
  if (match === null) {
    return null;
  }
  return match[1] ?? null;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number(part));
  const rightParts = right.split(".").map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart < rightPart) {
      return -1;
    }
    if (leftPart > rightPart) {
      return 1;
    }
  }
  return 0;
}

export async function probeTools(input: ProbeInput): Promise<ProbedTools> {
  mkdirSync(input.runDirectory, { recursive: true, mode: 0o700 });

  for (const tool of ["git", "ssh", "sshKeyscan"] as const) {
    const toolPath = input.tools[tool];
    try {
      accessSync(toolPath, constants.X_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ToolProbeError(
          "tool-missing",
          tool,
          `${toolPath} does not exist`,
        );
      }
      throw new ToolProbeError(
        "tool-unreadable",
        tool,
        `${toolPath} is not executable`,
      );
    }
  }

  const gitVersion = await runVersionProbe(
    input,
    "git",
    ["--version"],
    "stdout",
  );
  const sshVersion = await runVersionProbe(input, "ssh", ["-V"], "stderr");

  if (compareVersions(gitVersion, MINIMUM_GIT_VERSION) < 0) {
    throw new ToolProbeError(
      "tool-too-old",
      "git",
      `${input.tools.git} is git ${gitVersion}; kanthord needs ${MINIMUM_GIT_VERSION} or newer`,
    );
  }

  return {
    git: input.tools.git,
    ssh: input.tools.ssh,
    sshKeyscan: input.tools.sshKeyscan,
    gitVersion,
    sshVersion,
  };
}

async function runVersionProbe(
  input: ProbeInput,
  tool: "git" | "ssh",
  args: readonly string[],
  stream: "stdout" | "stderr",
): Promise<string> {
  const toolPath = input.tools[tool];
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  const pidFile = join(input.runDirectory, `probe-${randomUUID()}.pid`);

  const child = spawnSupervised({
    command: toolPath,
    args,
    env: { PATH: "", LC_ALL: "C" },
    cwd: input.runDirectory,
    pidFile,
  });

  let timedOut = false;
  let killError: unknown;

  try {
    if (child.pid === undefined) {
      try {
        await child.exited;
      } catch {
        // the child never started; fall through to the unreadable report
      }
      throw new ToolProbeError(
        "tool-unreadable",
        tool,
        `${toolPath} did not start`,
      );
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
    }, timeoutMs);
    timeoutTimer.unref();

    try {
      const chunks: Buffer[] = [];
      child[stream].on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      await child.exited;
      if (killError !== undefined) {
        throw killError;
      }
      if (timedOut) {
        throw new ToolProbeError(
          "tool-unreadable",
          tool,
          `${toolPath} did not answer a version within ${PROBE_TIMEOUT_MS}ms`,
        );
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const version =
        tool === "git" ? parseGitVersion(text) : parseSshVersion(text);
      if (version === null) {
        throw new ToolProbeError(
          "tool-unreadable",
          tool,
          `${toolPath} reported no recognisable version`,
        );
      }
      return version;
    } finally {
      clearTimeout(timeoutTimer);
    }
  } finally {
    rmSync(pidFile, { force: true });
  }
}

export type BuildGitPathsInput = Readonly<{
  probed: ProbedTools;
  home: string;
}>;

export function buildGitPaths(input: BuildGitPathsInput): GitPaths {
  const home = join(input.home, "git", "home");
  const keyDirectory = join(input.home, "git", "keys");
  const knownHosts = join(input.home, "git", "known_hosts");
  const runDirectory = join(input.home, "git", "run");

  for (const directory of [home, keyDirectory, runDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(knownHosts)) {
    writeFileSync(knownHosts, "", { mode: 0o600 });
  }

  return {
    git: input.probed.git,
    ssh: input.probed.ssh,
    sshKeyscan: input.probed.sshKeyscan,
    home,
    keyDirectory,
    knownHosts,
    runDirectory,
  };
}

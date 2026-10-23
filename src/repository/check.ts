import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "../kernel/context.ts";
import { Diagnostic } from "../kernel/errors.ts";

const GIT_MIN_MAJOR = 2;
const GIT_MIN_MINOR = 40;
const SSH_MIN_MAJOR = 9;
const SSH_MIN_MINOR = 0;
const ENOENT_CODE = "ENOENT";
const EXIT_SUCCESS = 0;
const USAGE_OPTION = "-?";
const PRESENCE_TIMEOUT_MS = 5000;
const execFileAsync = promisify(execFile);

export const CheckErrorCode = {
  ToolMissing: "repository.connector.tool_missing",
  ToolVersion: "repository.connector.tool_version",
} as const;

function runTool(
  cmd: string,
  args: string[],
): { stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === ENOENT_CODE) {
      throw new Diagnostic(CheckErrorCode.ToolMissing, "tool not found", {
        fields: [["tool", cmd]],
      });
    }
    throw new Diagnostic(CheckErrorCode.ToolMissing, "tool spawn failed", {
      fields: [["tool", cmd]],
    });
  }
  if (result.status !== EXIT_SUCCESS || result.signal !== null) {
    throw new Diagnostic(
      CheckErrorCode.ToolMissing,
      "tool exited with an error",
      {
        fields: [
          ["tool", cmd],
          ["exit_status", result.status],
        ],
      },
    );
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function parseGitVersion(output: string): [number, number] {
  const match = /^git version (\d+)\.(\d+)/.exec(output);
  if (!match?.[1] || !match[2]) {
    throw new Diagnostic(
      CheckErrorCode.ToolMissing,
      "unrecognized version output",
      { fields: [["tool", "git"]] },
    );
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  if (
    major < GIT_MIN_MAJOR ||
    (major === GIT_MIN_MAJOR && minor < GIT_MIN_MINOR)
  ) {
    throw new Diagnostic(
      CheckErrorCode.ToolVersion,
      "tool version is below the minimum version",
      {
        fields: [
          ["tool", "git"],
          ["tool_version", `${major}.${minor}`],
          ["minimum_version", `${GIT_MIN_MAJOR}.${GIT_MIN_MINOR}`],
        ],
      },
    );
  }
  return [major, minor];
}

export function parseSshVersion(output: string): [number, number] {
  const match = /OpenSSH_(\d+)\.(\d+)/.exec(output);
  if (!match?.[1] || !match[2]) {
    throw new Diagnostic(
      CheckErrorCode.ToolMissing,
      "unrecognized version output",
      { fields: [["tool", "ssh"]] },
    );
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  if (
    major < SSH_MIN_MAJOR ||
    (major === SSH_MIN_MAJOR && minor < SSH_MIN_MINOR)
  ) {
    throw new Diagnostic(
      CheckErrorCode.ToolVersion,
      "tool version is below the minimum version",
      {
        fields: [
          ["tool", "ssh"],
          ["tool_version", `${major}.${minor}`],
          ["minimum_version", `${SSH_MIN_MAJOR}.${SSH_MIN_MINOR}`],
        ],
      },
    );
  }
  return [major, minor];
}

export function requireTool(
  cmd: string,
  timeoutMs: number = PRESENCE_TIMEOUT_MS,
): void {
  const result = spawnSync(cmd, [USAGE_OPTION], {
    env: process.env.PATH === undefined ? {} : { PATH: process.env.PATH },
    stdio: "ignore",
    timeout: timeoutMs,
  });
  if (!result.error) return;
  if ((result.error as NodeJS.ErrnoException).code === ENOENT_CODE)
    throw new Diagnostic(CheckErrorCode.ToolMissing, "tool not found", {
      fields: [["tool", cmd]],
    });
  throw new Diagnostic(CheckErrorCode.ToolMissing, "tool spawn failed", {
    fields: [["tool", cmd]],
  });
}

export function checkRepositoryTools(): void {
  runTool("bash", ["--version"]);
  parseGitVersion(runTool("git", ["--version"]).stdout);
  parseSshVersion(runTool("ssh", ["-V"]).stderr);
  requireTool("ssh-agent");
  requireTool("ssh-add");
}

export function checkServerRepositoryTools(): void {
  checkRepositoryTools();
  requireTool("ssh-keyscan");
}

export async function probeRepositoryTools(context: Context): Promise<boolean> {
  const { signal } = context;
  try {
    await execFileAsync("bash", ["--version"], { signal });
    const git = await execFileAsync("git", ["--version"], {
      signal,
    });
    parseGitVersion(git.stdout);
    const ssh = await execFileAsync("ssh", ["-V"], {
      signal,
    });
    parseSshVersion(ssh.stderr);
    return true;
  } catch {
    return false;
  }
}

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
      throw new Diagnostic(CheckErrorCode.ToolMissing, `${cmd}: not found`);
    }
    throw new Diagnostic(CheckErrorCode.ToolMissing, `${cmd}: spawn failed`);
  }
  if (result.status !== EXIT_SUCCESS || result.signal !== null) {
    throw new Diagnostic(
      CheckErrorCode.ToolMissing,
      `${cmd}: exited with status ${result.status}`,
    );
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function parseGitVersion(output: string): [number, number] {
  const match = /^git version (\d+)\.(\d+)/.exec(output);
  if (!match?.[1] || !match[2]) {
    throw new Diagnostic(
      CheckErrorCode.ToolMissing,
      "git: unrecognized version output",
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
      `git: version ${major}.${minor} is below 2.40`,
    );
  }
  return [major, minor];
}

export function parseSshVersion(output: string): [number, number] {
  const match = /OpenSSH_(\d+)\.(\d+)/.exec(output);
  if (!match?.[1] || !match[2]) {
    throw new Diagnostic(
      CheckErrorCode.ToolMissing,
      "ssh: unrecognized version output",
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
      `ssh: version ${major}.${minor} is below 9.0`,
    );
  }
  return [major, minor];
}

export function checkRepositoryTools(): void {
  runTool("bash", ["--version"]);
  parseGitVersion(runTool("git", ["--version"]).stdout);
  parseSshVersion(runTool("ssh", ["-V"]).stderr);
}

export async function probeRepositoryTools(context: Context): Promise<boolean> {
  const controller = new AbortController();
  const unsubscribe = context.onCancel(() => controller.abort());
  try {
    await execFileAsync("bash", ["--version"], { signal: controller.signal });
    const git = await execFileAsync("git", ["--version"], {
      signal: controller.signal,
    });
    parseGitVersion(git.stdout);
    const ssh = await execFileAsync("ssh", ["-V"], {
      signal: controller.signal,
    });
    parseSshVersion(ssh.stderr);
    return true;
  } catch {
    return false;
  } finally {
    unsubscribe();
  }
}

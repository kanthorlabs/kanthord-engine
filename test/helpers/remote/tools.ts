import { accessSync, constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync, type StdioOptions } from "node:child_process";

export type ToolName = "git" | "ssh" | "sshd" | "sshKeyscan" | "sshKeygen";

export type ToolPaths = Readonly<Record<ToolName, string>>;

export type Tools = Readonly<{
  paths: ToolPaths;
  gitVersion: string;
  sshVersion: string;
  execPath: string;
  httpBackend: string;
}>;

export class ToolError extends Error {
  readonly tool: ToolName;

  constructor(tool: ToolName, message: string) {
    super(message);
    this.name = "ToolError";
    this.tool = tool;
  }
}

export const toolEnvironmentNames: Readonly<Record<ToolName, string>> = {
  git: "KANTHORD_TEST_GIT",
  ssh: "KANTHORD_TEST_SSH",
  sshd: "KANTHORD_TEST_SSHD",
  sshKeyscan: "KANTHORD_TEST_SSH_KEYSCAN",
  sshKeygen: "KANTHORD_TEST_SSH_KEYGEN",
} as const;

export const toolDefaults: ToolPaths = {
  git: "/usr/bin/git",
  ssh: "/usr/bin/ssh",
  sshd: "/usr/sbin/sshd",
  sshKeyscan: "/usr/bin/ssh-keyscan",
  sshKeygen: "/usr/bin/ssh-keygen",
} as const;

export const minimumGitVersion = "2.34.0";

export const toolTimeoutMilliseconds = 10000;

const toolOrder: readonly ToolName[] = [
  "git",
  "ssh",
  "sshd",
  "sshKeyscan",
  "sshKeygen",
];

const spawnOptions = {
  encoding: "utf8" as const,
  env: {},
  timeout: toolTimeoutMilliseconds,
  killSignal: "SIGKILL" as const,
  maxBuffer: 8 * 1024 * 1024,
} as const;

const sshStdio: StdioOptions = ["ignore", "pipe", "pipe"];

function versionTriple(version: string): readonly [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version
    .split(".")
    .map((part) => Number(part));
  return [major, minor, patch];
}

function belowMinimum(version: string): boolean {
  const [major, minor, patch] = versionTriple(version);
  const [floorMajor, floorMinor, floorPatch] = versionTriple(minimumGitVersion);
  return (
    major < floorMajor ||
    (major === floorMajor && minor < floorMinor) ||
    (major === floorMajor && minor === floorMinor && patch < floorPatch)
  );
}

function probeStdout(name: ToolName, binary: string, args: string[]): string {
  const result = spawnSync(binary, args, spawnOptions);
  if (result.error !== undefined) {
    throw new ToolError(name, `${name} probe failed: ${result.error.message}`);
  }
  if (result.signal !== null) {
    throw new ToolError(
      name,
      `${name} probe was terminated by signal ${result.signal}`,
    );
  }
  if (result.status !== 0) {
    throw new ToolError(
      name,
      `${name} probe exited with status ${String(result.status)}`,
    );
  }
  return result.stdout;
}

export function resolveTools(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Tools {
  const paths: Record<ToolName, string> = {} as Record<ToolName, string>;
  for (const name of toolOrder) {
    const variable = toolEnvironmentNames[name];
    const configured = env[variable];
    const value =
      configured === undefined || configured === ""
        ? toolDefaults[name]
        : configured;
    if (!isAbsolute(value)) {
      throw new ToolError(name, `${name} path is not absolute: ${value}`);
    }
    try {
      accessSync(value, constants.X_OK);
    } catch {
      throw new ToolError(
        name,
        `${name} is missing or not executable at ${value}; set ${variable}`,
      );
    }
    paths[name] = value;
  }

  const gitRaw = probeStdout("git", paths.git, ["--version"]);
  const gitMatch = /^git version (\d+)\.(\d+)\.(\d+)/.exec(gitRaw);
  if (gitMatch === null) {
    throw new ToolError(
      "git",
      "git --version is unparseable: " + gitRaw.trim(),
    );
  }
  const gitVersion = `${gitMatch[1] ?? ""}.${gitMatch[2] ?? ""}.${gitMatch[3] ?? ""}`;
  if (belowMinimum(gitVersion)) {
    throw new ToolError(
      "git",
      `git ${gitVersion} is below the tested minimum ${minimumGitVersion}`,
    );
  }

  const sshResult = spawnSync(paths.ssh, ["-V"], {
    ...spawnOptions,
    stdio: sshStdio,
  });
  if (sshResult.error !== undefined) {
    throw new ToolError("ssh", `ssh probe failed: ${sshResult.error.message}`);
  }
  if (sshResult.signal !== null) {
    throw new ToolError(
      "ssh",
      `ssh probe was terminated by signal ${sshResult.signal}`,
    );
  }
  if (sshResult.status !== 0) {
    throw new ToolError(
      "ssh",
      `ssh probe exited with status ${String(sshResult.status)}`,
    );
  }
  const sshMatch = /^OpenSSH_(\S+)/.exec(sshResult.stderr);
  if (sshMatch === null) {
    throw new ToolError(
      "ssh",
      "ssh -V is unparseable: " + sshResult.stderr.trim(),
    );
  }
  const sshVersion = (sshMatch[1] ?? "").replace(/,$/, "");

  const execPath = probeStdout("git", paths.git, ["--exec-path"]).trim();
  const httpBackend = join(execPath, "git-http-backend");
  try {
    accessSync(httpBackend, constants.X_OK);
  } catch {
    throw new ToolError(
      "git",
      `git-http-backend is missing or not executable at ${httpBackend}`,
    );
  }

  return Object.freeze({
    paths: Object.freeze(paths),
    gitVersion,
    sshVersion,
    execPath,
    httpBackend,
  });
}

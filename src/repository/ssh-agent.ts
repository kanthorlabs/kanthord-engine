import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { throwIfCancelled, type Context } from "../kernel/context.ts";
import { Diagnostic } from "../kernel/errors.ts";
import { isolatedGitEnvironment } from "../kernel/git-environment.ts";

export interface SshAccess {
  private_key: string;
  public_key: string;
  known_hosts: string;
}

export const SshAgentErrorCode = {
  Failed: "repository.connector.ssh_agent_failed",
} as const;

export const SshAgentStep = {
  Directory: "directory",
  SocketPath: "socket_path",
  Files: "files",
  Agent: "agent",
  Load: "load",
} as const;
export type SshAgentStep = (typeof SshAgentStep)[keyof typeof SshAgentStep];

export const SSH_AGENT_DIRECTORY_PREFIX = "kd-ssh-";
export const SSH_AGENT_SOCKET = "a";
export const SSH_PUBLIC_KEY_FILE = "id.pub";
export const SSH_KNOWN_HOSTS_FILE = "known_hosts";
export const SOCKET_PATH_BYTES_MAX = 100;
export const SWEEP_GRACE_MS = 60_000;
export const DEADLINE_RADIX = 36;

const SWEEP_PATTERN = /^kd-ssh-([0-9a-z]+)-/;
const SAFE_PATH = /^[A-Za-z0-9/._-]+$/;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const PERMISSION_BITS = 0o777;
const CREATE_EXCLUSIVE = "wx";
const SINGLE_QUOTE = "'";
const SOCKET_WAIT_MS_MAX = 5000;
const SOCKET_POLL_MS = 10;
const CLEANUP_TIMEOUT_MS = 5000;
const MS_PER_SECOND = 1000;
const KEY_LIFETIME_SECONDS_MIN = 1;
const EXIT_SUCCESS = 0;
const execFileAsync = promisify(execFile);

interface Agent {
  child: ChildProcess;
  closed: Promise<void>;
  stderr: () => string;
}

function agentFailure(step: SshAgentStep, detail: string): Diagnostic {
  return new Diagnostic(
    SshAgentErrorCode.Failed,
    `${step}: SSH agent failed.`,
    {
      fields: [["step", step]],
      cause: new Error(`${step}: ${detail.trim()}`),
    },
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quoted(path: string): string {
  return `${SINGLE_QUOTE}${path}${SINGLE_QUOTE}`;
}

function toolEnvironment(socket?: string): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(socket === undefined ? {} : { SSH_AUTH_SOCK: socket }),
  };
}

export function sshCommand(directory: string): string {
  assert.ok(directory);
  return [
    "ssh -F none",
    "-o IdentitiesOnly=yes",
    `-o IdentityFile=${quoted(join(directory, SSH_PUBLIC_KEY_FILE))}`,
    `-o IdentityAgent=${quoted(join(directory, SSH_AGENT_SOCKET))}`,
    `-o UserKnownHostsFile=${quoted(join(directory, SSH_KNOWN_HOSTS_FILE))}`,
    "-o GlobalKnownHostsFile=/dev/null",
    "-o StrictHostKeyChecking=yes",
    "-o UpdateHostKeys=no",
    "-o BatchMode=yes",
    "-o ForwardAgent=no",
    "-o ControlMaster=no",
    "-o ControlPath=none",
    "-o PreferredAuthentications=publickey",
  ].join(" ");
}

export function sshAgentEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    ...isolatedGitEnvironment(process.env),
    GIT_SSH_VARIANT: "ssh",
    GIT_SSH_COMMAND: sshCommand(directory),
  };
}

export async function sweepSshAgentDirectories(now: number): Promise<void> {
  const root = tmpdir();
  const uid = process.getuid?.();
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names) {
    const match = SWEEP_PATTERN.exec(name);
    if (!match?.[1]) continue;
    const deadlineAt = Number.parseInt(match[1], DEADLINE_RADIX);
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt + SWEEP_GRACE_MS >= now)
      continue;
    const path = join(root, name);
    const info = await lstat(path).catch(() => null);
    if (!info?.isDirectory() || info.uid !== uid) continue;
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}

async function createDirectory(deadlineAt: number): Promise<string> {
  const prefix = `${SSH_AGENT_DIRECTORY_PREFIX}${deadlineAt.toString(DEADLINE_RADIX)}-`;
  try {
    return await mkdtemp(join(tmpdir(), prefix));
  } catch (error) {
    throw agentFailure(SshAgentStep.Directory, errorText(error));
  }
}

async function assertPrivate(directory: string): Promise<void> {
  const info = await stat(directory);
  if ((info.mode & PERMISSION_BITS) !== DIRECTORY_MODE)
    throw agentFailure(SshAgentStep.Directory, "The directory is not private.");
}

function assertSocketPath(socket: string): void {
  if (Buffer.byteLength(socket, "utf8") > SOCKET_PATH_BYTES_MAX)
    throw agentFailure(SshAgentStep.SocketPath, "The socket path is too long.");
  if (!SAFE_PATH.test(socket))
    throw agentFailure(
      SshAgentStep.SocketPath,
      "The socket path holds an unsafe character.",
    );
}

async function writeFiles(directory: string, access: SshAccess): Promise<void> {
  try {
    await writeFile(join(directory, SSH_PUBLIC_KEY_FILE), access.public_key, {
      mode: FILE_MODE,
      flag: CREATE_EXCLUSIVE,
    });
    await writeFile(join(directory, SSH_KNOWN_HOSTS_FILE), access.known_hosts, {
      mode: FILE_MODE,
      flag: CREATE_EXCLUSIVE,
    });
  } catch (error) {
    throw agentFailure(SshAgentStep.Files, errorText(error));
  }
}

function spawnAgent(socket: string): Agent {
  const child = spawn("ssh-agent", ["-a", socket, "cat"], {
    env: toolEnvironment(),
    stdio: ["pipe", "ignore", "pipe"],
  });
  const chunks: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stdin?.on("error", () => {});
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", (error) => {
      chunks.push(Buffer.from(errorText(error)));
      resolve();
    });
  });
  return {
    child,
    closed,
    stderr: () => Buffer.concat(chunks).toString("utf8"),
  };
}

async function socketExists(socket: string): Promise<boolean> {
  const info = await stat(socket).catch(() => null);
  return info?.isSocket() ?? false;
}

async function waitForSocket(
  agent: Agent,
  socket: string,
  deadlineAt: number,
): Promise<void> {
  const until = Math.min(deadlineAt, Date.now() + SOCKET_WAIT_MS_MAX);
  let exited = false;
  void agent.closed.then(() => {
    exited = true;
  });
  while (Date.now() < until && !exited) {
    if (await socketExists(socket)) return;
    await delay(SOCKET_POLL_MS);
  }
  if (await socketExists(socket)) return;
  throw agentFailure(
    SshAgentStep.Agent,
    agent.stderr() || "The SSH agent socket did not appear.",
  );
}

function keyLifetimeSeconds(deadlineAt: number): number {
  return Math.max(
    KEY_LIFETIME_SECONDS_MIN,
    Math.ceil((deadlineAt - Date.now()) / MS_PER_SECOND),
  );
}

async function loadKey(
  socket: string,
  privateKey: string,
  deadlineAt: number,
): Promise<void> {
  const seconds = keyLifetimeSeconds(deadlineAt);
  const key = Buffer.from(privateKey, "utf8");
  try {
    const child = spawn("ssh-add", ["-q", "-t", String(seconds), "-"], {
      env: toolEnvironment(socket),
      stdio: ["pipe", "ignore", "pipe"],
      timeout: seconds * MS_PER_SECOND,
    });
    const chunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stdin.on("error", () => {});
    const status = new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
      child.once("error", (error) => {
        chunks.push(Buffer.from(errorText(error)));
        resolve(null);
      });
    });
    child.stdin.write(key, () => key.fill(0));
    child.stdin.end();
    if ((await status) !== EXIT_SUCCESS)
      throw agentFailure(
        SshAgentStep.Load,
        Buffer.concat(chunks).toString("utf8") || "ssh-add failed.",
      );
  } finally {
    key.fill(0);
  }
}

async function stopAgent(agent: Agent, socket: string): Promise<void> {
  await execFileAsync("ssh-add", ["-q", "-D"], {
    env: toolEnvironment(socket),
    timeout: CLEANUP_TIMEOUT_MS,
  }).catch(() => {});
  agent.child.stdin?.end();
  await agent.closed;
}

export async function withSshAgent<T>(
  access: SshAccess,
  context: Context,
  deadlineMs: number,
  work: (environment: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  assert.ok(access.private_key);
  assert.ok(access.public_key);
  throwIfCancelled(context);
  const deadlineAt = Date.now() + deadlineMs;
  await sweepSshAgentDirectories(Date.now());
  const directory = await createDirectory(deadlineAt);
  const socket = join(directory, SSH_AGENT_SOCKET);
  let agent: Agent | undefined;
  try {
    await assertPrivate(directory);
    assertSocketPath(socket);
    await writeFiles(directory, access);
    throwIfCancelled(context);
    agent = spawnAgent(socket);
    await waitForSocket(agent, socket, deadlineAt);
    throwIfCancelled(context);
    await loadKey(socket, access.private_key, deadlineAt);
    throwIfCancelled(context);
    return await work(sshAgentEnvironment(directory));
  } finally {
    if (agent) await stopAgent(agent, socket);
    await rm(directory, { recursive: true, force: true });
  }
}

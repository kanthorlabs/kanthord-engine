import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { type Context } from "../kernel/context.ts";
import { Diagnostic } from "../kernel/errors.ts";
import { isolatedGitEnvironment } from "../kernel/git-environment.ts";
import {
  SSH_AGENT_CLEANUP_TIMEOUT_MS,
  type SshAccess,
  type SshRelayAccess,
} from "./contract.ts";
import { serveRelayAgent, type RelayAgent } from "./ssh-relay-agent.ts";

export type {
  SshAccess,
  SshKeyAccess,
  SshRelayAccess,
  SshSigner,
} from "./contract.ts";

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
const AGENT_SCRIPT =
  'exec 3<&0; ssh-agent -D -a "$1" & agent=$!; { cat; kill 0; } <&3 2>/dev/null & wait "$agent"';
const SOCKET_POLL_MS = 10;
const SOCKET_PROBE_TIMEOUT_MS = 1000;
const MS_PER_SECOND = 1000;
const KEY_LIFETIME_SECONDS_MIN = 1;
const EXIT_SUCCESS = 0;
const PORT_MIN = 1;
const PORT_MAX = 65_535;
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

export function sshCommand(directory: string, port: number): string {
  assert.ok(directory);
  assert.ok(Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX);
  return [
    "ssh -F none",
    `-o Port=${port}`,
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

export function sshAgentEnvironment(
  directory: string,
  port: number,
): NodeJS.ProcessEnv {
  return {
    ...isolatedGitEnvironment(process.env),
    GIT_SSH_VARIANT: "ssh",
    GIT_SSH_COMMAND: sshCommand(directory, port),
  };
}

function socketAccepts(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = connect(socket);
    const settle = (accepted: boolean) => {
      client.destroy();
      resolve(accepted);
    };
    client.setTimeout(SOCKET_PROBE_TIMEOUT_MS, () => settle(false));
    client.once("connect", () => settle(true));
    client.once("error", () => settle(false));
  });
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
    if (await socketAccepts(join(path, SSH_AGENT_SOCKET))) continue;
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
  const child = spawn("sh", ["-c", AGENT_SCRIPT, "sh", socket], {
    env: toolEnvironment(),
    stdio: ["pipe", "ignore", "pipe"],
    detached: true,
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
  context: Context,
  deadlineAt: number,
): Promise<void> {
  let exited = false;
  void agent.closed.then(() => {
    exited = true;
  });
  while (Date.now() < deadlineAt && !exited && !context.signal.aborted) {
    if (await socketExists(socket)) return;
    await delay(SOCKET_POLL_MS);
  }
  context.signal.throwIfAborted();
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

async function startRelayAgent(
  socket: string,
  access: SshRelayAccess,
  context: Context,
): Promise<RelayAgent> {
  try {
    return await serveRelayAgent(socket, access, context);
  } catch (error) {
    throw agentFailure(SshAgentStep.Agent, errorText(error));
  }
}

async function stopAgent(agent: Agent, socket: string): Promise<void> {
  await execFileAsync("ssh-add", ["-q", "-D"], {
    env: toolEnvironment(socket),
    timeout: SSH_AGENT_CLEANUP_TIMEOUT_MS,
  }).catch(() => {});
  agent.child.stdin?.end();
  await agent.closed;
}

export async function withSshAgent<T>(
  access: SshAccess,
  context: Context,
  deadlineMs: number,
  work: (
    environment: NodeJS.ProcessEnv,
    relayError: () => Error | null,
  ) => Promise<T>,
): Promise<T> {
  assert.ok("relay" in access || access.private_key);
  assert.ok(access.public_key);
  context.signal.throwIfAborted();
  const deadlineAt = Date.now() + deadlineMs;
  await sweepSshAgentDirectories(Date.now());
  const directory = await createDirectory(deadlineAt);
  const socket = join(directory, SSH_AGENT_SOCKET);
  let agent: Agent | undefined;
  let relay: RelayAgent | undefined;
  try {
    await assertPrivate(directory);
    assertSocketPath(socket);
    await writeFiles(directory, access);
    context.signal.throwIfAborted();
    if ("relay" in access)
      relay = await startRelayAgent(socket, access, context);
    else {
      agent = spawnAgent(socket);
      await waitForSocket(agent, socket, context, deadlineAt);
      context.signal.throwIfAborted();
      await loadKey(socket, access.private_key, deadlineAt);
    }
    context.signal.throwIfAborted();
    return await work(
      sshAgentEnvironment(directory, access.port),
      () => relay?.lastError() ?? null,
    );
  } finally {
    if (agent) await stopAgent(agent, socket);
    await relay?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

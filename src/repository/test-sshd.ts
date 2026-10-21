import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { connect, createServer, type AddressInfo } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { isolatedGitEnvironment } from "../kernel/git-environment.ts";
import { temporary } from "../kernel/test-support.ts";
import type { SshAccess } from "./ssh-agent.ts";
import { SSH_SIGN_USER } from "./contract.ts";
import {
  generateSshKey,
  SSH_KEY_TYPE,
  SshReader,
  SshWriter,
  sshPublicKeyBlob,
} from "./ssh-key.ts";
import {
  relayedSignature,
  SSH_CONNECTION_SERVICE,
  SSH_USERAUTH_REQUEST,
  SshAuthenticationMethod,
} from "./ssh-sign.ts";

export { relayedSignature };

export const TEST_SSHD_HOST = "127.0.0.1";
export const DEFAULT_SSH_PORT = 22;
export const TEST_REPOSITORY_FILE = "README.md";
export const TEST_REPOSITORY_TEXT = "kanthord ssh test\n";
const LOCAL_GIT_KEY = generateSshKey("local-git");
export const LOCAL_GIT_SSH_ACCESS: SshAccess = {
  private_key: LOCAL_GIT_KEY.private_key,
  public_key: LOCAL_GIT_KEY.public_key,
  known_hosts: "",
  port: DEFAULT_SSH_PORT,
};

const SSHD_PATHS = [
  "/usr/sbin/sshd",
  "/usr/local/sbin/sshd",
  "/opt/homebrew/sbin/sshd",
];
const READY_POLL_MS = 50;
const BANNER_PREFIX = "SSH-";
const HOST_KEY_FILE = "host_ed25519";
const LINE_END = "\n";
const FIELD_SEPARATOR = " ";
const PUBLIC_KEY_FIELDS = 2;
const STRING_TYPE = "string";
const execFileAsync = promisify(execFile);
const SESSION_ID_BYTES = 32;
const HAS_SIGNATURE = 1;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface TestSshd {
  user: string;
  port: number;
  known_hosts: string;
  authorize(public_key: string): Promise<void>;
  url(repository: string): string;
  scpUrl(repository: string): string;
}

function sshdPath(): string {
  const path = SSHD_PATHS.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  assert.ok(path, "The sshd test helper requires sshd.");
  return path;
}

function toolEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) =>
    server.listen(0, TEST_SSHD_HOST, resolve),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address !== STRING_TYPE);
  const { port } = address as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function banner(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, TEST_SSHD_HOST);
    socket.once("data", (data) => {
      socket.destroy();
      resolve(data.toString("latin1").startsWith(BANNER_PREFIX));
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitReady(port: number, exited: () => boolean): Promise<void> {
  while (!exited()) {
    if (await banner(port)) return;
    await delay(READY_POLL_MS);
  }
  assert.fail("The test sshd did not start.");
}

export async function hostKeyLine(path: string, port: number): Promise<string> {
  const fields = (await readFile(path, "utf8")).trim().split(FIELD_SEPARATOR);
  const key = fields.slice(0, PUBLIC_KEY_FIELDS).join(FIELD_SEPARATOR);
  return `[${TEST_SSHD_HOST}]:${port} ${key}${LINE_END}`;
}

export async function startTestSshd(t: TestContext): Promise<TestSshd> {
  const root = temporary(t);
  const port = await freePort();
  const hostKey = join(root, HOST_KEY_FILE);
  const authorizedKeys = join(root, "authorized_keys");
  const config = join(root, "sshd_config");
  await execFileAsync(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", hostKey],
    { env: toolEnvironment() },
  );
  await writeFile(authorizedKeys, "", { mode: 0o600 });
  await writeFile(
    config,
    [
      `ListenAddress ${TEST_SSHD_HOST}`,
      `HostKey ${hostKey}`,
      `PidFile ${join(root, "sshd.pid")}`,
      `AuthorizedKeysFile ${authorizedKeys}`,
      "UsePAM no",
      "StrictModes no",
      "PubkeyAuthentication yes",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PermitRootLogin prohibit-password",
      "LogLevel ERROR",
      "",
    ].join(LINE_END),
    { mode: 0o600 },
  );
  const sshd = spawn(sshdPath(), ["-D", "-e", "-f", config, "-p", `${port}`], {
    env: toolEnvironment(),
    stdio: ["ignore", "ignore", "ignore"],
  });
  let exited = false;
  const closed = new Promise<void>((resolve) => {
    sshd.once("close", () => {
      exited = true;
      resolve();
    });
    sshd.once("error", () => {
      exited = true;
      resolve();
    });
  });
  t.after(async () => {
    sshd.kill();
    await closed;
  });
  await waitReady(port, () => exited);
  const user = userInfo().username;
  return {
    user,
    port,
    known_hosts: await hostKeyLine(`${hostKey}.pub`, port),
    authorize: (public_key) =>
      appendFile(authorizedKeys, `${public_key.trim()}${LINE_END}`),
    url: (repository) => `ssh://${user}@${TEST_SSHD_HOST}:${port}${repository}`,
    scpUrl: (repository) => `${user}@${TEST_SSHD_HOST}:${repository}`,
  };
}

export async function createBareRepository(t: TestContext): Promise<string> {
  const root = temporary(t);
  const work = join(root, "work");
  const bare = join(root, "origin.git");
  const env = isolatedGitEnvironment(process.env);
  await execFileAsync("git", ["init", "-q", "-b", "main", work], { env });
  await writeFile(join(work, TEST_REPOSITORY_FILE), TEST_REPOSITORY_TEXT);
  await execFileAsync("git", ["add", TEST_REPOSITORY_FILE], { cwd: work, env });
  await execFileAsync("git", ["commit", "-q", "-m", "initial"], {
    cwd: work,
    env,
  });
  await execFileAsync("git", ["clone", "-q", "--bare", work, bare], { env });
  return bare;
}

export interface UserAuthenticationInput {
  key: Buffer;
  hostKey?: Buffer | null;
  user?: string;
  service?: string;
  method?: string;
  algorithm?: string;
  signature?: number;
  trailing?: Buffer;
}

export function userAuthenticationData(input: UserAuthenticationInput): Buffer {
  const hostKey = input.hostKey ?? null;
  const writer = new SshWriter()
    .bytes(randomBytes(SESSION_ID_BYTES))
    .byte(SSH_USERAUTH_REQUEST)
    .text(input.user ?? SSH_SIGN_USER)
    .text(input.service ?? SSH_CONNECTION_SERVICE)
    .text(
      input.method ??
        (hostKey === null
          ? SshAuthenticationMethod.PublicKey
          : SshAuthenticationMethod.HostBound),
    )
    .byte(input.signature ?? HAS_SIGNATURE)
    .text(input.algorithm ?? SSH_KEY_TYPE)
    .bytes(input.key);
  if (hostKey !== null) writer.bytes(hostKey);
  if (input.trailing) writer.raw(input.trailing);
  return writer.build();
}

export function knownHostsKeyBlob(knownHosts: string): Buffer {
  const fields = knownHosts.trim().split(FIELD_SEPARATOR);
  return Buffer.from(fields.at(-1)!, "base64");
}

export function sshSignatureVerifies(
  public_key: string,
  data: Buffer,
  signature: Buffer,
): boolean {
  const reader = new SshReader(signature);
  if (reader.text() !== SSH_KEY_TYPE) return false;
  const raw = reader.bytes();
  const blob = new SshReader(sshPublicKeyBlob(public_key));
  blob.text();
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, blob.bytes()]),
    format: "der",
    type: "spki",
  });
  return verify(null, data, key, raw);
}

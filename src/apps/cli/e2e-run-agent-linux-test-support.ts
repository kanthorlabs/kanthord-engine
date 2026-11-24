import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import {
  BIN_PATH,
  cliEnvironment,
  runAgentArguments,
} from "./e2e-run-agent-test-support.ts";
import type {
  AgentFixtures,
  CliResult,
  RunOptions,
} from "./e2e-run-agent-test-support.ts";

const execFileAsync = promisify(execFile);

export const TEST_USER = "kanthord-e2e";
export const TEST_USER_HOME = "/home/kanthord-e2e";

const NFT_TABLE = "kanthord";
const NFT_SET = "connections";
const SUCCESS_EXIT = 0;
const WRITE_SCRIPT =
  'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1" && chmod 0600 "$1"';
const DIRECTORY_SCRIPT = 'umask 077 && mkdir -p "$1"';
const WORKSPACE_SCRIPT = [
  'umask 077 && git init -q -b main "$1"',
  'printf workspace > "$1/README.md"',
  'git -C "$1" add .',
  'git -C "$1" -c user.name=Test -c user.email=test@example.invalid commit -q -m init',
].join(" && ");

export interface TestUserStart {
  args: string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  cwd?: string;
  stdin?: string;
}

export interface NftConnection {
  address: string;
  port: number;
}

interface NftElement {
  concat: [string, number];
}

interface NftSet {
  elem?: NftElement[];
}

interface NftObject {
  set?: NftSet;
}

interface NftListing {
  nftables: NftObject[];
}

function assignments(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    value === undefined ? [] : [`${name}=${value}`],
  );
}

export async function spawnBinAsTestUser(
  start: TestUserStart,
): Promise<CliResult> {
  const child = spawn(
    "sudo",
    [
      "-n",
      "-u",
      TEST_USER,
      "env",
      "-i",
      ...assignments(start.env),
      process.execPath,
      BIN_PATH,
      ...start.args,
    ],
    { signal: start.signal, cwd: start.cwd },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(start.stdin);
  const [status] = (await once(child, "close")) as [number | null];
  return { status, stdout, stderr };
}

export async function spawnCliAsTestUser(
  fixtures: AgentFixtures,
  options: RunOptions,
  stdin?: string,
): Promise<CliResult> {
  return spawnBinAsTestUser({
    args: runAgentArguments(fixtures, options),
    env: cliEnvironment(fixtures, options),
    signal: options.signal,
    cwd: options.cwd,
    stdin,
  });
}

export async function writeFileAsTestUser(
  path: string,
  content: string,
): Promise<void> {
  const child = spawn(
    "sudo",
    ["-n", "-u", TEST_USER, "sh", "-c", WRITE_SCRIPT, "sh", path],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
  child.stdin?.end(content);
  const [status] = (await once(child, "close")) as [number | null];
  assert.equal(status, SUCCESS_EXIT);
}

function shellAsTestUser(script: string, path: string): Promise<unknown> {
  return execFileAsync("sudo", [
    "-n",
    "-u",
    TEST_USER,
    "sh",
    "-c",
    script,
    "sh",
    path,
  ]);
}

export async function mkdirAsTestUser(path: string): Promise<void> {
  await shellAsTestUser(DIRECTORY_SCRIPT, path);
}

export async function buildWorkspaceAsTestUser(path: string): Promise<void> {
  await shellAsTestUser(WORKSPACE_SCRIPT, path);
}

export async function flushNftConnections(): Promise<void> {
  await execFileAsync("sudo", [
    "-n",
    "nft",
    "flush",
    "set",
    "ip",
    NFT_TABLE,
    NFT_SET,
  ]);
}

export async function nftConnections(): Promise<NftConnection[]> {
  const { stdout } = await execFileAsync("sudo", [
    "-n",
    "nft",
    "-n",
    "-j",
    "list",
    "set",
    "ip",
    NFT_TABLE,
    NFT_SET,
  ]);
  const listing = JSON.parse(stdout) as NftListing;
  return listing.nftables
    .flatMap((object) => object.set?.elem ?? [])
    .map(({ concat: [address, port] }) => ({ address, port }));
}

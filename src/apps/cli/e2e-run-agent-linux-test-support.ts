import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentFixtures,
  CliResult,
  RunOptions,
} from "./e2e-run-agent-test-support.ts";

const execFileAsync = promisify(execFile);
const ENGINE_ROOT = new URL("../../../", import.meta.url).pathname;
const BIN_PATH = join(ENGINE_ROOT, "bin", "kanthord.mjs");
const TEST_USER = "kanthord-e2e";
const STUB_PROVIDER = "openai-compatible";
const STUB_MODEL_ID = "stub-1";
const DEFAULT_MODEL = `${STUB_PROVIDER}/${STUB_MODEL_ID}:off`;
const DEFAULT_PROFILE = "swe@1";
const NFT_TABLE = "kanthord";
const TEE_SUCCESS_EXIT = 0;
const NFT_SET = "connections";

export async function spawnCliAsTestUser(
  fixtures: AgentFixtures,
  options: RunOptions,
): Promise<CliResult> {
  const profile = options.profile ?? DEFAULT_PROFILE;
  const model = options.model ?? DEFAULT_MODEL;
  const workspace = options.workspace ?? fixtures.W;
  const session = options.session ?? fixtures.S;
  const auth = options.auth ?? fixtures.authPath;
  const prompts = options.prompt ?? ["run task"];
  const systemPrompts = options.systemPrompt ?? [];

  const args: string[] = [
    "run",
    "agent",
    profile,
    "--model",
    model,
    "--workspace",
    workspace,
    "--session",
    session,
    "--auth",
    auth,
  ];

  for (const p of prompts) {
    args.push("--prompt", p);
  }
  for (const sp of systemPrompts) {
    args.push("--system-prompt", sp);
  }
  for (const b of options.budget ?? []) {
    args.push("--budget", b);
  }

  if (options.output !== false) {
    args.push("--output", options.output ?? fixtures.O);
  }

  const env: NodeJS.ProcessEnv = {
    HOME: fixtures.H,
    TMPDIR: fixtures.T,
    XDG_STATE_HOME: fixtures.X,
    PATH: process.env.PATH ?? "",
    ...options.extraEnv,
  };

  const preserveEnv = Object.keys(env).join(",");

  const child = spawn(
    "sudo",
    [
      "-n",
      "-u",
      TEST_USER,
      `--preserve-env=${preserveEnv}`,
      process.execPath,
      BIN_PATH,
      ...args,
    ],
    { env, signal: options.signal, cwd: options.cwd },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end();
  const [status] = (await once(child, "close")) as [number | null];
  return { status, stdout, stderr };
}

export async function writeFileAsTestUser(
  path: string,
  content: string,
): Promise<void> {
  const child = spawn("sudo", ["-n", "-u", TEST_USER, "tee", path], {
    stdio: "pipe",
  });
  child.stdout?.resume();
  child.stdin.write(content);
  child.stdin.end();
  const [exitCode] = (await once(child, "close")) as [number | null];
  assert.equal(exitCode, TEE_SUCCESS_EXIT);
  await execFileAsync("sudo", ["-n", "-u", TEST_USER, "chmod", "0600", path]);
}

export async function nftConnectionSet(): Promise<string> {
  const { stdout } = await execFileAsync("sudo", [
    "nft",
    "-n",
    "-j",
    "list",
    "set",
    "ip",
    NFT_TABLE,
    NFT_SET,
  ]);
  return stdout;
}

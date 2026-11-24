import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { temporary } from "../../kernel/test-support.ts";
import type { StubRequestRecord } from "./e2e-llm-stub-test-support.ts";

const ENGINE_ROOT = new URL("../../../", import.meta.url).pathname;
const BIN_PATH = join(ENGINE_ROOT, "bin", "kanthord.mjs");
const DIST_MAIN = join(ENGINE_ROOT, "dist", "main.js");

const COMMIT_IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];

const STUB_PROVIDER = "openai-compatible";
const STUB_MODEL_ID = "stub-1";
const DEFAULT_MODEL = `${STUB_PROVIDER}/${STUB_MODEL_ID}:off`;
const DEFAULT_PROFILE = "swe@1";

export const TEST_K = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMn";

export const TEST_TIMEOUT_MS = 120000;

const REFUSAL_EXIT = 1;
const EMPTY_OUTPUT = "";

export interface AgentFixtures {
  authPath: string;
  W: string;
  H: string;
  X: string;
  T: string;
  D: string;
  S: string;
  O: string;
  TEST: string;
  K: string;
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function requireDist(): void {
  assert.ok(
    existsSync(DIST_MAIN),
    `dist/main.js is absent; run pnpm run build first`,
  );
}

function writeAuthFile(
  authPath: string,
  key: string,
  baseUrl: string,
  models: string,
): void {
  const entry = {
    [STUB_PROVIDER]: {
      type: "api_key",
      key,
      env: {
        OPENAI_COMPATIBLE_BASE_URL: baseUrl,
        OPENAI_COMPATIBLE_MODELS: models,
      },
    },
  };
  writeFileSync(authPath, JSON.stringify(entry), { mode: 0o600 });
}

export async function commitAll(W: string, message: string): Promise<void> {
  const git = simpleGit(W);
  await git.add(".");
  await git.raw([...COMMIT_IDENTITY, "commit", "-m", message]);
}

async function buildWorkspace(root: string): Promise<string> {
  const W = join(root, "w");
  mkdirSync(W);
  await simpleGit(W).raw(["init", "-b", "main"]);
  writeFileSync(join(W, "README.md"), "workspace");
  await commitAll(W, "init");
  return W;
}

export async function addWorktree(W: string, path: string): Promise<void> {
  await simpleGit(W).raw(["worktree", "add", "--detach", path]);
}

export async function porcelainStatus(W: string): Promise<string> {
  return (await simpleGit(W).raw(["status", "--porcelain"])).trimEnd();
}

export function digestListing(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map(
      (path) =>
        `${createHash("sha256").update(readFileSync(path)).digest("hex")} ${path}`,
    );
}

export interface SessionContentBlock {
  type: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface SessionMessage {
  role: string;
  content: SessionContentBlock[] | string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
}

export interface SessionEntry {
  type: string;
  cwd?: string;
  message?: SessionMessage;
}

export function sessionEntries(path: string): SessionEntry[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEntry);
}

export function sessionMessages(path: string, role: string): SessionMessage[] {
  return sessionEntries(path).flatMap((entry) =>
    entry.message?.role === role ? [entry.message] : [],
  );
}

export function blockTexts(message: SessionMessage): string[] {
  if (!Array.isArray(message.content)) return [message.content];
  return message.content.flatMap((block) =>
    block.text === undefined ? [] : [block.text],
  );
}

export function resultLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function isJsonLine(line: string): boolean {
  return line.startsWith("{");
}

export function jsonLines(
  stderr: string,
  code: string,
): Record<string, unknown>[] {
  return stderr
    .split("\n")
    .filter(isJsonLine)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line["code"] === code);
}

export function assertRefused(result: CliResult, code: string): void {
  assert.equal(result.status, REFUSAL_EXIT);
  assert.equal(result.stdout, EMPTY_OUTPUT);
  const first = result.stderr
    .split("\n")
    .find((line) => line.length && !isJsonLine(line));
  assert.ok(first !== undefined);
  assert.ok(first.startsWith(`${code}:`), first);
}

export function assertRow(stderr: string, name: string, value: string): void {
  assert.ok(
    stderr
      .split("\n")
      .some(
        (line) =>
          line.startsWith(`${name}:`) &&
          line.slice(name.length + 1).trim() === value,
      ),
    stderr,
  );
}

export interface RequestItem {
  role?: string;
  type?: string;
  content?: RequestContentPart[] | string;
  output?: string;
}

export interface RequestContentPart {
  text?: string;
}

export interface RequestTool {
  name: string;
}

export interface RequestBody {
  model?: string;
  input?: RequestItem[];
  tools?: RequestTool[];
  reasoning?: Record<string, unknown>;
}

export function requestBody(
  record: StubRequestRecord | undefined,
): RequestBody {
  assert.ok(record !== undefined);
  return record.body as RequestBody;
}

export function roleText(
  record: StubRequestRecord | undefined,
  role: string,
): string {
  const item = (requestBody(record).input ?? []).find(
    (entry) => entry.role === role,
  );
  assert.ok(item !== undefined);
  const { content } = item;
  assert.ok(content !== undefined);
  if (!Array.isArray(content)) return content;
  return content.map((part) => part.text ?? "").join("");
}

export function toolNames(record: StubRequestRecord | undefined): string[] {
  return (requestBody(record).tools ?? []).map((tool) => tool.name).sort();
}

export interface FixtureOptions {
  models?: string;
  key?: string;
}

export async function buildFixtures(
  t: TestContext,
  stubBaseUrl: string,
  options: FixtureOptions = {},
): Promise<AgentFixtures> {
  requireDist();

  const root = temporary(t);
  const K = options.key ?? TEST_K;
  const models = options.models ?? JSON.stringify([{ id: STUB_MODEL_ID }]);

  const H = join(root, "h");
  const T = join(root, "tmp");
  const X = join(root, "x");
  const D = join(root, "d");
  const TEST = join(root, "test");

  mkdirSync(H);
  mkdirSync(T);
  mkdirSync(X);
  mkdirSync(D, { mode: 0o700 });
  mkdirSync(TEST);

  const W = await buildWorkspace(root);
  const authDir = join(root, "cfg");
  mkdirSync(authDir);
  const authPath = join(authDir, "auth.json");
  writeAuthFile(authPath, K, stubBaseUrl, models);
  chmodSync(authPath, 0o600);

  const S = join(D, "s.jsonl");
  const O = join(D, "results.jsonl");

  return { authPath, W, H, X, T, D, S, O, TEST, K };
}

export interface RunOptions {
  profile?: string;
  model?: string;
  workspace?: string;
  session?: string;
  output?: string | false;
  prompt?: string[];
  systemPrompt?: string[];
  budget?: string[];
  auth?: string;
  cwd?: string;
  extraEnv?: Record<string, string | undefined>;
  signal: AbortSignal;
}

export function resetFixturesAuth(
  fixtures: AgentFixtures,
  stubBaseUrl: string,
  key: string = fixtures.K,
): void {
  writeAuthFile(
    fixtures.authPath,
    key,
    stubBaseUrl,
    JSON.stringify([{ id: STUB_MODEL_ID }]),
  );
  chmodSync(fixtures.authPath, 0o600);
}

export async function spawnCli(
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
    BIN_PATH,
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

  if (options.output !== false)
    args.push("--output", options.output ?? fixtures.O);

  const env: NodeJS.ProcessEnv = {
    HOME: fixtures.H,
    TMPDIR: fixtures.T,
    XDG_STATE_HOME: fixtures.X,
    PATH: process.env.PATH ?? "",
    ...options.extraEnv,
  };

  const child = spawn(process.execPath, args, {
    env,
    signal: options.signal,
    cwd: options.cwd,
  });
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

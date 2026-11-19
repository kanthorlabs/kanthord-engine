import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { CancellationContext } from "../../kernel/context.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import {
  anthropicSetup,
  fauxAssistantMessage,
  fauxToolCall,
  repositorySetup,
  scriptedModelRuntime,
  type ScriptedProvider,
  task,
} from "../../worker/unit/test-support.ts";
import type { TasksCommandIo, TasksRunOptions } from "./worker-tasks.ts";

export const CREDENTIAL_CANARY = "canary-credential-value-0123456789";
export const PASS_VALUE = "canary-pass-value-0123456789";
export const PASS_NAME = "TASKS_CANARY";
export const TEST_TIMEOUT_MS = 120000;
export const OUTPUT_FILES = [
  "result.json",
  "context.json",
  "progress.json",
  "metrics.json",
  "outbox.json",
  "spans.jsonl",
];
export const REFUSED_KEYS = ["credentials", "sshAccess"];
const SEED_FILE = "seed.json";
const OBJECT_TYPE = "object";
const IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];

export interface SeedFixture {
  root: string;
  seedFolder: string;
  source: string;
  bindingId: string;
  head: string;
  seed: Record<string, unknown>;
}

export async function sourceRepository(root: string): Promise<{
  source: string;
  head: string;
}> {
  const source = join(root, "source");
  mkdirSync(source);
  const git = simpleGit(source);
  await git.raw(["init", "-b", "main"]);
  writeFileSync(join(source, "file"), "base");
  await git.add("file");
  await git.raw([...IDENTITY, "commit", "-m", "base"]);
  return { source, head: (await git.revparse(["HEAD"])).trim() };
}

export function revisionOf(nodeId: string, tasks: ReturnType<typeof task>[]) {
  return {
    node_id: nodeId,
    filename: "implement.md",
    revision: 1,
    reason: "seed",
    actor: { kind: "human", account: "ulrich", name: "Ulrich" },
    created_at: 1,
    content: {
      name: "implement",
      requirement: "implement",
      criterion: "implement",
      verifications: ["true"],
      bindings: [],
      intent: "implement",
      tags: [],
      external_links: [],
    },
    tasks,
    change: {
      write: "import",
      previous_revision: null,
      changed_fields: [],
    },
    pinned_by_attempts: [1],
  };
}

export async function seedFixture(
  t: TestContext,
  shape: (seed: Record<string, unknown>) => void = () => {},
): Promise<SeedFixture> {
  const root = temporary(t);
  const { source, head } = await sourceRepository(root);
  const repository = repositorySetup();
  const setup = anthropicSetup({ repositories: [repository] });
  const nodeId = createIdentity("node");
  const seed: Record<string, unknown> = {
    claim: {
      execution_id: setup.execution_id,
      node_id: nodeId,
      attempt: 1,
      pinned_revision: 1,
      node_branch: `kanthord/${nodeId}`,
      created_at: 1000,
      expired_at: 1000 + 3600000,
      trace_id: "trace",
      root_span_id: "1".repeat(16),
    },
    setup,
    revision: revisionOf(nodeId, [task("work", "grep -q good file")]),
    heads: { [repository.binding_id]: head },
  };
  shape(seed);
  const seedFolder = join(root, "seed");
  mkdirSync(seedFolder);
  writeFileSync(join(seedFolder, SEED_FILE), JSON.stringify(seed));
  return {
    root,
    seedFolder,
    source,
    bindingId: repository.binding_id,
    head,
    seed,
  };
}

export interface CommandRun {
  io: TasksCommandIo;
  stdout: string[];
  stderr: string[];
}

export function apiKeyInput(key = CREDENTIAL_CANARY): Buffer {
  return Buffer.from(
    JSON.stringify({
      provider_id: "anthropic",
      credential: { type: "api_key", key },
    }),
  );
}

export function commandRun(
  fixture: SeedFixture,
  provider: ScriptedProvider,
  overrides: Partial<TasksCommandIo> = {},
): CommandRun {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      cwd: fixture.root,
      shellEnv: hostEnvironment(),
      stdinTerminal: false,
      readStdin: () => apiKeyInput(),
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      modelRuntimeFactory: scriptedModelRuntime(provider),
      stop: new CancellationContext(),
      piDirectory: null,
      ...overrides,
    },
  };
}

export function runOptions(
  fixture: SeedFixture,
  options: Partial<TasksRunOptions> = {},
): TasksRunOptions {
  return {
    credentialStdin: true,
    tree: [`${fixture.bindingId}=${fixture.source}`],
    passEnv: [],
    unit: [],
    output: join(fixture.root, "out"),
    ...options,
  };
}

export function writeGood() {
  return fauxAssistantMessage(
    fauxToolCall("write", { path: "file", content: "good" }),
    { stopReason: "toolUse" },
  );
}

export function readJson(
  folder: string,
  name: string,
): Record<string, unknown> {
  return JSON.parse(readFileSync(join(folder, name), "utf8")) as Record<
    string,
    unknown
  >;
}

export function filesOf(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? filesOf(path) : [path];
  });
}

export function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value === null || typeof value !== OBJECT_TYPE) return [];
  return Object.entries(value as object).flatMap(([key, item]) => [
    key,
    ...keysOf(item),
  ]);
}

export async function diagnosticOf(
  run: Promise<unknown>,
): Promise<{ code: string; fields: unknown }> {
  try {
    await run;
  } catch (error) {
    const coded = error as { code: string; fields: unknown };
    return { code: coded.code, fields: coded.fields };
  }
  return assert.fail("The run gave no diagnostic.");
}

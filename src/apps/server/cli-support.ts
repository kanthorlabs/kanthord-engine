import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { simpleGit } from "simple-git";
import { isNumber, isString } from "../../kernel/values.ts";
import { parse, stringify } from "yaml";
import { configuration } from "../../config/index.ts";
import { writePrivate } from "../../kernel/files.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  AssessmentResult,
  NodeState,
  type Evidence,
} from "../../mission/contract.ts";
import {
  WorkPullKind,
  type ExecutionRecord,
} from "../../scheduler/contract.ts";
import { FAKE_SSH_CREDENTIAL_BODY, remoteHead } from "./test-support.ts";

const EMPTY_ARGUMENT_COUNT = 0;
const COMMAND_TIMEOUT_MS = 10000;
const SUCCESS_EXIT_CODE = 0;
const EMPTY_OUTPUT = "";
const INITIAL_SEQUENCE = 0;
const FIRST_ATTEMPT = 1;
const CREDENTIAL_NAME = "github";
const HARNESS_BINDING = "harness";
const WAIT_POLL_INTERVAL_MS = 50;
const WAIT_LIMIT_MS = 10000;

export async function until<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    assert.ok(Date.now() < deadline, "The awaited state did not arrive.");
    await delay(WAIT_POLL_INTERVAL_MS);
  }
}

export function generateMachineToken(input: {
  env: NodeJS.ProcessEnv;
  masterKey: string;
  projectId: string;
  bindingName: string;
  name: string;
}): { token: string; client_secret: string } {
  assert.ok(input.env.XDG_CONFIG_HOME);
  assert.ok(input.projectId && input.bindingName && input.name);
  const path = join(input.env.XDG_CONFIG_HOME, "issuance.yaml");
  writePrivate(
    path,
    stringify(configuration({ master_key: input.masterKey }).getProperties()),
    true,
  );
  const args = [
    "jwt",
    "generate",
    "--project",
    input.projectId,
    "--binding",
    input.bindingName,
    "--name",
    input.name,
    "--config",
    path,
  ];
  const entry = new URL("../../main.ts", import.meta.url).href;
  const generated = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `process.stdout.isTTY=true;process.argv=[process.execPath,'kanthord',...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`,
    ],
    { env: input.env, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS },
  );
  if (generated.error) throw generated.error;
  assert.equal(generated.status, SUCCESS_EXIT_CODE);
  assert.equal(generated.stderr, EMPTY_OUTPUT);
  const fragment = parse(generated.stdout) as {
    token: string;
    client_secret: string;
  };
  assert.ok(isString(fragment.token) && fragment.token.length);
  assert.ok(isString(fragment.client_secret) && fragment.client_secret.length);
  return { token: fragment.token, client_secret: fragment.client_secret };
}

export function kanthord(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  assert.ok(args.length > EMPTY_ARGUMENT_COUNT);
  assert.ok(env.XDG_CONFIG_HOME);
  const entry = new URL("../../main.ts", import.meta.url).href;
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `process.argv=[process.execPath,'kanthord',...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`,
        ],
        { env, timeout: COMMAND_TIMEOUT_MS },
        (error, stdout, stderr) => {
          const code = error?.code;
          if (error && !isNumber(code)) return reject(error);
          resolve({
            code: isNumber(code) ? code : SUCCESS_EXIT_CODE,
            stdout,
            stderr,
          });
        },
      );
    },
  );
}

export function environment(directory: string): NodeJS.ProcessEnv {
  assert.ok(directory.startsWith("/"));
  assert.ok(existsSync(directory));
  return {
    ...process.env,
    XDG_CONFIG_HOME: directory,
    KANTHORD_CONFIG: join(directory, "absent.yaml"),
    KANTHORD_ENDPOINT: "http://127.0.0.1:1",
    KANTHORD_TOKEN: undefined,
  };
}

export function completed<T>(result: OperationResult<T>): T {
  assert.ok(
    result.type === OperationResultType.Completed,
    JSON.stringify(result),
  );
  assert.equal(result.status, HttpStatus.OK);
  return result.data;
}

export async function pushNodeBranch(
  t: TestContext,
  bare: string,
  nodeId: string,
  content: string,
): Promise<string> {
  assert.ok(bare && nodeId && content);
  const directory = join(temporary(t), "node");
  await simpleGit().clone(bare, directory);
  const git = simpleGit(directory);
  await git.addConfig("user.name", "Test Node");
  await git.addConfig("user.email", "test_node@example.invalid");
  await git.raw(["checkout", "-b", `kanthord/${nodeId}`]);
  writeFileSync(join(directory, "node.md"), content);
  await git.add("node.md");
  await git.commit(content);
  await git.push("origin", `kanthord/${nodeId}`);
  const head = (await git.revparse(["HEAD"])).trim();
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.equal(await remoteHead(bare, `refs/heads/kanthord/${nodeId}`), head);
  return head;
}

export type CliSession = {
  H: NodeJS.ProcessEnv;
  secrets: string[];
  read: <T>(args: string[], env?: NodeJS.ProcessEnv) => Promise<T>;
  write: <T>(
    args: string[],
    body: unknown,
    env?: NodeJS.ProcessEnv,
  ) => Promise<T>;
};

export function cliSession(
  t: TestContext,
  endpoint: string,
  token: string,
  secret: string,
): CliSession {
  assert.ok(endpoint && token && secret);
  const directory = temporary(t);
  const H: NodeJS.ProcessEnv = {
    ...environment(directory),
    KANTHORD_ENDPOINT: endpoint,
    KANTHORD_TOKEN: token,
  };
  const secrets = [secret, token];
  let sequence = INITIAL_SEQUENCE;
  const file = (body: unknown) => {
    const path = join(directory, `${++sequence}.json`);
    writePrivate(path, JSON.stringify(body));
    return path;
  };
  const read = async <T>(args: string[], env = H): Promise<T> => {
    const result = await kanthord(args, env);
    assert.equal(result.code, SUCCESS_EXIT_CODE, result.stderr);
    assert.equal(result.stderr, EMPTY_OUTPUT);
    for (const known of secrets) assert.ok(!result.stdout.includes(known));
    return JSON.parse(result.stdout) as T;
  };
  const write = <T>(args: string[], body: unknown, env = H) =>
    read<T>([...args, "--file", file(body)], env);
  return { H, secrets, read, write };
}

export async function createCredentials(
  session: CliSession,
  secret: string,
): Promise<void> {
  assert.ok(session.secrets.includes(secret));
  await session.write(["repository", "credential", "create"], {
    name: CREDENTIAL_NAME,
    platform: "github",
    metadata: null,
    secret: { key: secret },
  });
  await session.write(
    ["repository", "credential", "create"],
    FAKE_SSH_CREDENTIAL_BODY,
  );
}

export function repositoryBinding(name: string, action: string) {
  assert.ok(name && action);
  return {
    kind: "repository",
    config: {
      available: true,
      platform: "github",
      address: `git@github.com:owner/${name}.git`,
      strategy: {
        base_branch: "main",
        action: { name: action, follows: { type: "assessment_passed" } },
      },
      ssh_credential: FAKE_SSH_CREDENTIAL_BODY.name,
      credential: CREDENTIAL_NAME,
    },
  };
}

export type CliMachine = Awaited<ReturnType<typeof cliMachine>>;

export async function cliMachine(
  session: CliSession,
  input: { masterKey: string; projectId: string; resourceIdentity: string },
) {
  assert.ok(input.masterKey && input.projectId && input.resourceIdentity);
  const token = generateMachineToken({
    env: session.H,
    masterKey: input.masterKey,
    projectId: input.projectId,
    bindingName: HARNESS_BINDING,
    name: "Harness",
  }).token;
  session.secrets.push(token);
  const T = { ...session.H, KANTHORD_TOKEN: token };
  const { runtime_identity: rid } = await session.read<{
    runtime_identity: string;
  }>(["worker", "register"], T);
  const node = (nodeId: string) =>
    session.read<{ state: string }>(["mission", "node", "get", nodeId]);
  const pull = async (nodeId: string, state: string) => {
    const result = await session.write<{
      kind: string;
      execution: ExecutionRecord;
    }>(
      ["scheduler", "work", "pull"],
      { resource_identity: input.resourceIdentity, runtime_identity: rid },
      T,
    );
    assert.equal(result.kind, WorkPullKind.Claimed);
    assert.equal(result.execution.node_id, nodeId);
    assert.equal(result.execution.attempt, FIRST_ATTEMPT);
    assert.equal((await node(nodeId)).state, state);
    return result.execution;
  };
  const release = (executionId: string) =>
    session.write<{ ended_at: number }>(
      ["scheduler", "execution", "release", executionId],
      { further_work: false },
      T,
    );
  return { token, T, node, pull, release };
}

export function executionContext(execution: ExecutionRecord) {
  assert.ok(execution.execution_id);
  assert.ok(execution.pinned_revision);
  return {
    execution_id: execution.execution_id,
    attempt: FIRST_ATTEMPT,
    node_revision: execution.pinned_revision,
  };
}

export function repositorySnapshot(bindingId: string, commit: string) {
  assert.ok(bindingId);
  assert.match(commit, /^[a-f0-9]{40}$/);
  return { kind: "repository", binding_id: bindingId, commit };
}

function verificationRun(bindingId: string, commit: string) {
  assert.ok(bindingId && commit);
  return {
    subject: "verification run",
    assets: [
      {
        kind: "produced",
        content: { media_type: "text/plain", encoding: "base64", data: "b2s=" },
      },
    ],
    verification: {
      tested_input: repositorySnapshot(bindingId, commit),
      results: [
        {
          command: "true",
          exit_code: SUCCESS_EXIT_CODE,
          signal: null,
          timed_out: false,
        },
      ],
    },
  };
}

export async function passingEvaluation(
  session: CliSession,
  machine: CliMachine,
  input: { nodeId: string; bindingId: string; commit: string },
): Promise<ExecutionRecord> {
  const { nodeId, bindingId, commit } = input;
  assert.ok(nodeId && bindingId && commit);
  const submit = (x: ExecutionRecord, body: object) =>
    session.write<{ evidence: Evidence }>(
      ["mission", "evidence", "submit", nodeId],
      { ...executionContext(x), ...body },
      machine.T,
    );
  const x1 = await machine.pull(nodeId, NodeState.Executing);
  const w1 = await submit(x1, {
    subject: "head commit",
    assets: [
      { kind: "repository", address: repositorySnapshot(bindingId, commit) },
    ],
  });
  await machine.release(x1.execution_id);
  const x2 = await machine.pull(nodeId, NodeState.Evaluating);
  const r1 = await submit(x2, verificationRun(bindingId, commit));
  const assessment = await session.write<{ assessment: { result: string } }>(
    ["mission", "assessment", "submit", nodeId],
    {
      ...executionContext(x2),
      evidence_ids: [r1.evidence.id, w1.evidence.id],
      child_outcome_ids: [],
      result: "success",
      rationale: "verified",
      tested_input: repositorySnapshot(bindingId, commit),
    },
    machine.T,
  );
  assert.equal(assessment.assessment.result, AssessmentResult.Success);
  return x2;
}

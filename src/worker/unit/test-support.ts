import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { simpleGit } from "simple-git";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { credentialSecrets } from "../../agent/known-secrets.ts";
import { createModelRuntime, resolveModel } from "../../llm/model-connector.ts";
import { loadPi } from "../../agent/pi.ts";
import {
  scriptedProvider,
  type ScriptedProvider,
} from "../../agent/test-support.ts";
import { background } from "../../kernel/context.ts";
import {
  fixtureTemplate,
  hostEnvironment,
  stopAfter,
  temporary,
} from "../../kernel/test-support.ts";
import { createIdentity } from "../../kernel/identity.ts";
import * as connector from "../../repository/connector.ts";
import {
  DEFAULT_SSH_PORT,
  LOCAL_GIT_SSH_ACCESS,
} from "../../repository/sshd-test-support.ts";
import type { Revision, TaskContent } from "../../mission/contract.ts";
import {
  anthropicSetup,
  TEST_SSH_HOST_KEY,
  TEST_SSH_PUBLIC_KEY,
  unusedHostTools,
} from "../test-support.ts";
import type { SshAccess } from "../../repository/contract.ts";
import {
  type ExecutionCredential,
  modelConnectorInput,
  type ModelRuntimeFactory,
} from "./model-runtime.ts";
import type {
  ExecutionEnvironment,
  ExecutionSetup,
  HostTools,
  RepositoryTransport,
} from "../contract.ts";
import { RecordKind, type TelemetryRecord } from "../../tracking/contract.ts";
import { AFFECTED_DECLARATION_FILE } from "./affected.ts";
import { COMMAND_LIMIT_MS, ExecutionBudget } from "./budget.ts";
import { SpanOperation, SpanRecorder } from "./telemetry.ts";
import {
  type NativeOpenRequest,
  nativeSessionTrace,
  type NativeTrace,
  openNativeAgent,
} from "./native-agent.ts";
import { agentPort, type SessionPort } from "../../agent/agent-port.ts";
import { executionEvidence } from "../../agent/capabilities/execution-evidence.ts";
import { linkUpdates } from "../../agent/capabilities/link-updates.ts";
import type { KnownSecrets } from "../../agent/hooks/sensitive-text-redaction.ts";
import { ExecutionRun } from "./execution-run.ts";
import type { MethodClaim } from "./execution-stop.ts";
import type { MethodClients } from "./method-clients.ts";
import { WorkspaceRoot } from "./workspace.ts";
import { PoolClass } from "./tree-pool.ts";
import { prepareStepsWorkspace } from "./steps-implement-host.ts";
import { commonPorts } from "./worker-ports.ts";
import type { RefreshResult } from "./base-refresh.ts";
import type { Verdict } from "./node-verdict.ts";
import type { VerificationFacts } from "./progress-rule.ts";
import { digest } from "../../kernel/json.ts";
import type { UnitRecord } from "../contract.ts";
import { VerificationKind } from "./method-telemetry.ts";
import { VerificationMemo } from "./verification-memo.ts";
import { commitStaged, headCommit, stageWork } from "./local-git.ts";
import type { Context } from "../../kernel/context.ts";
export { LOCAL_GIT_SSH_ACCESS } from "../../repository/sshd-test-support.ts";
export {
  scriptedProvider,
  type ScriptedProvider,
} from "../../agent/test-support.ts";
export {
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
  fauxThinking,
} from "@earendil-works/pi-ai";
export * from "../test-support.ts";

const NO_STAGED_PATHS = 0;

export async function commitWork(
  env: NodeJS.ProcessEnv,
  directory: string,
  message: string,
  context: Context,
  deadlineMs: number,
): Promise<string | null> {
  const call = { env, directory, context, deadlineMs };
  if ((await stageWork(call)).length === NO_STAGED_PATHS) return null;
  await commitStaged(call, message);
  return headCommit(env, directory, context, deadlineMs);
}

export function scriptedModelRuntime(
  provider: ScriptedProvider,
): ModelRuntimeFactory {
  assert.ok(provider.provider);
  assert.ok(provider.calls);
  return async (input) => {
    const runtime = await createModelRuntime(
      await loadPi(),
      modelConnectorInput(input),
    );
    runtime.registerNativeProvider(provider.provider);
    return {
      runtime,
      model: resolveModel(runtime, input.agent.effective_configuration),
    };
  };
}

export const ONE_FREE_TREE = 1;

export function releasedRoot(h: {
  root: string;
  input: { workspaces: WorkspaceRoot };
}): string {
  if (existsSync(h.root)) return h.root;
  const trees = agentTrees(h.input.workspaces);
  assert.equal(trees.length, ONE_FREE_TREE);
  return trees[0]!;
}

export function agentTrees(workspaces: WorkspaceRoot): string[] {
  return workspaces.pool
    .trees()
    .map((tree) => tree.path)
    .filter((path) => basename(dirname(path)) === PoolClass.Agent);
}

export function commandTrees(workspaces: WorkspaceRoot): string[] {
  return workspaces.pool
    .trees()
    .map((tree) => tree.path)
    .filter((path) => basename(dirname(path)) === PoolClass.Command);
}

export async function remapOrigin(
  directory: string,
  map: (url: string) => string,
): Promise<void> {
  const git = simpleGit(directory);
  const url = (await git.raw(["config", "--get", "remote.origin.url"])).trim();
  await git.raw(["remote", "set-url", "origin", map(url)]);
}

export const transport: RepositoryTransport = {
  clone: (address, directory, context, deadlineMs) =>
    connector.clone(
      address,
      directory,
      context,
      deadlineMs,
      LOCAL_GIT_SSH_ACCESS,
    ),
  fetchAndCheckout: (
    directory,
    branch,
    base,
    pushed,
    keep,
    record,
    context,
    deadlineMs,
  ) =>
    connector.fetchAndCheckout(
      directory,
      branch,
      base,
      pushed,
      keep,
      record,
      context,
      deadlineMs,
      LOCAL_GIT_SSH_ACCESS,
    ),
  fetchBase: (directory, base, context, deadlineMs) =>
    connector.fetchBase(
      directory,
      base,
      context,
      deadlineMs,
      LOCAL_GIT_SSH_ACCESS,
    ),
  pushNodeBranch: (directory, branch, context, deadlineMs) =>
    connector.pushNodeBranch(
      directory,
      branch,
      context,
      deadlineMs,
      LOCAL_GIT_SSH_ACCESS,
    ),
  cloneSnapshot: (address, revision, directory, context, deadlineMs) =>
    connector.cloneSnapshot(
      address,
      revision,
      directory,
      context,
      deadlineMs,
      LOCAL_GIT_SSH_ACCESS,
    ),
  refreshSnapshot: (input) =>
    connector.refreshSnapshot({ ...input, ssh: LOCAL_GIT_SSH_ACCESS }),
};

export const TEST_SSH_ACCESS: SshAccess = {
  private_key: "test_private_key",
  public_key: "ssh-ed25519 test_public_key",
  known_hosts: TEST_SSH_HOST_KEY.known_hosts,
  port: DEFAULT_SSH_PORT,
};

class EveryBindingSshAccess extends Map<string, SshAccess> {
  override get(): SshAccess {
    return TEST_SSH_ACCESS;
  }
}

export const everyBindingSshAccess: ReadonlyMap<string, SshAccess> =
  new EveryBindingSshAccess();

export function testSshAccess(
  repositories: readonly { binding_id: string }[],
): Map<string, SshAccess> {
  return new Map(
    repositories.map(({ binding_id }) => [
      binding_id,
      {
        private_key: `test_private_key_${binding_id}`,
        public_key: `ssh-ed25519 test_${binding_id}`,
        known_hosts: TEST_SSH_HOST_KEY.known_hosts,
        port: DEFAULT_SSH_PORT,
      },
    ]),
  );
}

export const STEPS_KEY = "test_steps_key";
export const NO_PROVIDER_CALLS = 0;
const IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
const USER_CONFIG = "[user]\n\tname = Test\n\temail = test@example.invalid\n";
const BARE_NAME = "origin.git";
const DEFAULT_BINDING_NAME = "repo";
const bareTemplate = fixtureTemplate(async (root) => {
  const origin = join(root, "origin");
  mkdirSync(origin);
  const git = simpleGit(origin);
  await git.raw(["init", "-b", "main"]);
  writeFileSync(join(origin, "file"), "base");
  await git.add("file");
  await git.raw([...IDENTITY, "commit", "-m", "base"]);
  await git.clone(origin, join(root, BARE_NAME), ["--bare"]);
  rmSync(origin, { recursive: true });
});
export const repositorySetup = () => ({
  binding_id: createIdentity("binding"),
  name: "repo",
  address: "git@github.com:owner/repo.git",
  ssh_host_key: TEST_SSH_HOST_KEY,
  resource_identity: "github:kanthorlabs/engine",
  ssh_public_key: TEST_SSH_PUBLIC_KEY,
  strategy: { base_branch: "main" },
  environment: null,
});

export const task = (name: string, command: string): TaskContent => ({
  id: createIdentity("task"),
  filename: `${name}.md`,
  content: {
    name,
    requirement: name,
    criterion: name,
    verifications: [command],
    bindings: [],
  },
});

export async function implementFixture(
  t: TestContext,
  tasks: TaskContent[],
  script: Parameters<typeof scriptedProvider>[0],
  turns?: number,
  names: readonly string[] = [DEFAULT_BINDING_NAME],
  environment: ExecutionEnvironment = null,
) {
  const bares = await Promise.all(
    names.map(async () => join((await bareTemplate(t)).root, BARE_NAME)),
  );
  const setup = anthropicSetup();
  if (turns) setup.resource_budget.turns = turns;
  setup.repositories = names.map((name, index) => ({
    binding_id: createIdentity("binding"),
    name,
    address: bares[index]!,
    ssh_host_key: TEST_SSH_HOST_KEY,
    resource_identity: "github:kanthorlabs/engine",
    ssh_public_key: TEST_SSH_PUBLIC_KEY,
    strategy: { base_branch: "main" },
    environment,
  }));
  const claim = {
    execution_id: setup.execution_id,
    node_id: createIdentity("node"),
    attempt: 1,
    pinned_revision: 1,
    node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    created_at: Date.now(),
    expired_at: Date.now() + 60000,
    trace_id: "trace",
    root_span_id: "1".repeat(16),
  };
  return openExecution(t, { setup, claim, tasks, bares }, script);
}

export async function nextExecution(
  t: TestContext,
  previous: {
    input: { setup: ExecutionSetup; claim: MethodClaim };
    revision: Revision;
    bares: string[];
  },
  script: Parameters<typeof scriptedProvider>[0],
  state?: string,
) {
  const opened = await openExecution(
    t,
    {
      setup: previous.input.setup,
      claim: {
        ...previous.input.claim,
        created_at: Date.now(),
        expired_at: Date.now() + 60000,
      },
      tasks: previous.revision.tasks,
      bares: previous.bares,
      state,
    },
    script,
  );
  return { ...opened, revision: previous.revision };
}

async function openExecution(
  t: TestContext,
  base: {
    setup: ExecutionSetup;
    claim: MethodClaim;
    tasks: TaskContent[];
    bares: string[];
    state?: string;
  },
  script: Parameters<typeof scriptedProvider>[0],
) {
  const { setup, claim, tasks, bares } = base;
  const state = base.state ?? temporary(t);
  const input = {
    claim,
    setup,
    workspaces: WorkspaceRoot.open(state),
    transport,
    sshAccess: testSshAccess(setup.repositories),
    env: hostEnvironment(),
  };
  const run = new ExecutionRun({
    claim,
    clients: {
      mission: {
        "execution.evidence.list": async () => ({
          type: "completed",
          status: 200,
          data: { items: [], next_cursor: null },
        }),
      },
      worker: {
        "execution.unit_record.put": async (request: { body: UnitRecord }) => {
          storeUnitRecord(setup, request.body);
          return { type: "completed", status: 200, data: request.body };
        },
      },
    } as unknown as MethodClients,
    credentials: { release: async () => {} },
    context: background,
    secrets: async () => [STEPS_KEY],
  });
  stopAfter(t, () => run.dispose());
  const workspace = await prepareStepsWorkspace(input, run);
  for (const checkout of workspace.checkouts)
    appendFileSync(join(checkout.directory, ".git", "config"), USER_CONFIG);
  const provider = scriptedProvider(script);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", async () => ({
    type: "api_key",
    key: STEPS_KEY,
  }));
  const knownSecrets = credentialSecrets(credentials, "anthropic");
  const budget = new ExecutionBudget({
    created_at: Date.now(),
    expired_at: Date.now() + 60000,
    resource_budget: setup.resource_budget,
  });
  const agent = await openNativeAgent({
    sessions: testSessions({
      credential: {
        credential_id: setup.agents[0]!.credential_id,
        provider_id: "anthropic",
        store: credentials,
      },
      modelRuntimeFactory: scriptedModelRuntime(provider),
      knownSecrets,
      budget,
      hostHome: temporary(t),
    }),
    request: workspaceRequest(setup, claim, workspace.root),
    knownSecrets,
    budget,
    context: run.operationContext,
  });
  stopAfter(t, () => agent.close());
  return {
    input,
    run,
    cancel: run.operationContext,
    get ports() {
      return commonPorts(run);
    },
    agent,
    revision: {
      filename: "implement.md",
      content: {
        name: "implement",
        requirement: "implement",
        criterion: "implement",
        verifications: ["true"],
        bindings: [],
      },
      tasks,
    } as unknown as Revision,
    ...workspace,
    verdict: null as Verdict | null,
    cleared: null as string | null,
    unchangedTurns: 0,
    refreshed: null as RefreshResult | null,
    lastVerification: null as VerificationFacts,
    revisionCount: 0,
    memo: new VerificationMemo(),
    verificationTimedOut: false,
    provider,
    bare: bares[0]!,
    bares,
  };
}

export async function advanceBase(
  h: { bare: string },
  t: TestContext,
  content: string,
  path = "file",
) {
  const clone = temporary(t);
  const git = simpleGit(clone);
  await git.clone(h.bare, clone, ["--branch", "main"]);
  writeFileSync(join(clone, path), content);
  await git.add(path);
  await git.raw([...IDENTITY, "commit", "-m", `base change of ${path}`]);
  await git.push("origin", "main");
}

const AFFECTED_TEST_FILE = "a.test.ts";
const AFFECTED_TEST_NAME = "one";

function affectedReportText(failed: boolean): string {
  return JSON.stringify({
    version: 1,
    selection: "related",
    reason: null,
    tests: [AFFECTED_TEST_FILE],
    failed: failed
      ? [{ file: AFFECTED_TEST_FILE, name: AFFECTED_TEST_NAME }]
      : [],
    flaky: [],
    excluded_e2e: [],
  });
}

export function affectedCommand(failWhen: string): string {
  return `if ${failWhen}; then printf '%s' '${affectedReportText(true)}' > "$KANTHORD_AFFECTED_REPORT"; exit 1; fi; printf '%s' '${affectedReportText(false)}' > "$KANTHORD_AFFECTED_REPORT"`;
}

export async function declareAffected(
  h: { bare: string },
  t: TestContext,
  command: string,
  gateFiles: string[] = [],
) {
  const clone = temporary(t);
  const git = simpleGit(clone);
  await git.clone(h.bare, clone, ["--branch", "main"]);
  mkdirSync(join(clone, dirname(AFFECTED_DECLARATION_FILE)));
  writeFileSync(
    join(clone, AFFECTED_DECLARATION_FILE),
    JSON.stringify({ version: 1, command, gate_files: gateFiles }),
  );
  await git.add(AFFECTED_DECLARATION_FILE);
  await git.raw([...IDENTITY, "commit", "-m", "declare affected tests"]);
  await git.push("origin", "main");
}

export async function commitOnNode(directory: string, content: string) {
  writeFileSync(join(directory, "file"), content);
  await simpleGit(directory).add("file");
  await simpleGit(directory).commit("node change");
}

export function storeUnitRecord(
  setup: ExecutionSetup,
  record: UnitRecord,
): void {
  setup.unit_records = [
    ...setup.unit_records.filter(({ unit_id }) => unit_id !== record.unit_id),
    record,
  ];
}

export async function recordUnit(
  h: {
    checkouts: { directory: string; head: string; binding_id: string }[];
    input: { setup: ExecutionSetup };
  },
  unit: TaskContent,
) {
  const checkout = h.checkouts[0]!;
  const git = simpleGit(checkout.directory);
  await git.raw(["commit", "-q", "--allow-empty", "--message", "done"]);
  checkout.head = (await git.revparse(["HEAD"])).trim();
  storeUnitRecord(h.input.setup, {
    unit_id: unit.id,
    content_digest: digest(unit.content),
    commits: [{ binding_id: checkout.binding_id, commit: checkout.head }],
  });
}

export function recordReleases(
  h: Awaited<ReturnType<typeof implementFixture>>,
) {
  const bodies: unknown[] = [];
  h.run.clients.scheduler = {
    executionRelease: async (input: { body: unknown }) => {
      bodies.push(input.body);
      return { type: "completed", status: 200, data: {} };
    },
  } as unknown as MethodClients["scheduler"];
  return bodies;
}

export function recordSpans(
  h: Awaited<ReturnType<typeof implementFixture>>,
  observe?: (batch: readonly TelemetryRecord[]) => void,
): TelemetryRecord[] {
  const records: TelemetryRecord[] = [];
  (h.run as { spans: SpanRecorder }).spans = new SpanRecorder(
    h.run.claim,
    "coder-1",
    {
      write: (batch) => {
        records.push(...batch);
        observe?.(batch);
      },
      flush: async () => {},
    },
  );
  return records;
}

export function spanEnds(
  records: readonly TelemetryRecord[],
  operation: SpanOperation,
) {
  return records.flatMap((record) =>
    record.kind === RecordKind.Span &&
    record.operation === operation &&
    "end_time" in record
      ? [record]
      : [],
  );
}

function spanStarts(
  records: readonly TelemetryRecord[],
  operation: SpanOperation,
) {
  return records.flatMap((record) =>
    record.kind === RecordKind.Span &&
    record.operation === operation &&
    record.start_time !== undefined
      ? [record]
      : [],
  );
}

export function phaseSpanNames(records: readonly TelemetryRecord[]): unknown[] {
  return spanStarts(records, SpanOperation.Phase).map(
    (record) => record.attributes?.["kanthord.phase"],
  );
}

export function stepSpanOutcomes(
  records: readonly TelemetryRecord[],
): unknown[][] {
  const ends = spanEnds(records, SpanOperation.Step);
  return spanStarts(records, SpanOperation.Step).map((start) => [
    start.attributes?.["kanthord.step.id"],
    ends.find((end) => end.span_id === start.span_id)?.attributes?.[
      "kanthord.step.outcome"
    ],
  ]);
}

export function listedVerificationSpans(records: readonly TelemetryRecord[]) {
  return records.flatMap((record) =>
    record.kind === RecordKind.Span &&
    record.operation === SpanOperation.Verification &&
    record.start_time !== undefined &&
    record.attributes?.["kanthord.verification.kind"] ===
      VerificationKind.Listed
      ? [
          {
            context: record.attributes["kanthord.verification.context"],
            index: record.attributes["kanthord.verification.index"],
            owner: record.attributes["kanthord.verification.owner_id"],
          },
        ]
      : [],
  );
}

const COMMAND_START_WAIT_MS = 30000;

async function tickCommandLimit(
  t: TestContext,
  startedMarker: string,
): Promise<void> {
  const giveUp = Date.now() + COMMAND_START_WAIT_MS;
  while (!existsSync(startedMarker) && Date.now() < giveUp)
    await new Promise((resolve) => setImmediate(resolve));
  assert.ok(existsSync(startedMarker), "the command started");
  t.mock.timers.tick(COMMAND_LIMIT_MS);
  t.mock.timers.reset();
}

export function commandLimitClock(t: TestContext, startedMarker: string) {
  let ticked: Promise<void> | null = null;
  return {
    observe(batch: readonly TelemetryRecord[]): void {
      const started = batch.some(
        (record) =>
          record.kind === RecordKind.Span &&
          record.operation === SpanOperation.Verification &&
          record.start_time !== undefined,
      );
      if (!started || ticked !== null) return;
      t.mock.timers.enable({ apis: ["setTimeout"] });
      ticked = tickCommandLimit(t, startedMarker);
    },
    async elapsed(): Promise<void> {
      assert.ok(ticked, "a verification started");
      await ticked;
    },
  };
}

export interface TestSessionsInput {
  credential: ExecutionCredential;
  modelRuntimeFactory: ModelRuntimeFactory;
  knownSecrets: KnownSecrets;
  budget: ExecutionBudget;
  hostHome: string;
  hostTools?: HostTools;
  spans?: SpanRecorder;
  sessionRoot?: string;
}

export function testSessions(
  input: TestSessionsInput,
): SessionPort<NativeTrace> {
  const tools = () => input.hostTools ?? unusedHostTools;
  return agentPort({
    capabilities: [executionEvidence(tools), linkUpdates(tools)],
    modelRuntimeFactory: ({ agent, signal }) =>
      input.modelRuntimeFactory({
        credential: input.credential,
        agent,
        signal,
      }),
    knownSecrets: input.knownSecrets,
    trace: nativeSessionTrace(input.spans),
    sessionRoot: input.sessionRoot ?? null,
    budget: input.budget,
    env: hostEnvironment(),
    hostHome: input.hostHome,
  });
}

export function workspaceRequest(
  setup: ExecutionSetup,
  claim: NativeOpenRequest["claim"],
  workspace: string,
): NativeOpenRequest {
  return {
    claim,
    setup,
    checkouts: [{ directory: workspace }],
    reviewWorkspace: null,
  };
}

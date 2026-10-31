import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { MessagePort } from "node:worker_threads";
import { simpleGit } from "simple-git";
import { httpClient } from "../../gateway/client.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import {
  linkPiTools,
  requirePiTools,
  temporary,
} from "../../kernel/test-support.ts";
import { directories } from "../../kernel/xdg.ts";
import { llmOperations } from "../../llm/contract.ts";
import {
  Intent,
  missionOperations,
  NodeState,
} from "../../mission/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import { ClaimState, schedulerOperations } from "../../scheduler/contract.ts";
import {
  ExecutionEnd,
  RevokeCause,
  trackingOperations,
} from "../../tracking/contract.ts";
import {
  alwaysAvailable,
  BindingEntryState,
  InstancePlacement,
  PlacementIssue,
  PoolPlacement,
  RegistrationActivity,
  type RepositoryTransport,
  WorkerErrorCode,
  workerOperations,
} from "../../worker/contract.ts";
import type { ModelRuntimeFactory } from "../../worker/unit/index.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  transport as localTransport,
  scriptedModelRuntime,
  scriptedProvider,
} from "../../worker/unit/test-support.ts";
import { SlotControl, type ThreadEntry } from "../worker/thread-data.ts";
import { portTransport, type WorkerTransport } from "../worker/transport.ts";
import { type UnitBinding, WorkerUnit } from "../worker/unit.ts";
import { until } from "./cli-test-support.ts";
import { fakeContainerHost } from "./container-fakes-test-support.ts";
import type {
  SlotDriver,
  SlotEntry,
  SlotExit,
  SlotInstance,
  SlotLaunch,
} from "./slot-driver.ts";
import {
  bareRepository,
  COVERING_WORKER_BINDINGS,
  enableCoveringAgents,
  gatewayFixture,
  humanCaller,
  provisionRepositoryCredentials,
} from "./test-support.ts";
import { threadEnvironment } from "./thread-driver.ts";

const TEST_TIMEOUT_MS = 180000;
const SETTLE_MS = 600;
const GATE_POLL_SECONDS = "0.05";
const CLEAN_CODE = 0;
const FAILED_CODE = 1;
const SINGLE_ITEM = 1;
const TWO_ITEMS = 2;
const THREE_ITEMS = 3;
const FIRST_INSTANCE = "coder-1";
const SECOND_INSTANCE = "coder-2";
const THIRD_INSTANCE = "coder-3";
const GENERAL = "general";
const CREDENTIAL = "anthro-1";
const PROVIDER_KEY = "instance-model-provider-key";
const WORKER_INSTANCE_ATTRIBUTE = "kanthord.worker.instance";
const END_ATTRIBUTE = "kanthord.execution.end";
const CAUSE_ATTRIBUTE = "kanthord.revoke.cause";
const REPOSITORY_BINDING = "repo";
const INSTANCE_WORKER = "coder@1";
const SERVER_LIMIT = 2;
const BASH = "bash";
const TOOL_USE = "toolUse";
const DONE = "done";
const HELLO = "hello";
const GIT_NAME = "Instance Model";
const GIT_EMAIL = "instance_model@example.invalid";
const FIRST_VERSION = 1;
const CONFIGURATION = {
  agent_provider: "default",
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "off",
} as const;
const NODE = {
  name: "Say hello",
  requirement: "Write hello.txt",
  criterion: "hello.txt exists",
  verifications: ["test -f hello.txt"],
};

class Gates {
  private readonly directory: string;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.directory = directory;
  }

  path(name: string): string {
    return join(this.directory, name);
  }

  open(name: string): void {
    writeFileSync(this.path(name), "");
  }
}

function threadEntries(entries: readonly SlotEntry[]): ThreadEntry[] {
  return entries.map((entry) => ({
    client_id: entry.client_id,
    port: entry.channel,
    client_secret: entry.client_secret,
    state: entry.state,
  }));
}

interface UnitHost {
  repository: RepositoryTransport;
  runtime(instanceName: string): ModelRuntimeFactory;
  handoverHold(instanceName: string): Promise<void> | undefined;
}

interface HostedBinding {
  binding: UnitBinding;
  port: MessagePort;
}

class HostedBindings {
  private readonly hosted = new Map<string, HostedBinding>();
  private readonly intercept: (transport: WorkerTransport) => void;
  private unit?: WorkerUnit;
  private queue: Promise<void> = Promise.resolve();

  constructor(intercept: (transport: WorkerTransport) => void) {
    this.intercept = intercept;
  }

  initial(entries: readonly ThreadEntry[]): UnitBinding[] {
    return entries.flatMap((entry) =>
      entry.port === null ? [] : [this.host(entry, entry.port)],
    );
  }

  bind(unit: WorkerUnit): void {
    this.unit = unit;
  }

  apply(entries: readonly ThreadEntry[]): Promise<void> {
    this.queue = this.queue.then(() => this.reconcile(entries));
    return this.queue;
  }

  close(): void {
    for (const { port } of this.hosted.values()) port.close();
  }

  private host(entry: ThreadEntry, port: MessagePort): UnitBinding {
    const transport = portTransport(port);
    this.intercept(transport);
    const binding = { transport, client_secret: entry.client_secret };
    this.hosted.set(entry.client_id, { binding, port });
    return binding;
  }

  private async reconcile(entries: readonly ThreadEntry[]): Promise<void> {
    const listed = new Map(entries.map((entry) => [entry.client_id, entry]));
    const removals = [...this.hosted].flatMap(([clientId, hosted]) => {
      const entry = listed.get(clientId);
      return !entry || entry.state === BindingEntryState.Draining
        ? [this.remove(clientId, hosted)]
        : [];
    });
    const additions = entries.flatMap((entry) =>
      this.hosted.has(entry.client_id) ||
      entry.state === BindingEntryState.Draining ||
      entry.port === null
        ? []
        : [this.add(this.host(entry, entry.port))],
    );
    await Promise.all([...removals, ...additions]);
  }

  private async add(binding: UnitBinding): Promise<void> {
    assert.equal(await this.unit!.add(binding), null);
  }

  private async remove(clientId: string, hosted: HostedBinding): Promise<void> {
    this.hosted.delete(clientId);
    await this.unit!.remove(hosted.binding);
    hosted.port.close();
  }
}

class ModelUnit implements SlotInstance {
  readonly exited: Promise<SlotExit>;
  ended = false;
  private readonly unit: WorkerUnit;
  private readonly hosted: HostedBindings;

  constructor(launch: SlotLaunch, host: UnitHost) {
    const name = launch.instance.name;
    const env = threadEnvironment(launch.environment, launch.root);
    const state = directories(env).state;
    linkPiTools(state);
    const wire = threadEntries(launch.entries);
    this.hosted = new HostedBindings((transport) =>
      this.hold(transport, name, host),
    );
    this.unit = new WorkerUnit({
      bindings: this.hosted.initial(wire),
      directories: { data: state, log: state },
      env,
      log: () => {},
      model_runtime_factory: host.runtime(name),
      repository_transport: host.repository,
    });
    this.hosted.bind(this.unit);
    this.exited = this.run(wire);
  }

  control(kind: SlotControl["kind"]): void {
    if (kind === SlotControl.Drain) void this.unit.drain();
    else void this.unit.stop();
  }

  bindings(entries: readonly SlotEntry[]): void {
    void this.hosted.apply(threadEntries(entries));
  }

  terminate(): void {
    void this.unit.stop();
  }

  crash(): void {
    this.hosted.close();
    void this.unit.stop();
  }

  private hold(transport: WorkerTransport, name: string, host: UnitHost): void {
    const handover = transport.worker.handover;
    const worker: Record<string, unknown> = transport.worker;
    worker.handover = async (...args: Parameters<typeof handover>) => {
      await host.handoverHold(name);
      return handover(...args);
    };
  }

  private async run(wire: ThreadEntry[]): Promise<SlotExit> {
    const started = await this.unit.start();
    if (!started) await this.hosted.apply(wire);
    const error = started
      ? ((await this.unit.stop()) ?? started)
      : await this.unit.run();
    this.ended = true;
    return { code: error ? FAILED_CODE : CLEAN_CODE, error };
  }
}

class ModelThreadDriver implements SlotDriver, UnitHost {
  readonly placement = PoolPlacement.Server;
  readonly units = new Map<string, ModelUnit[]>();
  readonly repository: RepositoryTransport;
  private readonly gates: Gates;
  private readonly holds = new Map<string, Promise<void>>();

  constructor(repository: RepositoryTransport, gates: Gates) {
    this.repository = repository;
    this.gates = gates;
  }

  check() {
    return Promise.resolve(alwaysAvailable(this.placement));
  }

  prepare(): Promise<void> {
    return Promise.resolve();
  }

  removeVolume(): Promise<void> {
    return Promise.resolve();
  }

  sweepVolumes(): Promise<void> {
    return Promise.resolve();
  }

  launch(launch: SlotLaunch): SlotInstance {
    const unit = new ModelUnit(launch, this);
    const name = launch.instance.name;
    this.units.set(name, [...(this.units.get(name) ?? []), unit]);
    return unit;
  }

  runtime(instanceName: string): ModelRuntimeFactory {
    const command = `until [ -e "${this.gates.path(instanceName)}" ]; do sleep ${GATE_POLL_SECONDS}; done; printf ${HELLO} > hello.txt`;
    return (input) =>
      scriptedModelRuntime(
        scriptedProvider([
          fauxAssistantMessage(fauxToolCall(BASH, { command }), {
            stopReason: TOOL_USE,
          }),
          fauxAssistantMessage(DONE),
        ]),
      )(input);
  }

  handoverHold(instanceName: string): Promise<void> | undefined {
    return this.holds.get(instanceName);
  }

  holdHandover(instanceName: string): () => void {
    const hold = Promise.withResolvers<void>();
    this.holds.set(instanceName, hold.promise);
    return () => hold.resolve();
  }

  launched(instanceName: string): ModelUnit[] {
    return this.units.get(instanceName) ?? [];
  }

  crash(): void {
    const live = [...this.units.values()].flat().filter((unit) => !unit.ended);
    for (const unit of live) unit.crash();
  }
}

function repositoryOf(bare: string): RepositoryTransport {
  const configure = async (directory: string) => {
    const git = simpleGit(directory);
    await git.addConfig("user.name", GIT_NAME);
    await git.addConfig("user.email", GIT_EMAIL);
  };
  return {
    ...localTransport,
    clone: async (_address, directory, context, deadlineMs, ssh) => {
      await localTransport.clone(bare, directory, context, deadlineMs, ssh);
      await configure(directory);
    },
    cloneSnapshot: (_address, revision, directory, context, deadlineMs, ssh) =>
      localTransport.cloneSnapshot(
        bare,
        revision,
        directory,
        context,
        deadlineMs,
        ssh,
      ),
  };
}

function workerBinding(instances: readonly string[]) {
  return {
    kind: "worker",
    config: {
      worker: INSTANCE_WORKER,
      worker_instances: [...instances],
      entries: [{ agent: "swe@1", ...CONFIGURATION }],
    },
  };
}

interface ServerOptions {
  bare: string;
  gates: Gates;
  path?: string;
  stateDirectory?: string;
  masterKey?: string;
}

async function startServer(t: TestContext, options: ServerOptions) {
  requirePiTools();
  const driver = new ModelThreadDriver(
    repositoryOf(options.bare),
    options.gates,
  );
  const fixture = await gatewayFixture(t, {
    repositoryConnector: { gitLsRemote: async () => {} },
    serverSlotDriver: driver,
    path: options.path,
    stateDirectory: options.stateDirectory,
    masterKey: options.masterKey,
  });
  const call = humanCaller(fixture);
  const empty = { params: {}, query: {} };

  const registrations = async () =>
    (
      await call(workerOperations["registration.list"], {
        params: {},
        query: {},
        body: null,
      })
    ).items;
  const executions = async (projectId: string, nodeId?: string) =>
    (
      await call(schedulerOperations.executionList, {
        params: { project_id: projectId },
        query: nodeId === undefined ? {} : { node_id: nodeId },
        body: null,
      })
    ).items;
  const running = async (projectId: string) =>
    (await executions(projectId)).filter(
      (item) => item.claim_state === ClaimState.Running,
    );
  const nodeOf = (nodeId: string) =>
    call(missionOperations["node.get"], {
      params: { node_id: nodeId },
      query: {},
      body: null,
    });
  const rootOf = async (executionId: string) => {
    const [summary] = (
      await call(trackingOperations.traceList, {
        params: {},
        query: { execution_id: executionId },
        body: null,
      })
    ).items;
    assert.ok(summary);
    const spans = (
      await call(trackingOperations.spanList, {
        params: { trace_id: summary.trace_id },
        query: {},
        body: null,
      })
    ).items;
    const root = spans.find((span) => span.parent_span_id === null);
    assert.ok(root);
    return { summary, root, spans };
  };
  const instanceOf = async (executionId: string) =>
    (await rootOf(executionId)).root.attributes[WORKER_INSTANCE_ATTRIBUTE];
  const repositories = new Map<string, string>();
  const rewrite = async (projectId: string, instances: readonly string[]) => {
    const current = await call(projectOperations["bindingSet.get"], {
      params: { project_id: projectId },
      query: {},
      body: null,
    });
    const written = await call(projectOperations["bindingSet.write"], {
      params: { project_id: projectId },
      query: {},
      body: {
        version: current.version,
        bindings: {
          ...current.bindings,
          [GENERAL]: workerBinding(instances),
        } as never,
      },
    });
    repositories.set(projectId, written.bindings[REPOSITORY_BINDING]!.id);
    return written;
  };
  const project = async (name: string, instances: readonly string[]) => {
    const created = await call(projectOperations.create, {
      ...empty,
      body: { name },
    });
    const written = await call(projectOperations["bindingSet.write"], {
      params: { project_id: created.id },
      query: {},
      body: {
        version: FIRST_VERSION,
        bindings: {
          ...COVERING_WORKER_BINDINGS,
          [REPOSITORY_BINDING]: {
            kind: "repository",
            config: {
              available: true,
              platform: "github",
              address: "git@github.com:owner/repo.git",
              ssh_credential: "github-ssh",
              strategy: { base_branch: "main" },
              credential: "github",
            },
          },
          [GENERAL]: workerBinding(instances),
        } as never,
      },
    });
    repositories.set(created.id, written.bindings[REPOSITORY_BINDING]!.id);
    return created.id;
  };
  const node = async (projectId: string, filename: string) => {
    const mission = await call(missionOperations.get, {
      params: { project_id: projectId },
      query: {},
      body: null,
    });
    const created = await call(missionOperations["node.create"], {
      params: { mission_id: mission.id },
      query: {},
      body: {
        filename,
        content: {
          ...NODE,
          intent: Intent.Implement,
          bindings: [repositories.get(projectId)!],
        },
        tasks: [],
        reason: "plan",
        expected_mission_version: mission.version,
      },
    });
    return created.revisions[0]!.node_id;
  };
  const instance = (name: string) =>
    call(workerOperations["instance.get"], {
      params: { instance_name: name },
      query: {},
      body: null,
    });
  const archive = async (name: string, force: boolean) =>
    httpClient(
      { operation: workerOperations["instance.archive"] },
      fixture.endpoint,
      fixture.token,
    ).operation({
      params: { instance_name: name },
      query: {},
      body: {
        expected_revision: (await instance(name)).revision,
        ...(force ? { force } : {}),
      },
    });
  return {
    fixture,
    driver,
    call,
    registrations,
    executions,
    running,
    nodeOf,
    rootOf,
    instanceOf,
    rewrite,
    project,
    node,
    instance,
    archive,
  };
}

type Server = Awaited<ReturnType<typeof startServer>>;

async function provision(server: Server, instances: readonly string[]) {
  const { fixture, call } = server;
  await call(llmOperations.create, {
    params: {},
    query: {},
    body: {
      name: CREDENTIAL,
      platform: "anthropic",
      metadata: null,
      secret: { key: PROVIDER_KEY },
    },
  });
  await enableCoveringAgents(
    { KANTHORD_ENDPOINT: fixture.endpoint, KANTHORD_TOKEN: fixture.token },
    {
      platform: "anthropic",
      credential: CREDENTIAL,
      configuration: CONFIGURATION,
    },
  );
  await provisionRepositoryCredentials(fixture);
  for (const name of instances)
    await call(workerOperations["instance.create"], {
      params: {},
      query: {},
      body: {
        name,
        worker: INSTANCE_WORKER,
        placement: InstancePlacement.Server,
      },
    });
}

async function scenario(t: TestContext, instances: readonly string[]) {
  const { bare } = await bareRepository(t, "instance-model");
  const gates = new Gates(join(temporary(t), "gates"));
  const server = await startServer(t, { bare, gates });
  await provision(server, instances);
  return { ...server, gates, signal: t.signal };
}

function finished(items: { claim_state: ClaimState }[]): number {
  return items.filter((item) => item.claim_state === ClaimState.Finished)
    .length;
}

test(
  "two server instances listed by one binding take two nodes at once, a third node waits, and each root span names its instance",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const s = await scenario(t, [FIRST_INSTANCE, SECOND_INSTANCE]);
    const project = await s.project("pair", [FIRST_INSTANCE, SECOND_INSTANCE]);
    const nodes = [
      await s.node(project, "implement-1.md"),
      await s.node(project, "implement-2.md"),
      await s.node(project, "implement-3.md"),
    ];
    s.fixture.worker.startPool();

    const taken = await until(
      () => s.running(project),
      (items) => items.length === TWO_ITEMS,
      s.signal,
    );
    await delay(SETTLE_MS);
    assert.equal((await s.running(project)).length, TWO_ITEMS);
    const waiting = nodes.filter(
      (id) => !taken.some((item) => item.node_id === id),
    );
    assert.equal(waiting.length, SINGLE_ITEM);
    assert.deepEqual(await s.executions(project, waiting[0]), []);
    const names = await Promise.all(
      taken.map((item) =>
        until(
          () => s.instanceOf(item.execution_id),
          (name) => name !== undefined,
          s.signal,
        ),
      ),
    );
    assert.deepEqual(names.sort(), [FIRST_INSTANCE, SECOND_INSTANCE]);

    s.gates.open(FIRST_INSTANCE);
    s.gates.open(SECOND_INSTANCE);
    await until(
      () => s.executions(project),
      (items) => finished(items) === THREE_ITEMS,
      s.signal,
    );
  },
);

test(
  "an instance listed by two bindings of two projects holds two registrations and runs one execution at a time",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const s = await scenario(t, [FIRST_INSTANCE]);
    const first = await s.project("first", [FIRST_INSTANCE]);
    const second = await s.project("second", [FIRST_INSTANCE]);
    await s.node(first, "implement-1.md");
    await s.node(second, "implement-1.md");
    s.fixture.worker.startPool();

    const held = await until(
      () => s.registrations(),
      (items) => items.length === TWO_ITEMS,
      s.signal,
    );
    assert.deepEqual(
      held.map((item) => item.name),
      [FIRST_INSTANCE, FIRST_INSTANCE],
    );
    assert.equal(new Set(held.map((item) => item.project_id)).size, TWO_ITEMS);
    await until(
      async () =>
        (await s.running(first)).length + (await s.running(second)).length,
      (count) => count === SINGLE_ITEM,
      s.signal,
    );
    await delay(SETTLE_MS);
    const activities = (await s.registrations()).map((item) => item.activity);
    assert.equal(
      activities.filter((item) => item === RegistrationActivity.Executing)
        .length,
      SINGLE_ITEM,
    );
    assert.equal(
      (await s.running(first)).length + (await s.running(second)).length,
      SINGLE_ITEM,
    );
    assert.equal(s.driver.launched(FIRST_INSTANCE).length, SINGLE_ITEM);

    s.gates.open(FIRST_INSTANCE);
    for (const project of [first, second])
      await until(
        () => s.executions(project),
        (items) => finished(items) === SINGLE_ITEM,
        s.signal,
      );
  },
);

test(
  "a binding write that removes an instance drains its registration after the live execution and the instance keeps running",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const s = await scenario(t, [FIRST_INSTANCE, SECOND_INSTANCE]);
    const project = await s.project("drain", [FIRST_INSTANCE, SECOND_INSTANCE]);
    await s.node(project, "implement-1.md");
    await s.node(project, "implement-2.md");
    s.fixture.worker.startPool();
    await until(
      () => s.running(project),
      (items) => items.length === TWO_ITEMS,
      s.signal,
    );
    const busy = await until(
      () => s.registrations(),
      (items) =>
        items.filter((item) => item.activity === RegistrationActivity.Executing)
          .length === TWO_ITEMS,
      s.signal,
    );
    const removed = busy.find((item) => item.name === SECOND_INSTANCE)!;

    await s.rewrite(project, [FIRST_INSTANCE]);
    await delay(SETTLE_MS);
    const draining = (await s.registrations()).find(
      (item) => item.name === SECOND_INSTANCE,
    );
    assert.equal(draining?.runtime_identity, removed.runtime_identity);
    assert.equal(draining?.draining, true);
    assert.equal(draining?.activity, RegistrationActivity.Executing);

    s.gates.open(SECOND_INSTANCE);
    await until(
      () => s.registrations(),
      (items) => !items.some((item) => item.name === SECOND_INSTANCE),
      s.signal,
    );
    const execution = (await s.executions(project)).find(
      (item) => item.execution_id === removed.execution_id,
    );
    assert.equal(execution?.claim_state, ClaimState.Finished);
    assert.equal(execution?.stop, null);
    assert.equal(s.driver.launched(SECOND_INSTANCE).length, SINGLE_ITEM);
    assert.equal(s.driver.launched(SECOND_INSTANCE)[0]!.ended, false);

    const next = await s.node(project, "implement-3.md");
    await delay(SETTLE_MS);
    assert.deepEqual(await s.executions(project, next), []);
    s.gates.open(FIRST_INSTANCE);
    const claimed = await until(
      () => s.executions(project, next),
      (items) => items.length === SINGLE_ITEM,
      s.signal,
    );
    assert.equal(
      await until(
        () => s.instanceOf(claimed[0]!.execution_id),
        (name) => name !== undefined,
        s.signal,
      ),
      FIRST_INSTANCE,
    );
    assert.equal(s.driver.launched(SECOND_INSTANCE)[0]!.ended, false);
  },
);

test(
  "a binding write to an empty list during an execution ends no registration, keeps the handover and the inference grant, and gives the binding no new claim",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const s = await scenario(t, [FIRST_INSTANCE]);
    const project = await s.project("empty", [FIRST_INSTANCE]);
    const release = s.driver.holdHandover(FIRST_INSTANCE);
    const nodeId = await s.node(project, "implement-1.md");
    s.fixture.worker.startPool();
    const [claim] = await until(
      () => s.running(project),
      (items) => items.length === SINGLE_ITEM,
      s.signal,
    );
    assert.deepEqual(claim!.credentials, []);
    const [before] = await s.registrations();

    await s.rewrite(project, []);
    await delay(SETTLE_MS);
    const [after, ...rest] = await s.registrations();
    assert.deepEqual(rest, []);
    assert.equal(after?.runtime_identity, before?.runtime_identity);
    assert.equal(after?.registered, true);
    assert.equal(after?.draining, true);

    s.gates.open(FIRST_INSTANCE);
    release();
    const done = await until(
      () => s.executions(project, nodeId),
      (items) => finished(items) === SINGLE_ITEM,
      s.signal,
    );
    assert.equal(done[0]?.execution_id, claim!.execution_id);
    assert.ok(done[0]?.credentials.length);
    assert.equal(done[0]?.stop, null);
    assert.equal((await s.nodeOf(nodeId)).state, NodeState.Waiting);

    const next = await s.node(project, "implement-2.md");
    await delay(SETTLE_MS);
    assert.deepEqual(await s.executions(project, next), []);
  },
);

test(
  "an archive of an instance that a binding lists refuses with the bindings",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const s = await scenario(t, [FIRST_INSTANCE]);
    const project = await s.project("listed", [FIRST_INSTANCE]);

    for (const force of [false, true]) {
      const refused = await s.archive(FIRST_INSTANCE, force);
      assert.equal(refused.type, OperationResultType.Failure);
      assert.ok(refused.type === OperationResultType.Failure);
      assert.equal(refused.status, HttpStatus.Conflict);
      assert.equal(refused.error.error.code, WorkerErrorCode.InstanceInUse);
      assert.deepEqual(refused.error.error.details, {
        bindings: [{ project_id: project, binding: GENERAL }],
      });
    }
  },
);

test(
  "a forced archive of a busy instance that no binding lists returns its node to Available and stops its thread, and a later claim of another instance takes the node",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const s = await scenario(t, [FIRST_INSTANCE, SECOND_INSTANCE]);
    const project = await s.project("forced", [FIRST_INSTANCE]);
    const nodeId = await s.node(project, "implement-1.md");
    s.fixture.worker.startPool();
    const [claim] = await until(
      () => s.running(project),
      (items) => items.length === SINGLE_ITEM,
      s.signal,
    );
    const attempt = (await s.nodeOf(nodeId)).attempt;
    await s.rewrite(project, []);

    const archived = await s.archive(FIRST_INSTANCE, true);
    assert.equal(archived.type, OperationResultType.Completed);
    await Promise.all(
      s.driver.launched(FIRST_INSTANCE).map((unit) => unit.exited),
    );
    assert.ok(s.driver.launched(FIRST_INSTANCE).every((unit) => unit.ended));
    assert.notEqual((await s.instance(FIRST_INSTANCE)).ended_at, null);

    const [revoked] = await s.executions(project, nodeId);
    assert.equal(revoked?.execution_id, claim!.execution_id);
    assert.equal(revoked?.claim_state, ClaimState.Finished);
    assert.equal(revoked?.stop, null);
    const node = await s.nodeOf(nodeId);
    assert.equal(node.state, NodeState.Available);
    assert.equal(node.attempt, attempt);
    const trace = await s.rootOf(claim!.execution_id);
    assert.equal(trace.root.attributes[END_ATTRIBUTE], ExecutionEnd.Revoked);
    assert.equal(trace.root.attributes[CAUSE_ATTRIBUTE], RevokeCause.Human);
    assert.deepEqual(
      trace.spans.filter(
        (span) =>
          span.parent_span_id !== null &&
          span.attributes["kanthord.transition.failure_count"] !== undefined,
      ),
      [],
    );

    s.gates.open(SECOND_INSTANCE);
    await s.rewrite(project, [SECOND_INSTANCE]);
    const taken = await until(
      () => s.executions(project, nodeId),
      (items) => items.length === TWO_ITEMS,
      s.signal,
    );
    const next = taken.find(
      (item) => item.execution_id !== claim!.execution_id,
    );
    assert.ok(next);
    assert.equal(next.attempt, attempt);
    assert.equal(
      await until(
        () => s.instanceOf(next.execution_id),
        (name) => name !== undefined,
        s.signal,
      ),
      SECOND_INSTANCE,
    );
  },
);

test(
  "a server restart starts each live server instance again under the same client identities and resumes a running execution",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { bare } = await bareRepository(t, "instance-model");
    const gates = new Gates(join(temporary(t), "gates"));
    const directory = temporary(t);
    const stored = {
      bare,
      gates,
      path: join(directory, "kanthord.db"),
      stateDirectory: join(directory, "state"),
    };
    mkdirSync(stored.stateDirectory);
    let masterKey = "";
    let projectId = "";
    let nodeId = "";
    let claimId = "";
    let identities: string[] = [];

    await t.test(
      "the first server crashes while an instance executes",
      async (u) => {
        const server = await startServer(u, stored);
        masterKey = server.fixture.masterKey;
        await provision(server, [FIRST_INSTANCE, SECOND_INSTANCE]);
        projectId = await server.project("restart", [
          FIRST_INSTANCE,
          SECOND_INSTANCE,
        ]);
        nodeId = await server.node(projectId, "implement-1.md");
        server.fixture.worker.startPool();
        const [claim] = await until(
          () => server.running(projectId),
          (items) => items.length === SINGLE_ITEM,
          u.signal,
        );
        claimId = claim!.execution_id;
        identities = (await server.registrations())
          .map((item) => item.client_id!)
          .sort();
        assert.equal(identities.length, TWO_ITEMS);
        server.driver.crash();
      },
    );

    await t.test(
      "the second server resumes the running execution",
      async (u) => {
        const server = await startServer(u, { ...stored, masterKey });
        server.fixture.worker.startPool();
        gates.open(FIRST_INSTANCE);
        gates.open(SECOND_INSTANCE);
        const [first] = await server.running(projectId);
        assert.equal(first?.execution_id, claimId);
        const done = await until(
          () => server.executions(projectId, nodeId),
          (items) => finished(items) === SINGLE_ITEM,
          u.signal,
        );
        assert.equal(done.length, SINGLE_ITEM);
        assert.equal(done[0]?.execution_id, claimId);
        assert.equal(done[0]?.stop, null);
        for (const name of [FIRST_INSTANCE, SECOND_INSTANCE])
          assert.equal(server.driver.launched(name).length, SINGLE_ITEM);
        const again = (await server.registrations())
          .map((item) => item.client_id!)
          .sort();
        assert.deepEqual(again, identities);
      },
    );
  },
);

test(
  "a third server instance create refuses at worker.server_instance_limit",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = await gatewayFixture(t, {
      serverInstanceLimit: SERVER_LIMIT,
    });
    const create = (name: string) =>
      httpClient(
        { operation: workerOperations["instance.create"] },
        fixture.endpoint,
        fixture.token,
      ).operation({
        params: {},
        query: {},
        body: {
          name,
          worker: INSTANCE_WORKER,
          placement: InstancePlacement.Server,
        },
      });

    for (const name of [FIRST_INSTANCE, SECOND_INSTANCE])
      assert.equal((await create(name)).type, OperationResultType.Completed);
    const refused = await create(THIRD_INSTANCE);

    assert.ok(refused.type === OperationResultType.Failure);
    assert.equal(refused.status, HttpStatus.Conflict);
    assert.equal(refused.error.error.code, WorkerErrorCode.InstanceServerLimit);
  },
);

test(
  "a container runtime that answers runtime_absent refuses an instance create at the container placement",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fake = fakeContainerHost(t);
    const fixture = await gatewayFixture(t, {
      containerRuntimeHost: { ...fake.host, resolves: () => false },
    });

    const refused = await httpClient(
      { operation: workerOperations["instance.create"] },
      fixture.endpoint,
      fixture.token,
    ).operation({
      params: {},
      query: {},
      body: {
        name: FIRST_INSTANCE,
        worker: INSTANCE_WORKER,
        placement: InstancePlacement.Container,
      },
    });

    assert.ok(refused.type === OperationResultType.Failure);
    assert.equal(refused.status, HttpStatus.Conflict);
    assert.equal(
      refused.error.error.code,
      WorkerErrorCode.InstancePlacementUnavailable,
    );
    assert.deepEqual(refused.error.error.details, {
      placement: InstancePlacement.Container,
      reason: PlacementIssue.RuntimeAbsent,
    });
  },
);

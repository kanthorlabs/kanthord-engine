import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { z } from "zod";
import { agentOperations } from "../../agent/contract.ts";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import { httpClient } from "../../gateway/client.ts";
import { CancellationContext } from "../../kernel/context.ts";
import {
  OperationResultType,
  type ClientOptions,
  type Operation,
  type OperationResult,
} from "../../kernel/operation.ts";
import {
  Intent,
  missionOperations,
  NodeState,
} from "../../mission/contract.ts";
import {
  environmentTagOf,
  ImageBuildOutcome,
  PROVED_SUFFIX,
  ProofPhase,
  type CommandResult,
  type EnvironmentRuntime,
  type EnvironmentState,
  type ProofInput,
} from "../../project/environment-state.ts";
import {
  BindingKind,
  BindingState,
  EnvironmentStatus,
  EnvironmentTarget,
  FailureOrigin,
  EnvironmentFailureClass,
  projectOperations,
  workerResourceIdentity,
  type RepositoryFiles,
} from "../../project/contract.ts";
import { repositoryFiles } from "../../repository/index.ts";
import { LOCAL_GIT_SSH_ACCESS } from "../../repository/test-sshd.ts";
import {
  ExecutionStopReason,
  schedulerOperations,
  WorkPullKind,
  type ReleaseStop,
} from "../../scheduler/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { fakeContainerHost } from "./container-fakes.ts";
import { until } from "./cli-support.ts";
import type { SlotDriver, SlotInstance } from "./slot-driver.ts";
import {
  bareRepository,
  gatewayFixture,
  humanCaller,
  provisionNativeAgent,
  provisionRepositoryCredentials,
} from "./test-support.ts";

type Fixture = Awaited<ReturnType<typeof gatewayFixture>>;

const TEST_TIMEOUT_MS = 120000;
const STATUS_WAIT_MS = 10000;
const SETTLE_WAIT_MS = 10000;
const FIRST_VERSION = 1;
const SINGLE_SLOT = 1;
const SECOND_SLOT = 2;
const FAILING_SETUP = "false";
const PASSING_SETUP = "true";
const BROKEN_ENVIRONMENT = { postCreateCommand: FAILING_SETUP };
const FIXED_ENVIRONMENT = { postCreateCommand: PASSING_SETUP };
const BASE_IMAGE = "mcr.microsoft.com/devcontainers/base:bookworm";
const OTHER_BASE_IMAGE = "mcr.microsoft.com/devcontainers/base:ubuntu";
const REPOSITORY_BINDING = "repo";
const WORKER_BINDING = "general";
const REVIEWER_BINDING = "reviewer";
const COMMAND_ABSENT_EXIT = 127;
const FAILED_COMMAND = "pnpm test";
const OLDER_DIGEST = "older_digest";
const CONTAINER_IMAGE = "kanthord-test";
const NO_ITEMS = 0;
const PASSED_EXIT = 0;
const FAILED_EXIT = 1;
const RUN_VERB = "run";
const VOLUME_VERB = "volume";
const CREATE_VERB = "create";
const HOST_PROOF_METHOD = "proveOnHost";
const NAME_OPTION = "--name";
const SLOT_NAME_PREFIX = "kanthord_slot_";
const CONFIGURATION = {
  agent_provider: "default",
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "off",
} as const;
const NODE_CONTENT = {
  name: "Work",
  requirement: "Do work",
  criterion: "Done",
  verifications: ["true"],
};
const NO_INPUT = { params: {}, query: {}, body: null };
const COMMAND_ABSENT_STOP = {
  reason: ExecutionStopReason.EnvironmentFailed,
  code: EnvironmentFailureClass.CommandAbsent,
} as const;

function completed<T>(result: OperationResult<T>): T {
  assert.equal(
    result.type,
    OperationResultType.Completed,
    JSON.stringify(result),
  );
  assert.ok(result.type === OperationResultType.Completed);
  return result.data;
}

function commandResult(phase: ProofPhase, command: string): CommandResult {
  return {
    phase,
    command,
    exit_code:
      phase === ProofPhase.Setup && command === FAILING_SETUP
        ? FAILED_EXIT
        : PASSED_EXIT,
    timed_out: false,
    output: "",
  };
}

function commandResults(input: ProofInput): CommandResult[] {
  return [
    ...input.setup.map((command) => commandResult(ProofPhase.Setup, command)),
    ...input.checks.map((command) => commandResult(ProofPhase.Check, command)),
  ];
}

function fakeEnvironmentRuntime() {
  const calls: { method: string; input: unknown }[] = [];
  const images = new Set<string>();
  const state: { gate: PromiseWithResolvers<void> | null } = { gate: null };
  const runtime: EnvironmentRuntime = {
    runtimeName: "podman",
    imageId: async (reference) => {
      calls.push({ method: "imageId", input: reference });
      return `sha256:${reference}`;
    },
    pullImage: async (reference) => {
      calls.push({ method: "pullImage", input: reference });
    },
    imageExists: async (tag) => images.has(tag),
    build: async (input, signal) => {
      calls.push({ method: "build", input });
      const held = state.gate?.promise;
      if (held !== undefined)
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          held.then(resolve, reject);
        });
      images.add(input.tag);
      return { outcome: ImageBuildOutcome.Built };
    },
    prove: async (input) => {
      calls.push({ method: "prove", input });
      return commandResults(input);
    },
    proveOnHost: async (input) => {
      calls.push({ method: "proveOnHost", input });
      return commandResults(input);
    },
    tagProved: async (tag) => {
      calls.push({ method: "tagProved", input: tag });
      images.add(`${tag}${PROVED_SUFFIX}`);
    },
    removeTags: async (tags) => {
      calls.push({ method: "removeTags", input: tags });
      for (const tag of tags) images.delete(tag);
    },
    collect: async () => {},
    removeStaleRuns: async () => {},
  };
  return {
    runtime,
    calls,
    hold: () => {
      state.gate = Promise.withResolvers<void>();
      return state.gate;
    },
  };
}

function localRepositoryFiles(bare: string): RepositoryFiles {
  return {
    resolveBranchCommit: (_address, branch, context, deadlineMs) =>
      repositoryFiles.resolveBranchCommit(
        bare,
        branch,
        context,
        deadlineMs,
        LOCAL_GIT_SSH_ACCESS,
      ),
    readFilesAtCommit: (
      _address,
      commit,
      paths,
      maxBytes,
      context,
      deadlineMs,
    ) =>
      repositoryFiles.readFilesAtCommit(
        bare,
        commit,
        paths,
        maxBytes,
        context,
        deadlineMs,
        LOCAL_GIT_SSH_ACCESS,
      ),
    listFilesAtCommit: (
      _address,
      commit,
      directory,
      limit,
      context,
      deadlineMs,
    ) =>
      repositoryFiles.listFilesAtCommit(
        bare,
        commit,
        directory,
        limit,
        context,
        deadlineMs,
        LOCAL_GIT_SSH_ACCESS,
      ),
    readObjectIds: (_address, commit, paths, context, deadlineMs) =>
      repositoryFiles.readObjectIds(
        bare,
        commit,
        paths,
        context,
        deadlineMs,
        LOCAL_GIT_SSH_ACCESS,
      ),
    cloneSnapshot: (_address, revision, directory, context, deadlineMs) =>
      repositoryFiles.cloneSnapshot(
        bare,
        revision,
        directory,
        context,
        deadlineMs,
        LOCAL_GIT_SSH_ACCESS,
      ),
  };
}

async function gateFixture(
  t: TestContext,
  options: Parameters<typeof gatewayFixture>[1],
) {
  const { bare } = await bareRepository(t, "environment_gate");
  const fixture = await gatewayFixture(t, {
    repositoryConnector: { gitLsRemote: async () => {} },
    repositoryFiles: localRepositoryFiles(bare),
    ...options,
  });
  await provisionRepositoryCredentials(fixture);
  await provisionNativeAgent(fixture);
  await humanCaller(fixture)(agentOperations["enablement.put"], {
    params: { agent_name: "re@1" },
    query: {},
    body: {
      agent_providers: [
        {
          name: CONFIGURATION.agent_provider,
          provider: "anthropic",
          credential: "native-credential",
        },
      ],
      default_configuration: CONFIGURATION,
      fallback_configurations: [],
    },
  });
  return fixture;
}

interface ProjectInput {
  name: string;
  placement: "server" | "container";
  instanceCount: number;
  environment?: unknown;
}

function bindingsOf(input: ProjectInput) {
  return {
    [REPOSITORY_BINDING]: {
      kind: "repository",
      config: {
        available: true,
        platform: "github",
        address: "git@github.com:owner/repo.git",
        ssh_credential: "github-ssh",
        strategy: { base_branch: "main" },
        credential: "github",
        ...(input.environment === undefined
          ? {}
          : { environment: input.environment }),
      },
    },
    [WORKER_BINDING]: {
      kind: "worker",
      config: {
        worker: "coder@1",
        placement: input.placement,
        instance_count: input.instanceCount,
        entries: [{ agent: "swe@1", ...CONFIGURATION }],
      },
    },
    [REVIEWER_BINDING]: {
      kind: "worker",
      config: {
        worker: "reviewer@1",
        placement: "server",
        instance_count: NO_ITEMS,
      },
    },
  };
}

async function createProject(fixture: Fixture, input: ProjectInput) {
  const call = humanCaller(fixture);
  const project = await call(projectOperations.create, {
    params: {},
    query: {},
    body: { name: input.name },
  });
  const written = await call(projectOperations["bindingSet.write"], {
    params: { project_id: project.id },
    query: {},
    body: { version: FIRST_VERSION, bindings: bindingsOf(input) as never },
  });
  const repository = written.bindings[REPOSITORY_BINDING];
  assert.ok(repository);
  return { id: project.id, repositoryId: repository.id };
}

async function importNode(
  fixture: Fixture,
  project: { id: string; repositoryId: string },
): Promise<string> {
  const call = humanCaller(fixture);
  const mission = await call(missionOperations.get, {
    params: { project_id: project.id },
    query: {},
    body: null,
  });
  const created = await call(missionOperations["node.create"], {
    params: { mission_id: mission.id },
    query: {},
    body: {
      filename: "implement-1.md",
      content: {
        ...NODE_CONTENT,
        intent: Intent.Implement,
        bindings: [project.repositoryId],
      },
      tasks: [],
      reason: "plan",
      expected_mission_version: mission.version,
    },
  });
  return created.revisions[0]!.node_id;
}

function environmentList(
  fixture: Fixture,
  projectId: string,
): Promise<EnvironmentState[]> {
  return humanCaller(fixture)(projectOperations["environment.list"], {
    params: { project_id: projectId },
    query: {},
    body: null,
  }).then((answer) => answer.items);
}

async function awaitStatus(
  t: TestContext,
  fixture: Fixture,
  projectId: string,
  status: EnvironmentStatus,
): Promise<EnvironmentState> {
  const signal = AbortSignal.any([
    t.signal,
    AbortSignal.timeout(STATUS_WAIT_MS),
  ]);
  const items = await until(
    () => environmentList(fixture, projectId),
    (found) => found.some((item) => item.status === status),
    signal,
  );
  return items.find((item) => item.status === status)!;
}

async function currentItem(
  fixture: Fixture,
  projectId: string,
): Promise<EnvironmentState> {
  const items = await environmentList(fixture, projectId);
  assert.equal(items.length, SINGLE_SLOT);
  return items[0]!;
}

async function repositoryBindingId(
  fixture: Fixture,
  projectId: string,
): Promise<string> {
  const page = await humanCaller(fixture)(projectOperations["binding.list"], {
    params: { project_id: projectId },
    query: { kind: [BindingKind.Repository], state: BindingState.Current },
    body: null,
  });
  assert.equal(page.items.length, SINGLE_SLOT);
  return page.items[0]!.id;
}

async function setEnvironment(
  fixture: Fixture,
  projectId: string,
  environment: unknown,
) {
  const bindingId = await repositoryBindingId(fixture, projectId);
  return humanCaller(fixture)(projectOperations["binding.environment.set"], {
    params: { project_id: projectId, binding_id: bindingId },
    query: {},
    body: { environment },
  });
}

async function rebuild(fixture: Fixture, projectId: string) {
  const item = await currentItem(fixture, projectId);
  return humanCaller(fixture)(
    projectOperations["binding.environment.rebuild"],
    {
      params: { project_id: projectId, binding_id: item.binding_id },
      query: {},
      body: null,
    },
  );
}

async function worker(
  t: TestContext,
  fixture: Fixture,
  projectId: string,
  nodeId: string,
) {
  const slot = await fixture.slotClient(projectId, WORKER_BINDING);
  const call = <T extends Operation>(
    operation: T,
    input: z.input<T["input"]>,
    options: ClientOptions = {},
  ) =>
    httpClient({ operation }, fixture.endpoint, slot.token).operation(
      input,
      options,
    );
  const { runtime_identity: runtimeIdentity } = completed(
    await call(workerOperations.register, NO_INPUT),
  );
  const pull = (options: ClientOptions = {}) =>
    call(
      schedulerOperations.workPull,
      {
        params: {},
        query: {},
        body: {
          resource_identity: workerResourceIdentity(WORKER_BINDING),
          runtime_identity: runtimeIdentity,
        },
      },
      options,
    );
  const bounded = () =>
    AbortSignal.any([t.signal, AbortSignal.timeout(STATUS_WAIT_MS)]);
  return {
    pull,
    release: async (executionId: string, stop: ReleaseStop) =>
      completed(
        await call(schedulerOperations.executionRelease, {
          params: { execution_id: executionId },
          query: {},
          body: { further_work: true, stop },
        }),
      ),
    claimed: async () => {
      const answer = completed(await pull());
      assert.equal(answer.kind, WorkPullKind.Claimed);
      assert.ok(answer.kind === WorkPullKind.Claimed);
      assert.equal(answer.execution.node_id, nodeId);
      return answer.execution.execution_id;
    },
    blocked: async () => {
      const context = new CancellationContext();
      const held = pull({ context });
      await Promise.race([
        until(
          () => fixture.scheduler.pulling(runtimeIdentity),
          Boolean,
          bounded(),
        ),
        held.then((answer) =>
          assert.fail(`the first pull answered ${JSON.stringify(answer)}`),
        ),
      ]);
      assert.equal(completed(await pull()).kind, WorkPullKind.NoWork);
      return {
        held,
        cancel: async () => {
          context.cancel();
          await held.catch(() => undefined);
        },
      };
    },
  };
}

function executionRows(fixture: Fixture, nodeId: string): number {
  const row = fixture.store.transaction(
    (tx) =>
      tx.database
        .prepare(
          "SELECT count(*) AS total FROM scheduler_execution WHERE node_id = ?",
        )
        .get(nodeId) as { total: number },
  );
  return row.total;
}

function availableAt(fixture: Fixture, nodeId: string): number | null {
  const row = fixture.store.transaction(
    (tx) =>
      tx.database
        .prepare("SELECT available_at FROM scheduler_job WHERE node_id = ?")
        .get(nodeId) as { available_at: number | null },
  );
  return row.available_at;
}

async function nodeState(fixture: Fixture, nodeId: string): Promise<string> {
  const node = await humanCaller(fixture)(missionOperations["node.get"], {
    params: { node_id: nodeId },
    query: {},
    body: null,
  });
  return node.state;
}

function failureDetail(command: string, digests: Record<string, string>) {
  return JSON.stringify({
    command,
    exit_code: COMMAND_ABSENT_EXIT,
    digests,
  });
}

test(
  "a broken host environment holds the node, a fixed one releases it, and an execution failure holds it until a rebuild",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const environment = fakeEnvironmentRuntime();
    const fixture = await gateFixture(t, {
      fakeSlots: true,
      environmentRuntime: environment.runtime,
    });
    const project = await createProject(fixture, {
      name: "environment-gate-host",
      placement: "server",
      instanceCount: SINGLE_SLOT,
    });
    const nodeId = await importNode(fixture, project);
    const client = await worker(t, fixture, project.id, nodeId);
    let executionId = "";
    let blocked: Awaited<ReturnType<typeof client.blocked>>;

    await t.test("a broken stored environment gates the pull", async () => {
      await setEnvironment(fixture, project.id, BROKEN_ENVIRONMENT);
      const failed = await awaitStatus(
        t,
        fixture,
        project.id,
        EnvironmentStatus.Failed,
      );
      assert.equal(failed.target, EnvironmentTarget.Host);
      assert.equal(failed.source, EnvironmentSource.Stored);
      assert.equal(failed.failure?.class, EnvironmentFailureClass.SetupFailed);
      assert.equal(failed.failure?.origin, FailureOrigin.Onboarding);
      assert.equal(failed.failure?.command, FAILING_SETUP);
      blocked = await client.blocked();
      assert.equal(executionRows(fixture, nodeId), NO_ITEMS);
      assert.ok(
        environment.calls.some((call) => call.method === HOST_PROOF_METHOD),
      );
    });

    await t.test("a fixed environment releases the pull", async () => {
      await setEnvironment(fixture, project.id, FIXED_ENVIRONMENT);
      await awaitStatus(t, fixture, project.id, EnvironmentStatus.Ready);
      const woken = completed(await blocked.held);
      assert.equal(woken.kind, WorkPullKind.Claimed);
      assert.ok(woken.kind === WorkPullKind.Claimed);
      assert.equal(woken.execution.node_id, nodeId);
      executionId = await client.claimed();
      assert.equal(executionId, woken.execution.execution_id);
    });

    await t.test(
      "an execution failure holds the node until a rebuild",
      async () => {
        const ready = await currentItem(fixture, project.id);
        assert.ok(ready.digest);
        await client.release(executionId, {
          ...COMMAND_ABSENT_STOP,
          detail: failureDetail(FAILED_COMMAND, {
            [ready.resource_identity]: ready.digest,
          }),
        });
        const failed = await currentItem(fixture, project.id);
        assert.equal(failed.status, EnvironmentStatus.Failed);
        assert.equal(failed.failure?.origin, FailureOrigin.Execution);
        assert.equal(
          failed.failure?.class,
          EnvironmentFailureClass.CommandAbsent,
        );
        assert.equal(failed.failure?.command, FAILED_COMMAND);
        assert.equal(failed.failure?.exit_code, COMMAND_ABSENT_EXIT);
        assert.equal(availableAt(fixture, nodeId), null);
        assert.notEqual(await nodeState(fixture, nodeId), NodeState.Paused);
        const gate = await client.blocked();
        await gate.cancel();

        await rebuild(fixture, project.id);
        await awaitStatus(t, fixture, project.id, EnvironmentStatus.Ready);
        const again = await client.claimed();
        assert.notEqual(again, executionId);

        const current = await currentItem(fixture, project.id);
        assert.ok(current.digest);
        await client.release(again, {
          ...COMMAND_ABSENT_STOP,
          detail: failureDetail(FAILED_COMMAND, {
            [current.resource_identity]: OLDER_DIGEST,
          }),
        });
        assert.equal(
          (await currentItem(fixture, project.id)).status,
          EnvironmentStatus.Ready,
        );
      },
    );

    await t.test(
      "an environment without a stored document fails on a stop that names its digest and holds the node",
      async () => {
        const bare = await createProject(fixture, {
          name: "environment-gate-bare",
          placement: "server",
          instanceCount: SINGLE_SLOT,
        });
        const bareNode = await importNode(fixture, bare);
        const bareClient = await worker(t, fixture, bare.id, bareNode);
        const none = await awaitStatus(
          t,
          fixture,
          bare.id,
          EnvironmentStatus.None,
        );
        assert.ok(none.digest);
        const first = await bareClient.claimed();
        await bareClient.release(first, {
          ...COMMAND_ABSENT_STOP,
          detail: failureDetail(FAILED_COMMAND, {
            [none.resource_identity]: none.digest,
          }),
        });
        assert.equal(
          (await currentItem(fixture, bare.id)).status,
          EnvironmentStatus.Failed,
        );
        const firstGate = await bareClient.blocked();
        await firstGate.cancel();
      },
    );
  },
);

interface SlotStart {
  clientId: string;
  slot: number;
  instance: SlotInstance;
}

function slotRuns(
  fake: ReturnType<typeof fakeContainerHost>,
  clientId?: string,
): string[][] {
  return fake
    .commands()
    .filter(
      (command) =>
        command[0] === RUN_VERB &&
        (clientId === undefined ||
          command[command.indexOf(NAME_OPTION) + 1] ===
            `${SLOT_NAME_PREFIX}${clientId}`),
    );
}

test(
  "a container slot starts only on the ready image of its environment, and a stop ends the slot wait",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const environment = fakeEnvironmentRuntime();
    const fake = fakeContainerHost(t);
    const starts: SlotStart[] = [];
    const wrap = (driver: SlotDriver): SlotDriver => ({
      placement: driver.placement,
      check: () => driver.check(),
      prepare: () => driver.prepare(),
      removeVolume: (clientId) => driver.removeVolume(clientId),
      sweepVolumes: (live) => driver.sweepVolumes(live),
      imageOf: (clientId) => driver.imageOf?.(clientId) ?? null,
      launch: (launch) => {
        const instance = driver.launch({
          ...launch,
          environment: fake.host.environment,
        });
        starts.push({
          clientId: launch.slot.client_id,
          slot: launch.slot.slot,
          instance,
        });
        return instance;
      },
    });
    const fixture = await gateFixture(t, {
      containerImage: CONTAINER_IMAGE,
      environmentRuntime: environment.runtime,
      containerRuntimeHost: fake.host,
      environmentDevcontainerCli: () => fake.cli,
      containerSlotDriver: wrap,
    });
    fixture.worker.startPool();
    const volumeCreated = (clientId: string) =>
      fake.calls.some(
        (call) =>
          call[0] === VOLUME_VERB &&
          call[1] === CREATE_VERB &&
          call.at(-1) === `${SLOT_NAME_PREFIX}${clientId}`,
      );
    const bounded = () =>
      AbortSignal.any([t.signal, AbortSignal.timeout(STATUS_WAIT_MS)]);

    const firstBuild = environment.hold();
    const project = await createProject(fixture, {
      name: "environment-gate-image",
      placement: "container",
      instanceCount: SINGLE_SLOT,
      environment: { image: BASE_IMAGE },
    });
    await awaitStatus(t, fixture, project.id, EnvironmentStatus.Building);
    await until(
      () => starts.length > NO_ITEMS && volumeCreated(starts[0]!.clientId),
      Boolean,
      bounded(),
    );
    assert.deepEqual(slotRuns(fake), []);
    assert.deepEqual(
      fake.calls.filter((call) => call[0] === RUN_VERB),
      [],
    );

    firstBuild.resolve();
    const ready = await awaitStatus(
      t,
      fixture,
      project.id,
      EnvironmentStatus.Ready,
    );
    assert.ok(ready.tag && ready.digest);
    assert.equal(
      ready.tag,
      environmentTagOf(ready.resource_identity, ready.digest),
    );
    const runs = await until(
      () => slotRuns(fake),
      (found) => found.length > NO_ITEMS,
      bounded(),
    );
    assert.equal(runs[0]![runs[0]!.indexOf("--") - 1], ready.tag);

    const before = starts.length;
    environment.hold();
    const current = await humanCaller(fixture)(
      projectOperations["bindingSet.get"],
      { params: { project_id: project.id }, query: {}, body: null },
    );
    await humanCaller(fixture)(projectOperations["bindingSet.write"], {
      params: { project_id: project.id },
      query: {},
      body: {
        version: current.version,
        bindings: bindingsOf({
          name: "environment-gate-image",
          placement: "container",
          instanceCount: SECOND_SLOT,
          environment: { image: OTHER_BASE_IMAGE },
        }) as never,
      },
    });
    await awaitStatus(t, fixture, project.id, EnvironmentStatus.Building);
    await until(
      () =>
        starts.length > before &&
        starts.slice(before).some((start) => volumeCreated(start.clientId)),
      Boolean,
      bounded(),
    );

    fixture.project.cancelEnvironmentRuns();
    await fixture.worker.stopPool();
    const later = starts.slice(before);
    await Promise.race([
      Promise.all(later.map((start) => start.instance.exited)),
      delay(SETTLE_WAIT_MS).then(() =>
        assert.fail("a slot wait outlived the stop"),
      ),
    ]);
    for (const start of later)
      assert.deepEqual(slotRuns(fake, start.clientId), []);
  },
);

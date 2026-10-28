import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import { missionOperations, NodeState } from "../../mission/contract.ts";
import {
  type CommandResult,
  type EnvironmentRuntime,
  type EnvironmentState,
  environmentTagOf,
  ImageBuildOutcome,
  type ProofInput,
  ProofPhase,
  PROVED_SUFFIX,
} from "../../project/environment-state.ts";
import {
  BindingKind,
  BindingState,
  EnvironmentFailureClass,
  EnvironmentStatus,
  EnvironmentTarget,
  FailureOrigin,
  projectOperations,
} from "../../project/contract.ts";
import { ExecutionStopReason, WorkPullKind } from "../../scheduler/contract.ts";
import { fakeContainerHost } from "./container-fakes-test-support.ts";
import { until } from "./cli-test-support.ts";
import { humanCaller } from "./test-support.ts";
import {
  awaitStatus,
  bindingsOf,
  completed,
  createProject,
  environmentList,
  type Fixture,
  gateFixture,
  importNode,
  NO_ITEMS,
  recordingSlotDriver,
  RUN_VERB,
  SINGLE_SLOT,
  SLOT_NAME_PREFIX,
  slotRuns,
  type SlotStart,
  worker,
} from "./environment-test-support.ts";

const TEST_TIMEOUT_MS = 120000;
const SETTLE_WAIT_MS = 10000;
const SECOND_SLOT = 2;
const SECOND_SLOT_INDEX = 1;
const FAILING_SETUP = "false";
const PASSING_SETUP = "true";
const BROKEN_ENVIRONMENT = { postCreateCommand: FAILING_SETUP };
const FIXED_ENVIRONMENT = { postCreateCommand: PASSING_SETUP };
const BASE_IMAGE = "mcr.microsoft.com/devcontainers/base:bookworm";
const OTHER_BASE_IMAGE = "mcr.microsoft.com/devcontainers/base:ubuntu";
const COMMAND_ABSENT_EXIT = 127;
const FAILED_COMMAND = "pnpm test";
const OLDER_DIGEST = "older_digest";
const CONTAINER_IMAGE = "kanthord-test";
const PASSED_EXIT = 0;
const FAILED_EXIT = 1;
const VOLUME_VERB = "volume";
const CREATE_VERB = "create";
const HOST_PROOF_METHOD = "proveOnHost";
const COMMAND_ABSENT_STOP = {
  reason: ExecutionStopReason.EnvironmentFailed,
  code: EnvironmentFailureClass.CommandAbsent,
} as const;

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
    cacheVolumes: async () => [],
    removeCacheVolume: async () => {},
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
      "an environment without a stored document fails on a stop that names its digest, keeps failing on a stop with no digests, and holds the node",
      async () => {
        const bare = await createProject(fixture, {
          name: "environment-gate-bare",
          placement: "server",
          instanceCount: SECOND_SLOT,
        });
        const bareNode = await importNode(fixture, bare);
        const otherNode = await importNode(fixture, bare, "implement-2.md");
        const bareClient = await worker(t, fixture, bare.id, bareNode);
        const otherClient = await worker(
          t,
          fixture,
          bare.id,
          otherNode,
          SECOND_SLOT_INDEX,
        );
        const none = await awaitStatus(
          t,
          fixture,
          bare.id,
          EnvironmentStatus.None,
        );
        assert.ok(none.digest);
        const first = await bareClient.claimed([bareNode, otherNode]);
        const second = await otherClient.claimed([bareNode, otherNode]);
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

        await otherClient.release(second, {
          ...COMMAND_ABSENT_STOP,
          detail: failureDetail(FAILED_COMMAND, {}),
        });
        assert.equal(
          (await currentItem(fixture, bare.id)).status,
          EnvironmentStatus.Failed,
        );
        const secondGate = await otherClient.blocked();
        await secondGate.cancel();
      },
    );
  },
);

test(
  "a container slot starts only on the ready image of its environment, and a stop ends the slot wait",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const environment = fakeEnvironmentRuntime();
    const fake = fakeContainerHost(t);
    const starts: SlotStart[] = [];
    const wrap = recordingSlotDriver(fake, starts);
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
      t.signal,
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
      t.signal,
    );
    assert.equal(runs[0]![runs[0]!.indexOf("--") - 1], ready.tag);

    const before = starts.length;
    const runsBefore = slotRuns(fake).length;
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
      t.signal,
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
    assert.deepEqual(slotRuns(fake).slice(runsBefore), []);
  },
);

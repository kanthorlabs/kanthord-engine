import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { z } from "zod";
import { agentOperations } from "../../agent/contract.ts";
import { httpClient } from "../../gateway/client.ts";
import { CancellationContext } from "../../kernel/context.ts";
import {
  OperationResultType,
  type ClientOptions,
  type Operation,
  type OperationResult,
} from "../../kernel/operation.ts";
import { Intent, missionOperations } from "../../mission/contract.ts";
import {
  EnvironmentStatus,
  projectOperations,
  workerResourceIdentity,
  type RepositoryFiles,
} from "../../project/contract.ts";
import type { EnvironmentState } from "../../project/environment-state.ts";
import { repositoryFiles } from "../../repository/index.ts";
import { LOCAL_GIT_SSH_ACCESS } from "../../repository/test-sshd.ts";
import {
  schedulerOperations,
  WorkPullKind,
  type ReleaseStop,
} from "../../scheduler/contract.ts";
import { workerOperations, type PoolSlot } from "../../worker/contract.ts";
import type { fakeContainerHost } from "./container-fakes.ts";
import { until } from "./cli-support.ts";
import type { SlotDriver, SlotInstance } from "./slot-driver.ts";
import {
  bareRepository,
  gatewayFixture,
  humanCaller,
  provisionNativeAgent,
  provisionRepositoryCredentials,
} from "./test-support.ts";

export type Fixture = Awaited<ReturnType<typeof gatewayFixture>>;

export const STATUS_WAIT_MS = 10000;
export const FIRST_VERSION = 1;
export const SINGLE_SLOT = 1;
export const FIRST_SLOT = 0;
export const REPOSITORY_BINDING = "repo";
export const WORKER_BINDING = "general";
export const REVIEWER_BINDING = "reviewer";
export const NO_ITEMS = 0;
export const RUN_VERB = "run";
export const NAME_OPTION = "--name";
export const SLOT_NAME_PREFIX = "kanthord_slot_";
export const CONFIGURATION = {
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

export function completed<T>(result: OperationResult<T>): T {
  assert.equal(
    result.type,
    OperationResultType.Completed,
    JSON.stringify(result),
  );
  assert.ok(result.type === OperationResultType.Completed);
  return result.data;
}

export function localRepositoryFiles(bare: string): RepositoryFiles {
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

export async function gateFixture(
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

export interface ProjectInput {
  name: string;
  placement: "server" | "container";
  instanceCount: number;
  environment?: unknown;
  workerEnvironment?: string;
}

export function bindingsOf(input: ProjectInput) {
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
        ...(input.workerEnvironment === undefined
          ? {}
          : { environment: input.workerEnvironment }),
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

export async function createProject(fixture: Fixture, input: ProjectInput) {
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

export async function importNode(
  fixture: Fixture,
  project: { id: string; repositoryId: string },
  filename = "implement-1.md",
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
      filename,
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

export function environmentList(
  fixture: Fixture,
  projectId: string,
): Promise<EnvironmentState[]> {
  return humanCaller(fixture)(projectOperations["environment.list"], {
    params: { project_id: projectId },
    query: {},
    body: null,
  }).then((answer) => answer.items);
}

export async function awaitStatus(
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

export async function worker(
  t: TestContext,
  fixture: Fixture,
  projectId: string,
  nodeId: string,
  slotIndex = FIRST_SLOT,
  given?: { token: string },
) {
  const slot =
    given ?? (await fixture.slotClient(projectId, WORKER_BINDING, slotIndex));
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
    claimed: async (expectedNodeIds = [nodeId]) => {
      const answer = completed(await pull());
      assert.equal(answer.kind, WorkPullKind.Claimed);
      assert.ok(answer.kind === WorkPullKind.Claimed);
      assert.ok(expectedNodeIds.includes(answer.execution.node_id));
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

export interface SlotStart {
  clientId: string;
  slot: number;
  poolSlot: PoolSlot;
  instance: SlotInstance;
}

export function slotRuns(
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

export function recordingSlotDriver(
  fake: ReturnType<typeof fakeContainerHost>,
  starts: SlotStart[],
): (driver: SlotDriver) => SlotDriver {
  return (driver) => ({
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
        poolSlot: launch.slot,
        instance,
      });
      return instance;
    },
  });
}

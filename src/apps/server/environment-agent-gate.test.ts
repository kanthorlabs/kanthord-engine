import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { agentOperations } from "../../agent/contract.ts";
import { loadPi } from "../../agent/pi.ts";
import { scriptedProvider } from "../../agent/test-support.ts";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import { stopAfter, temporary } from "../../kernel/test-support.ts";
import { createModelRuntime, resolveModel } from "../../llm/model-connector.ts";
import {
  BindingKind,
  BindingState,
  EnvironmentFailureClass,
  EnvironmentStatus,
  EnvironmentTarget,
  FailureOrigin,
  projectOperations,
} from "../../project/contract.ts";
import {
  type CommandResult,
  ENVIRONMENT_DIRECTORY,
  environmentPath,
  type EnvironmentRuntime,
  type EnvironmentState,
  environmentTagOf,
  ImageBuildOutcome,
  ProofFiles,
  type ProofInput,
  ProofOutcome,
  ProofPhase,
  PROVED_SUFFIX,
} from "../../project/environment-state.ts";
import type { EnvironmentModelRuntimeFactory } from "../../project/index.ts";
import { until } from "./cli-test-support.ts";
import {
  fakeContainerHost,
  fakeRepositoryFiles,
} from "./container-fakes-test-support.ts";
import {
  CONFIGURATION,
  createProject,
  environmentList,
  FIRST_SLOT,
  type Fixture,
  gateFixture,
  importNode,
  latestStarts,
  NO_ITEMS,
  recordingSlotDriver,
  RUN_VERB,
  SINGLE_SLOT,
  slotRuns,
  type SlotStart,
  worker,
} from "./environment-test-support.ts";
import { humanCaller } from "./test-support.ts";
import { join } from "node:path";

const TEST_TIMEOUT_MS = 120000;
const SETTLE_WAIT_MS = 500;
const CONTAINER_IMAGE = "kanthord-test";
const BASE_IMAGE = "mcr.microsoft.com/devcontainers/base:bookworm";
const UNIVERSAL_CHECK = "node --version";
const ENV_AGENT = "env@1";
const WRITE_TOOL = "environment_write";
const PROBE_TOOL = "probe";
const TOOL_USE = "toolUse";
const TOOL_RESULT_ROLE = "toolResult";
const MESSAGE_ENTRY = "message";
const COMMAND_ABSENT_EXIT = 127;
const FAILED_EXIT = 1;
const PASSED_EXIT = 0;
const ATTEMPT_LIMIT = 5;
const SIXTH_ATTEMPT = 6;
const ATTEMPT_LIMIT_REASON = "attempt_limit";
const FAILURE_COUNT = 4;
const FIRST_SESSION = 1;
const NO_REPAIRS = 0;
const PROBE_PIDS_LIMIT = "256";
const SETUP_FAILURE_COMMAND = "universal_setup";
const REPAIR_LIMIT = 3;
const SECOND_ATTEMPT_RUNS = 3;
const TEXT_ANSWER = "No repair is possible.";

function documentOf(tool: string) {
  return {
    image: BASE_IMAGE,
    customizations: { kanthord: { checks: [`${tool} --version`] } },
  };
}

function checkOf(tool: string): string {
  return `${tool} --version`;
}

function result(
  phase: ProofPhase,
  command: string,
  exitCode: number,
): CommandResult {
  return {
    phase,
    command,
    exit_code: exitCode,
    timed_out: false,
    output: "",
  };
}

function fakeEnvironmentRuntime(passing: ReadonlySet<string>) {
  const proves: ProofInput[] = [];
  const builds: unknown[] = [];
  const images = new Set<string>();
  const runtime: EnvironmentRuntime = {
    runtimeName: "podman",
    imageId: async (reference) => `sha256:${reference}`,
    pullImage: async () => {},
    imageExists: async (tag) => images.has(tag),
    build: async (input) => {
      builds.push(input.document);
      images.add(input.tag);
      return { outcome: ImageBuildOutcome.Built };
    },
    prove: async (input) => {
      proves.push(input);
      if (input.checks.includes(UNIVERSAL_CHECK))
        return [result(ProofPhase.Setup, SETUP_FAILURE_COMMAND, FAILED_EXIT)];
      return input.checks.map((command) =>
        result(
          ProofPhase.Check,
          command,
          passing.has(command) ? PASSED_EXIT : COMMAND_ABSENT_EXIT,
        ),
      );
    },
    proveOnHost: async () => [],
    tagProved: async (tag) => {
      images.add(`${tag}${PROVED_SUFFIX}`);
    },
    removeTags: async (tags) => {
      for (const tag of tags) images.delete(tag);
    },
    collect: async () => {},
    removeStaleRuns: async () => {},
    cacheVolumes: async () => [],
    removeCacheVolume: async () => {},
  };
  return { runtime, proves, builds };
}

async function recordSessionManagers(t: TestContext) {
  const { SessionManager } = await loadPi();
  const managers: ReturnType<typeof SessionManager.inMemory>[] = [];
  const original = SessionManager.inMemory;
  SessionManager.inMemory = (...input) => {
    const manager = original.apply(SessionManager, input);
    managers.push(manager);
    return manager;
  };
  stopAfter(t, () => {
    SessionManager.inMemory = original;
  });
  return managers;
}

function scriptedModel(
  script: FauxResponseStep[],
  managers: Awaited<ReturnType<typeof recordSessionManagers>>,
) {
  const provider = scriptedProvider(script);
  const record = { sessions: 0 };
  const factory: EnvironmentModelRuntimeFactory = async (input) => {
    record.sessions++;
    const runtime = await createModelRuntime(await loadPi(), input);
    runtime.registerNativeProvider(provider.provider);
    return { runtime, model: resolveModel(runtime, input.configuration) };
  };
  return { provider, record, factory, managers };
}

function toolCall(name: string, args: Parameters<typeof fauxToolCall>[1]) {
  return fauxToolCall(name, args);
}

function toolTurn(...calls: ReturnType<typeof toolCall>[]) {
  return fauxAssistantMessage(calls, { stopReason: TOOL_USE });
}

function writeTurn(...tools: string[]) {
  return toolTurn(
    ...tools.map((tool) =>
      toolCall(WRITE_TOOL, { environment: documentOf(tool) }),
    ),
  );
}

function toolAnswers(
  model: ReturnType<typeof scriptedModel>,
): Record<string, unknown>[] {
  return model.managers
    .flatMap((manager) => manager.getEntries())
    .flatMap((entry) =>
      entry.type === MESSAGE_ENTRY && entry.message.role === TOOL_RESULT_ROLE
        ? [entry.message.content]
        : [],
    )
    .map((content) => {
      const [part] = content as { type: string; text: string }[];
      return JSON.parse(part!.text) as Record<string, unknown>;
    });
}

async function enableEnvironmentAgent(fixture: Fixture): Promise<number> {
  const enabled = await humanCaller(fixture)(
    agentOperations["enablement.put"],
    {
      params: { agent_name: ENV_AGENT },
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
    },
  );
  return enabled.revision;
}

async function disableEnvironmentAgent(fixture: Fixture, revision: number) {
  await humanCaller(fixture)(agentOperations["enablement.disable"], {
    params: { agent_name: ENV_AGENT },
    query: {},
    body: { expected_revision: revision },
  });
}

interface AgentFixture {
  fixture: Fixture;
  environment: ReturnType<typeof fakeEnvironmentRuntime>;
  model: ReturnType<typeof scriptedModel>;
  podman: ReturnType<typeof fakeContainerHost>;
  starts: SlotStart[];
  proofs: ProofFiles;
  revision: number;
}

async function agentFixture(
  t: TestContext,
  script: FauxResponseStep[],
  passing: readonly string[] = [],
): Promise<AgentFixture> {
  const environment = fakeEnvironmentRuntime(new Set(passing));
  const model = scriptedModel(script, await recordSessionManagers(t));
  const podman = fakeContainerHost(t);
  const starts: SlotStart[] = [];
  const stateDirectory = temporary(t);
  const fixture = await gateFixture(t, {
    containerImage: CONTAINER_IMAGE,
    stateDirectory,
    repositoryFiles: fakeRepositoryFiles(),
    environmentRuntime: environment.runtime,
    containerRuntimeHost: podman.host,
    environmentDevcontainerCli: () => podman.cli,
    containerSlotDriver: recordingSlotDriver(podman, starts),
    environmentModelRuntimeFactory: model.factory,
  });
  const revision = await enableEnvironmentAgent(fixture);
  stopAfter(t, async () => {
    fixture.project.cancelEnvironmentRuns();
    await fixture.worker.stopPool();
  });
  return {
    fixture,
    environment,
    model,
    podman,
    starts,
    proofs: new ProofFiles(join(stateDirectory, ENVIRONMENT_DIRECTORY)),
    revision,
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

async function settledFailed(
  t: TestContext,
  fixture: Fixture,
  projectId: string,
  sessions: () => number,
): Promise<EnvironmentState> {
  await until(
    () => currentItem(fixture, projectId),
    (item) =>
      item.status === EnvironmentStatus.Failed &&
      !item.repairing &&
      sessions() >= FIRST_SESSION,
    t.signal,
  );
  return currentItem(fixture, projectId);
}

async function currentRepositoryBindingId(
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

async function bindingEnvironment(fixture: Fixture, projectId: string) {
  return humanCaller(fixture)(projectOperations["binding.environment.get"], {
    params: {
      project_id: projectId,
      binding_id: await currentRepositoryBindingId(fixture, projectId),
    },
    query: {},
    body: null,
  });
}

async function revisionEnvironments(
  fixture: Fixture,
  projectId: string,
): Promise<unknown[]> {
  const page = await humanCaller(fixture)(
    projectOperations["bindingRevision.list"],
    {
      params: {
        project_id: projectId,
        binding_id: await currentRepositoryBindingId(fixture, projectId),
      },
      query: {},
      body: null,
    },
  );
  return page.items.map(
    (item) => (item.config as { environment?: unknown }).environment,
  );
}

function containsDocument(documents: unknown[], tool: string): boolean {
  const expected = documentOf(tool);
  return documents.some((document) => {
    try {
      assert.deepEqual(document, expected);
      return true;
    } catch {
      return false;
    }
  });
}

function repositoryProject(fixture: Fixture, name: string) {
  return createProject(fixture, {
    name,
    placement: "container",
    instanceCount: SINGLE_SLOT,
  });
}

test(
  "an undetected repository reaches ready on the document of the second attempt with a scripted model and no network",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fetched: string[] = [];
    const nativeFetch = globalThis.fetch;
    t.mock.method(
      globalThis,
      "fetch",
      (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        fetched.push(input instanceof Request ? input.url : input.toString());
        return nativeFetch(input, init);
      },
    );
    const agent = await agentFixture(
      t,
      [
        toolTurn(toolCall(PROBE_TOOL, { command: "command -v node" })),
        writeTurn("tool_a"),
        writeTurn("tool_b"),
        fauxAssistantMessage(TEXT_ANSWER),
      ],
      [checkOf("tool_b")],
    );
    const { fixture, model, podman, starts } = agent;
    fixture.worker.startPool();
    const project = await repositoryProject(
      fixture,
      "environment-agent-repair",
    );
    const nodeId = await importNode(fixture, project);

    const ready = await until(
      () => currentItem(fixture, project.id),
      (item) => item.status === EnvironmentStatus.Ready && !item.repairing,
      t.signal,
    );
    assert.equal(ready.source, EnvironmentSource.Stored);
    assert.equal(ready.target, EnvironmentTarget.Image);
    assert.equal(ready.repairing, false);
    assert.ok(ready.tag && ready.digest);
    assert.equal(
      ready.tag,
      environmentTagOf(ready.resource_identity, ready.digest),
    );

    const stored = await bindingEnvironment(fixture, project.id);
    assert.equal(stored.source, EnvironmentSource.Stored);
    assert.deepEqual(stored.environment, documentOf("tool_b"));
    const revisions = await revisionEnvironments(fixture, project.id);
    assert.ok(containsDocument(revisions, "tool_b"));

    const [first, second] = agent.environment.proves.slice(1);
    assert.equal(agent.environment.proves.length, SECOND_ATTEMPT_RUNS);
    assert.deepEqual(first!.checks, [checkOf("tool_a")]);
    assert.deepEqual(second!.checks, [checkOf("tool_b")]);
    const [, firstWrite, secondWrite] = toolAnswers(model);
    assert.equal(firstWrite!.outcome, ProofOutcome.Failed);
    assert.equal(firstWrite!.class, EnvironmentFailureClass.CommandAbsent);
    assert.equal(secondWrite!.outcome, ProofOutcome.Passed);
    assert.equal(
      agent.proofs.read(environmentPath(ready.resource_identity), ready.digest)
        ?.outcome,
      ProofOutcome.Passed,
    );

    const firstStart = await until(() => starts[0], Boolean, t.signal);
    const imageOf = (run: string[]) => run[run.indexOf("--") - 1];
    const runs = await until(
      () => slotRuns(podman, firstStart!.instanceName),
      (found) => found.some((run) => imageOf(run) === ready.tag),
      t.signal,
    );
    assert.equal(imageOf(runs.at(-1)!), ready.tag);
    const slot = latestStarts(starts)[0]!;
    const client = await worker(t, fixture, project.id, nodeId, FIRST_SLOT, {
      token: await fixture.slotTokenOf(slot.instance, slot.entries[0]!),
    });
    await client.claimed();

    const probed = podman.calls.filter((call) => call[0] === RUN_VERB);
    const probe = probed.find((call) => call.includes("--network=none"));
    assert.ok(probe);
    assert.ok(probe.includes("--read-only"));
    assert.equal(probe[probe.indexOf("--pids-limit") + 1], PROBE_PIDS_LIMIT);
    assert.ok(fetched.some((url) => url.startsWith(fixture.endpoint)));
    assert.deepEqual(
      fetched.filter((url) => !url.startsWith(fixture.endpoint)),
      [],
    );
  },
);

test(
  "a sixth environment_write runs no run, writes no revision and ends the session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const agent = await agentFixture(t, [
      writeTurn("tool_1"),
      writeTurn("tool_2"),
      writeTurn("tool_3"),
      writeTurn("tool_4"),
      writeTurn("tool_5", "tool_6"),
      fauxAssistantMessage(TEXT_ANSWER),
    ]);
    const { fixture, model, environment } = agent;
    const project = await repositoryProject(fixture, "environment-agent-limit");
    await importNode(fixture, project);

    const failed = await settledFailed(
      t,
      fixture,
      project.id,
      () => model.record.sessions,
    );
    assert.equal(failed.status, EnvironmentStatus.Failed);
    assert.equal(failed.repairing, false);
    assert.equal(environment.proves.length, SINGLE_SLOT + ATTEMPT_LIMIT);
    assert.equal(
      environment.proves.some((run) =>
        run.checks.includes(checkOf(`tool_${SIXTH_ATTEMPT}`)),
      ),
      false,
    );
    const revisions = await revisionEnvironments(fixture, project.id);
    assert.equal(containsDocument(revisions, `tool_${SIXTH_ATTEMPT}`), false);
    for (let attempt = 1; attempt <= ATTEMPT_LIMIT; attempt++)
      assert.ok(containsDocument(revisions, `tool_${attempt}`));

    const answers = toolAnswers(model);
    const refused = answers.at(-1);
    assert.equal(answers.length, SIXTH_ATTEMPT);
    assert.equal(refused!.reason, ATTEMPT_LIMIT_REASON);
    assert.equal(refused!.outcome, null);
    assert.deepEqual(
      answers.slice(0, ATTEMPT_LIMIT).map((answer) => answer.outcome),
      Array(ATTEMPT_LIMIT).fill(ProofOutcome.Failed),
    );

    await delay(SETTLE_WAIT_MS);
    assert.equal(model.record.sessions, FIRST_SESSION);
    assert.equal((await currentItem(fixture, project.id)).repairing, false);
  },
);

test(
  "one digest gets at most 3 repair sessions",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const agent = await agentFixture(
      t,
      Array.from({ length: FAILURE_COUNT + FIRST_SESSION }, () =>
        fauxAssistantMessage(TEXT_ANSWER),
      ),
    );
    const { fixture, model, proofs } = agent;
    const project = await repositoryProject(fixture, "environment-agent-cap");
    await importNode(fixture, project);
    const failed = await settledFailed(
      t,
      fixture,
      project.id,
      () => model.record.sessions,
    );
    assert.ok(failed.digest);
    assert.equal(model.record.sessions, FIRST_SESSION);

    for (let failure = 0; failure < FAILURE_COUNT; failure++) {
      const started: boolean = model.record.sessions < REPAIR_LIMIT;
      fixture.project.environmentFailed({
        project_id: project.id,
        execution_id: `execution_${failure}`,
        resource_identities: [failed.resource_identity],
        stop: {
          code: EnvironmentFailureClass.CommandAbsent,
          detail: JSON.stringify({
            command: "pnpm test",
            exit_code: COMMAND_ABSENT_EXIT,
            digests: { [failed.resource_identity]: failed.digest },
          }),
        },
        digests: { [failed.resource_identity]: failed.digest },
      });
      assert.equal((await currentItem(fixture, project.id)).repairing, started);
      await until(
        () => currentItem(fixture, project.id),
        (item) => !item.repairing,
        t.signal,
      );
    }

    await delay(SETTLE_WAIT_MS);
    assert.equal(model.record.sessions, REPAIR_LIMIT);
    assert.equal(model.provider.calls.length, REPAIR_LIMIT);
    const proof = proofs.read(
      environmentPath(failed.resource_identity),
      failed.digest,
    );
    assert.equal(proof?.repairs, REPAIR_LIMIT);
    assert.equal(proof?.origin, FailureOrigin.Execution);
    assert.equal(
      (await currentItem(fixture, project.id)).repairs,
      REPAIR_LIMIT,
    );
  },
);

test(
  "a failure with no enabled env@1 starts no session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const agent = await agentFixture(t, [fauxAssistantMessage(TEXT_ANSWER)]);
    const { fixture, model } = agent;
    await disableEnvironmentAgent(fixture, agent.revision);
    const project = await repositoryProject(fixture, "environment-agent-off");
    await importNode(fixture, project);

    const failed = await until(
      () => currentItem(fixture, project.id),
      (item) => item.status === EnvironmentStatus.Failed,
      t.signal,
    );
    await delay(SETTLE_WAIT_MS);
    const later = await currentItem(fixture, project.id);
    assert.equal(failed.source, EnvironmentSource.Universal);
    assert.equal(later.status, EnvironmentStatus.Failed);
    assert.equal(later.repairs, NO_REPAIRS);
    assert.equal(later.repairing, false);
    assert.equal(model.provider.calls.length, NO_ITEMS);
    assert.equal(model.record.sessions, NO_ITEMS);
  },
);

test(
  "the environment list answers repairing while a session is held at a scripted step",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const held = Promise.withResolvers<void>();
    stopAfter(t, () => held.resolve());
    const reached = { step: false };
    const agent = await agentFixture(t, [
      async () => {
        reached.step = true;
        await held.promise;
        return fauxAssistantMessage(TEXT_ANSWER);
      },
    ]);
    const { fixture, model } = agent;
    const project = await repositoryProject(fixture, "environment-agent-held");
    await importNode(fixture, project);

    await until(() => reached.step, Boolean, t.signal);
    const during = await currentItem(fixture, project.id);
    assert.equal(during.status, EnvironmentStatus.Failed);
    assert.equal(during.repairing, true);

    held.resolve();
    const after = await until(
      () => currentItem(fixture, project.id),
      (item) => !item.repairing,
      t.signal,
    );
    assert.equal(after.status, EnvironmentStatus.Failed);
    assert.equal(model.record.sessions, FIRST_SESSION);
  },
);

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { httpClient } from "../../gateway/client.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { temporary } from "../../kernel/test-support.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { MissionErrorCode, missionOperations } from "../../mission/contract.ts";
import {
  environmentSecretOperations,
  EnvironmentStatus,
  EnvironmentTarget,
  projectOperations,
} from "../../project/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import {
  ENVIRONMENT_DIRECTORY,
  type EnvironmentState,
} from "../../project/environment-state.ts";
import { ExecutionStopReason } from "../../scheduler/contract.ts";
import { trackingOperations } from "../../tracking/contract.ts";
import { until } from "./cli-test-support.ts";
import {
  fakeContainerHost,
  fakeRepositoryFiles,
} from "./container-fakes-test-support.ts";
import {
  CACHE_MOUNT,
  CACHE_PROJECT_LABEL,
  CACHE_RESOURCE_LABEL,
  cacheVolumeName,
  containerOwner,
  type RuntimeAnswer,
  type RuntimeHost,
  SUCCESS_CODE,
} from "./container-runtime.ts";
import {
  completed,
  CONFIGURATION,
  createProject,
  environmentList,
  type Fixture,
  gateFixture,
  importNode,
  NO_ITEMS,
  recordingSlotDriver,
  REPOSITORY_BINDING,
  REVIEWER_BINDING,
  SLOT_NAME_PREFIX,
  slotRuns,
  type SlotStart,
  worker,
  WORKER_BINDING,
} from "./environment-test-support.ts";
import { humanCaller } from "./test-support.ts";

const TEST_TIMEOUT_MS = 120000;
const CONTAINER_IMAGE = "kanthord-test";
const SECRET = "l3-gate-secret-value";
const ROTATED_SECRET = "l3-gate-secret-rotated";
const REGISTRY_CREDENTIAL = "registry-auth";
const REGISTRY_VARIABLE = "REGISTRY_AUTH";
const SECRET_PLATFORM = "environment_secret";
const NODE_IMAGE =
  "mcr.microsoft.com/devcontainers/javascript-node:24-bookworm";
const PYTHON_IMAGE = "mcr.microsoft.com/devcontainers/python:3.12-bookworm";
const ON_CREATE_COMMAND =
  'npm install -g @example/tool --@example:registry=https://npm.pkg.github.com/ --//npm.pkg.github.com/:_authToken="$REGISTRY_AUTH"';
const POST_CREATE_COMMAND = "true";
const STORED_ENVIRONMENT = {
  image: NODE_IMAGE,
  onCreateCommand: ON_CREATE_COMMAND,
  postCreateCommand: POST_CREATE_COMMAND,
};
const SLOT_COUNT = 2;
const MEMORY_MB = 2048;
const MIXED_NODE_FILE = "first.md";
const SINGLE_NODE_FILE = "single.md";
const NODE_REPOSITORY = "node-repository";
const PYTHON_REPOSITORY = "python-repository";
const NODE_WORKER = "node-worker";
const PYTHON_WORKER = "python-worker";
const METADATA_LABEL = "devcontainer.metadata";
const PRIVATE_MODE = "0600";
const CHECK_NAME_PREFIX = "kanthord-env-check-";
const Verb = {
  Build: "build",
  Image: "image",
  Run: "run",
  Tag: "tag",
  Volume: "volume",
} as const;
const Subject = {
  Create: "create",
  Inspect: "inspect",
  List: "ls",
  Remove: "rm",
} as const;
const Option = {
  Detach: "--detach",
  Format: "--format",
  Label: "--label",
  Memory: "--memory",
  Volume: "--volume",
} as const;
const EnvironmentSpan = {
  Root: "project.environment",
  Build: "environment.build",
  Setup: "environment.setup",
  Proof: "environment.proof",
} as const;
const EnvironmentAttribute = {
  ProjectId: "project.id",
  BindingName: "project.binding.name",
  Target: "environment.target",
  Source: "environment.source",
  Digest: "environment.digest",
} as const;
const SLOT_A = 0;
const SLOT_B = 1;
const SLOTS_STARTED = [SLOT_A, SLOT_B];
const SINGLE_ITEM = 1;
const ROTATED_PROOF_RUNS = 2;
const MIXED_GROUPS = 2;
const TRACE_SPANS = 4;
const DEVCONTAINER_BUILD_COUNT = 1;
const SETTLED_STATUSES: readonly EnvironmentStatus[] = [
  EnvironmentStatus.Ready,
  EnvironmentStatus.None,
  EnvironmentStatus.Failed,
];
const RELEASE_STOP = {
  reason: ExecutionStopReason.JudgementInvalid,
  code: null,
};
const REVIEWER = {
  kind: "worker",
  config: { worker: "reviewer@1", placement: "server", instance_count: 0 },
};

interface CacheVolume {
  project: string;
  resource: string;
}

interface RuntimeState {
  tags: Set<string>;
  caches: Map<string, CacheVolume>;
  gate: Promise<void> | null;
}

interface SecretRead {
  id: string;
  mode: string;
  sha256: string;
}

interface Invocation {
  args: string[];
  config: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fakeDevcontainerCli(t: TestContext) {
  const directory = temporary(t);
  const cli = join(directory, "devcontainer.mjs");
  const log = join(directory, "builds.log");
  writeFileSync(
    cli,
    `import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const config = readFileSync(args[args.indexOf("--config") + 1], "utf8");
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, config }) + "\\n");
`,
  );
  writeFileSync(log, "");
  const invocations = (): Invocation[] =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Invocation);
  return { cli, invocations };
}

function secretReadingPodman(t: TestContext, original: string) {
  const directory = temporary(t);
  const bin = join(directory, "bin");
  const reader = join(directory, "reader.mjs");
  const log = join(directory, "secrets.log");
  mkdirSync(bin);
  writeFileSync(log, "");
  writeFileSync(
    reader,
    `import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, statSync } from "node:fs";
const args = process.argv.slice(2);
args.forEach((arg, index) => {
  if (args[0] !== "build" || args[index - 1] !== "--secret") return;
  const [, id, file] = /^id=([^,]+),src=(.+)$/.exec(arg);
  const mode = (statSync(file).mode & 0o777).toString(8).padStart(4, "0");
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ id, mode, sha256 }) + "\\n");
});
const done = spawnSync(${JSON.stringify(original)}, args, { stdio: "inherit" });
process.exit(done.status ?? 1);
`,
  );
  writeFileSync(
    join(bin, "podman"),
    `#!/bin/sh\nexec "${process.execPath}" "${reader}" "$@"\n`,
    { mode: 0o755 },
  );
  const reads = (): SecretRead[] =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SecretRead);
  return { bin, reads, log };
}

function inspectedSettings(document: string | undefined): string {
  const onCreate = (JSON.parse(document ?? "{}") as Record<string, unknown>)
    .onCreateCommand;
  const metadata =
    onCreate === undefined ? [] : [{ onCreateCommand: onCreate }];
  return JSON.stringify([
    {
      Config: {
        Env: [],
        Labels: { [METADATA_LABEL]: JSON.stringify(metadata) },
      },
    },
  ]);
}

function labelOf(args: readonly string[], label: string): string {
  const entry = args.find(
    (arg, index) =>
      args[index - 1] === Option.Label && arg.startsWith(`${label}=`),
  );
  assert.ok(entry, `the arguments hold the label ${label}`);
  return entry.slice(label.length + 1);
}

function listedCaches(state: RuntimeState): string {
  return Array.from(state.caches.keys()).join("\n");
}

function inspectedCaches(
  state: RuntimeState,
  names: readonly string[],
): string {
  return JSON.stringify(
    names.flatMap((name) => {
      const cache = state.caches.get(name);
      return cache === undefined
        ? []
        : [
            {
              Name: name,
              Labels: {
                [CACHE_PROJECT_LABEL]: cache.project,
                [CACHE_RESOURCE_LABEL]: cache.resource,
              },
            },
          ];
    }),
  );
}

async function answered(
  state: RuntimeState,
  invocations: () => Invocation[],
  args: readonly string[],
  fallback: RuntimeAnswer,
): Promise<RuntimeAnswer> {
  const [verb, subject, target] = args;
  const cache = args.some((arg) => arg.includes(CACHE_PROJECT_LABEL));
  const volume = verb === Verb.Volume;
  const image = verb === Verb.Image;
  if (image && subject === Subject.Inspect && !args.includes(Option.Format)) {
    await state.gate;
    return {
      code: SUCCESS_CODE,
      stdout: inspectedSettings(invocations().at(-1)?.config),
      stderr: "",
    };
  }
  if (image && subject === Subject.Inspect && state.tags.has(args.at(-1)!))
    return {
      code: SUCCESS_CODE,
      stdout: `sha256:${args.at(-1)}\n`,
      stderr: "",
    };
  if (image && subject === Subject.Remove) state.tags.delete(target!);
  if (verb === Verb.Tag) state.tags.add(args.at(-1)!);
  if (volume && subject === Subject.Create && cache)
    state.caches.set(args.at(-1)!, {
      project: labelOf(args, CACHE_PROJECT_LABEL),
      resource: labelOf(args, CACHE_RESOURCE_LABEL),
    });
  if (volume && subject === Subject.List && cache)
    return { ...fallback, stdout: listedCaches(state) };
  if (volume && subject === Subject.Inspect)
    return { ...fallback, stdout: inspectedCaches(state, args.slice(2)) };
  if (volume && subject === Subject.Remove) state.caches.delete(target!);
  return fallback;
}

async function l3Fixture(t: TestContext, options: { memoryMb?: number } = {}) {
  const podman = fakeContainerHost(t);
  const devcontainer = fakeDevcontainerCli(t);
  const original = join(
    podman.host.environment.PATH!.split(delimiter)[0]!,
    "podman",
  );
  const secrets = secretReadingPodman(t, original);
  const state: RuntimeState = {
    tags: new Set(),
    caches: new Map(),
    gate: null,
  };
  const host: RuntimeHost = {
    ...podman.host,
    environment: {
      ...podman.host.environment,
      PATH: `${secrets.bin}${delimiter}${podman.host.environment.PATH}`,
    },
    run: async (runtime, args, timeoutMs) =>
      answered(
        state,
        devcontainer.invocations,
        args,
        await podman.host.run(runtime, args, timeoutMs),
      ),
  };
  const starts: SlotStart[] = [];
  const stateDirectory = temporary(t);
  const fixture = await gateFixture(t, {
    containerImage: CONTAINER_IMAGE,
    containerRuntimeHost: host,
    environmentDevcontainerCli: () => devcontainer.cli,
    containerSlotDriver: recordingSlotDriver({ ...podman, host }, starts),
    repositoryFiles: fakeRepositoryFiles(),
    stateDirectory,
    ...(options.memoryMb === undefined
      ? {}
      : { project: { environment_memory_mb: options.memoryMb } }),
  });
  fixture.worker.startPool();
  t.after(async () => {
    fixture.project.cancelEnvironmentRuns();
    await fixture.worker.stopPool();
  });
  const hold = () => {
    const gate = Promise.withResolvers<void>();
    state.gate = gate.promise;
    return () => {
      state.gate = null;
      gate.resolve();
    };
  };
  return {
    fixture,
    podman,
    devcontainer,
    secrets,
    starts,
    stateDirectory,
    hold,
  };
}

type L3 = Awaited<ReturnType<typeof l3Fixture>>;

function repositoryBinding(
  address: string,
  environment: unknown,
  environmentSecrets?: Record<string, string>,
) {
  return {
    kind: "repository",
    config: {
      available: true,
      platform: "github",
      address,
      ssh_credential: "github-ssh",
      strategy: { base_branch: "main" },
      credential: "github",
      environment,
      ...(environmentSecrets === undefined
        ? {}
        : { environment_secrets: environmentSecrets }),
    },
  };
}

function containerWorker(instanceCount: number, environment: string) {
  return {
    kind: "worker",
    config: {
      worker: "coder@1",
      placement: "container",
      instance_count: instanceCount,
      environment,
      entries: [{ agent: "swe@1", ...CONFIGURATION }],
    },
  };
}

function secretBindings() {
  return {
    [REPOSITORY_BINDING]: repositoryBinding(
      "git@github.com:owner/repo.git",
      STORED_ENVIRONMENT,
      { [REGISTRY_VARIABLE]: REGISTRY_CREDENTIAL },
    ),
    [WORKER_BINDING]: containerWorker(SLOT_COUNT, REPOSITORY_BINDING),
    [REVIEWER_BINDING]: REVIEWER,
  };
}

function mixedBindings() {
  return {
    [NODE_REPOSITORY]: repositoryBinding("git@github.com:owner/node.git", {
      image: NODE_IMAGE,
    }),
    [PYTHON_REPOSITORY]: repositoryBinding("git@github.com:owner/python.git", {
      image: PYTHON_IMAGE,
    }),
    [NODE_WORKER]: containerWorker(0, NODE_REPOSITORY),
    [PYTHON_WORKER]: containerWorker(0, PYTHON_REPOSITORY),
    [REVIEWER_BINDING]: REVIEWER,
  };
}

async function writeBindings(
  fixture: Fixture,
  projectId: string,
  bindings: Record<string, unknown>,
) {
  const call = humanCaller(fixture);
  const current = await call(projectOperations["bindingSet.get"], {
    params: { project_id: projectId },
    query: {},
    body: null,
  });
  return call(projectOperations["bindingSet.write"], {
    params: { project_id: projectId },
    query: {},
    body: { version: current.version, bindings: bindings as never },
  });
}

async function createSecret(fixture: Fixture, text: string) {
  return humanCaller(fixture)(environmentSecretOperations.create, {
    params: {},
    query: {},
    body: {
      name: REGISTRY_CREDENTIAL,
      platform: SECRET_PLATFORM,
      metadata: null,
      secret: { key: text },
    },
  });
}

async function rotateSecret(fixture: Fixture, text: string) {
  return humanCaller(fixture)(environmentSecretOperations.rotate, {
    params: { credential_name: REGISTRY_CREDENTIAL },
    query: {},
    body: { expected_revision: 1, secret: { key: text } },
  });
}

async function createEmptyProject(fixture: Fixture, name: string) {
  const project = await humanCaller(fixture)(projectOperations.create, {
    params: {},
    query: {},
    body: { name },
  });
  return project.id;
}

async function awaitItems(
  t: TestContext,
  fixture: Fixture,
  projectId: string,
  done: (items: EnvironmentState[]) => boolean,
): Promise<EnvironmentState[]> {
  return until(() => environmentList(fixture, projectId), done, t.signal);
}

async function settledItem(
  t: TestContext,
  fixture: Fixture,
  projectId: string,
  previousDigest: string | null = null,
): Promise<EnvironmentState> {
  const items = await awaitItems(t, fixture, projectId, (found) =>
    found.some(
      (item) =>
        SETTLED_STATUSES.includes(item.status) &&
        item.digest !== previousDigest,
    ),
  );
  const item = items[0]!;
  assert.equal(item.status, EnvironmentStatus.Ready, JSON.stringify(item));
  return item;
}

function layerBuilds(l3: L3): string[][] {
  return l3.podman.commands().filter((args) => args[0] === Verb.Build);
}

function checkRuns(l3: L3): string[][] {
  return l3.podman
    .commands()
    .filter(
      (args) =>
        args[0] === Verb.Run &&
        args[args.indexOf("--name") + 1]?.startsWith(CHECK_NAME_PREFIX),
    );
}

function proofRuns(l3: L3): string[][] {
  return l3.podman.calls.filter(
    (args) => args[0] === Verb.Run && args.includes(Option.Detach),
  );
}

function holdsMemory(args: readonly string[]): boolean {
  return args.some(
    (arg, index) =>
      arg === Option.Memory && args[index + 1] === `${MEMORY_MB}m`,
  );
}

function cacheVolumeOf(args: readonly string[]): string | null {
  const mount = args.find(
    (arg, index) =>
      args[index - 1] === Option.Volume && arg.endsWith(`:${CACHE_MOUNT}`),
  );
  return mount === undefined ? null : mount.slice(0, -`:${CACHE_MOUNT}`.length);
}

function volumeCalled(l3: L3, subject: string, name: string): boolean {
  return l3.podman.calls.some(
    (args) =>
      args[0] === Verb.Volume && args[1] === subject && args.at(-1) === name,
  );
}

function cacheNames(l3: L3): Set<string> {
  const names = [...slotRuns(l3.podman), ...proofRuns(l3)].map(cacheVolumeOf);
  return new Set(names.filter((name): name is string => name !== null));
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

async function assertNoSecret(
  l3: L3,
  projectId: string,
  texts: readonly string[],
) {
  const documents = {
    build_documents: l3.devcontainer
      .invocations()
      .map(({ config }) => config)
      .join("\n"),
    containerfiles: layerBuilds(l3)
      .map((args) => l3.podman.containerfile(args[args.indexOf("--tag") + 1]!))
      .join("\n"),
    runtime_arguments: JSON.stringify([
      ...l3.podman.commands(),
      ...l3.podman.calls,
      ...l3.devcontainer.invocations().map(({ args }) => args),
      ...l3.starts.map(({ clientId, slot, poolSlot }) => ({
        clientId,
        slot,
        poolSlot,
      })),
    ]),
    secret_reads: readFileSync(l3.secrets.log, "utf8"),
    state_files: filesUnder(l3.stateDirectory)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n"),
    server_logs: l3.fixture.logs.join("\n"),
    state_answer: JSON.stringify(await environmentList(l3.fixture, projectId)),
  };
  for (const secret of texts)
    for (const [name, text] of Object.entries(documents))
      assert.ok(!text.includes(secret), `${name} holds the secret text`);
}

function proofFiles(l3: L3): string[] {
  return filesUnder(join(l3.stateDirectory, ENVIRONMENT_DIRECTORY)).filter(
    (file) => file.endsWith(".json"),
  );
}

function mixedPlan(filename: string, bindings: string[]) {
  return {
    filename,
    content: `---\nintent: implement\nbindings: [${bindings.join(", ")}]\nverifications: [npm run lint]\n---\n# ${filename}\n## Requirement\nRequirement\n## Criterion\nCriterion\n`,
  };
}

async function missionOf(fixture: Fixture, projectId: string) {
  return humanCaller(fixture)(missionOperations.get, {
    params: { project_id: projectId },
    query: {},
    body: null,
  });
}

async function nodeCount(fixture: Fixture, missionId: string) {
  const page = await humanCaller(fixture)(missionOperations["node.list"], {
    params: { mission_id: missionId },
    query: {},
    body: null,
  });
  return page.items.length;
}

async function importBody(
  fixture: Fixture,
  projectId: string,
  files: ReturnType<typeof mixedPlan>[],
) {
  const mission = await missionOf(fixture, projectId);
  return {
    mission,
    body: {
      format: "markdown",
      mission_id: mission.id,
      mission_version: mission.version,
      reason: "plan",
      files,
    } as const,
  };
}

async function assertMixedRefusal(
  fixture: Fixture,
  projectId: string,
  bindingIds: string[],
) {
  const files = [
    mixedPlan(MIXED_NODE_FILE, [NODE_REPOSITORY, PYTHON_REPOSITORY]),
  ];
  const { mission, body } = await importBody(fixture, projectId, files);
  const before = await nodeCount(fixture, mission.id);
  const preview = await humanCaller(fixture)(
    missionOperations["import.preview"],
    { params: { mission_id: mission.id }, query: {}, body },
  );
  assert.equal(preview.violations.length, SINGLE_ITEM, JSON.stringify(preview));
  const [violation] = preview.violations;
  assert.equal(violation!.code, MissionErrorCode.EnvironmentMixed);
  assert.equal(violation!.filename, MIXED_NODE_FILE);
  const applied = await httpClient(
    { operation: missionOperations["import.apply"] },
    fixture.endpoint,
    fixture.token,
  ).operation({
    params: { mission_id: mission.id },
    query: {},
    body: {
      ...body,
      preview_digest: preview.preview_digest,
      confirmed_retirements: [],
    },
  });
  assert.equal(applied.type, OperationResultType.Failure);
  assert.ok(applied.type === OperationResultType.Failure);
  assert.equal(applied.status, HttpStatus.BadRequest);
  assert.equal(applied.error.error.code, MissionErrorCode.EnvironmentMixed);
  const details = applied.error.error.details as { bindings: string[] };
  assert.deepEqual([...details.bindings].sort(), [...bindingIds].sort());
  assert.equal(await nodeCount(fixture, mission.id), before);
}

test(
  "a private registry secret reaches only the onCreateCommand step, rotates, shares one cache volume and leaves a trace",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const l3 = await l3Fixture(t);
    const { fixture, podman, secrets } = l3;
    const call = humanCaller(fixture);
    await createSecret(fixture, SECRET);
    const projectId = await createEmptyProject(fixture, "environment-l3-gate");
    const written = await writeBindings(fixture, projectId, secretBindings());
    const repositoryId = written.bindings[REPOSITORY_BINDING]!.id;
    const project = { id: projectId, repositoryId };
    const first = await settledItem(t, fixture, projectId);
    let cacheName = "";
    let nodes: string[] = [];
    let claimant: Awaited<ReturnType<typeof worker>> | null = null;
    let claimedExecution = "";
    let claimantToken = "";

    await t.test(
      "the secret reaches one command of the onCreateCommand step from a private file that the run removes",
      async () => {
        const [build, ...later] = layerBuilds(l3);
        assert.ok(build && later.length === NO_ITEMS);
        const option = build[build.indexOf("--secret") + 1]!;
        const matched = /^id=REGISTRY_AUTH,src=(.+)$/.exec(option);
        assert.ok(matched, option);
        const file = matched[1]!;
        const containerfile = podman.containerfile(
          build[build.indexOf("--tag") + 1]!,
        );
        const steps = containerfile.split("\n");
        const secretSteps = steps.filter((step) =>
          step.includes(REGISTRY_VARIABLE),
        );
        const script = [
          `export ${REGISTRY_VARIABLE}="$(cat /run/secrets/${REGISTRY_VARIABLE})"`,
          ON_CREATE_COMMAND,
        ].join("; ");
        assert.deepEqual(secretSteps, [
          `RUN --mount=type=secret,id=${REGISTRY_VARIABLE} ${JSON.stringify(["/bin/sh", "-c", script])}`,
        ]);
        assert.ok(!secretSteps[0]!.includes(">"));
        assert.ok(!containerfile.includes("npm config set"));
        assert.ok(!containerfile.includes(".npmrc"));
        assert.deepEqual(secrets.reads(), [
          { id: REGISTRY_VARIABLE, mode: PRIVATE_MODE, sha256: sha256(SECRET) },
        ]);
        assert.ok(!existsSync(file));
        assert.ok(!existsSync(dirname(file)));
        assert.ok(proofFiles(l3).length > NO_ITEMS);
        await assertNoSecret(l3, projectId, [SECRET]);
      },
    );

    await t.test(
      "the run leaves one trace with the root and three child spans",
      async () => {
        const traces = await until(
          () =>
            call(trackingOperations.traceList, {
              params: {},
              query: { project_id: projectId },
              body: null,
            }),
          (page) =>
            page.items.length > NO_ITEMS &&
            page.items.every((item) => item.ended_at),
          t.signal,
        );
        assert.equal(traces.items.length, SINGLE_ITEM);
        const [summary] = traces.items;
        assert.equal(summary!.execution_id, null);
        const traceId = summary!.trace_id;
        const got = await call(trackingOperations.traceGet, {
          params: { trace_id: traceId },
          query: {},
          body: null,
        });
        assert.equal(got.root_span_id, summary!.root_span_id);
        const spans = await until(
          async () =>
            (
              await call(trackingOperations.spanList, {
                params: { trace_id: traceId },
                query: {},
                body: null,
              })
            ).items,
          (found) => found.length >= TRACE_SPANS,
          t.signal,
        );
        const root = spans.find((span) => span.span_id === got.root_span_id)!;
        assert.equal(root.operation, EnvironmentSpan.Root);
        assert.equal(root.parent_span_id, null);
        assert.deepEqual(root.attributes, {
          [EnvironmentAttribute.ProjectId]: projectId,
          [EnvironmentAttribute.BindingName]: REPOSITORY_BINDING,
          [EnvironmentAttribute.Target]: EnvironmentTarget.Image,
          [EnvironmentAttribute.Source]: EnvironmentSource.Stored,
          [EnvironmentAttribute.Digest]: first.digest,
        });
        const children = spans.filter((span) => span !== root);
        assert.deepEqual(children.map((span) => span.operation).sort(), [
          EnvironmentSpan.Build,
          EnvironmentSpan.Proof,
          EnvironmentSpan.Setup,
        ]);
        for (const child of children)
          assert.equal(child.parent_span_id, root.span_id);
      },
    );

    await t.test(
      "two slots of one group share one cache volume with the proof container",
      async () => {
        nodes = [
          await importNode(fixture, project, "implement-1.md"),
          await importNode(fixture, project, "implement-2.md"),
        ];
        await until(
          () =>
            SLOTS_STARTED.every((slot) =>
              l3.starts.some((start) => start.slot === slot),
            ),
          Boolean,
          t.signal,
        );
        const slotA = l3.starts.find((start) => start.slot === SLOT_A)!;
        const slotB = l3.starts.find((start) => start.slot === SLOT_B)!;
        const clientA = await worker(t, fixture, projectId, nodes[0]!, 0, {
          token: await fixture.slotTokenOf(slotA.poolSlot),
        });
        await clientA.claimed(nodes);
        claimantToken = await fixture.slotTokenOf(slotB.poolSlot);
        const clientB = await worker(t, fixture, projectId, nodes[1]!, 1, {
          token: claimantToken,
        });
        claimedExecution = await clientB.claimed(nodes);
        claimant = clientB;
        const runs = await until(
          () => [slotA, slotB].map((start) => slotRuns(podman, start.clientId)),
          (found) => found.every((list) => list.length > NO_ITEMS),
          t.signal,
        );
        cacheName = cacheVolumeName(
          containerOwner(fixture.masterKey),
          projectId,
          first.resource_identity,
        );
        for (const list of runs)
          for (const run of list) assert.equal(cacheVolumeOf(run), cacheName);
        assert.equal(proofRuns(l3).length, SINGLE_ITEM);
        assert.equal(cacheVolumeOf(proofRuns(l3)[0]!), cacheName);
        assert.deepEqual(Array.from(cacheNames(l3)), [cacheName]);
        const homes = [slotA, slotB].map(
          ({ clientId }) => `${SLOT_NAME_PREFIX}${clientId}`,
        );
        assert.notEqual(homes[0], homes[1]);
        for (const home of homes)
          assert.ok(volumeCalled(l3, Subject.Create, home));
      },
    );

    await t.test(
      "a work pull of the worker binding recomputes the rotated group",
      async (u) => {
        await rotateSecret(fixture, ROTATED_SECRET);
        const third = await importNode(fixture, project, "implement-3.md");
        await claimant!.release(claimedExecution, RELEASE_STOP);
        const pulled = await claimant!.claimed([...nodes, third]);
        const workerClient = httpClient(
          workerOperations,
          fixture.endpoint,
          claimantToken,
        );
        completed(
          await workerClient.handover({
            params: {},
            query: {},
            body: { execution_id: pulled },
          }),
        );
        completed(
          await workerClient["execution.setup.get"]({
            params: { execution_id: pulled },
            query: {},
            body: null,
          }),
        );
        const items = await until(
          () => environmentList(fixture, projectId),
          (found) =>
            found.some(
              (item) =>
                item.status === EnvironmentStatus.Ready &&
                item.digest !== first.digest,
            ),
          u.signal,
        );
        assert.notEqual(items[0]!.digest, first.digest);
      },
    );

    await t.test(
      "a rotation of the secret gives a new digest and keeps the cache volume",
      async () => {
        const rotated = await settledItem(t, fixture, projectId, first.digest);
        assert.notEqual(rotated.digest, first.digest);
        assert.notEqual(rotated.tag, first.tag);
        assert.deepEqual(
          secrets.reads().map(({ mode, sha256: sum }) => ({ mode, sum })),
          [SECRET, ROTATED_SECRET].map((text) => ({
            mode: PRIVATE_MODE,
            sum: sha256(text),
          })),
        );
        assert.equal(proofRuns(l3).length, ROTATED_PROOF_RUNS);
        assert.deepEqual(Array.from(cacheNames(l3)), [cacheName]);
        await assertNoSecret(l3, projectId, [SECRET, ROTATED_SECRET]);
      },
    );

    await t.test(
      "the removal of the repository binding removes the cache volume",
      async () => {
        const base = secretBindings();
        await writeBindings(fixture, projectId, {
          [WORKER_BINDING]: {
            kind: "worker",
            config: {
              worker: "coder@1",
              placement: "container",
              instance_count: 0,
              entries: [{ agent: "swe@1", ...CONFIGURATION }],
            },
          },
          [REVIEWER_BINDING]: base[REVIEWER_BINDING],
        });
        await until(
          () => volumeCalled(l3, Subject.Remove, cacheName),
          Boolean,
          t.signal,
        );
      },
    );
  },
);

test(
  "a node that names repository bindings with different stored environments is refused before and after the states are ready",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const l3 = await l3Fixture(t);
    const { fixture } = l3;
    const projectId = await createEmptyProject(fixture, "environment-l3-mixed");
    const release = l3.hold();
    try {
      const written = await writeBindings(fixture, projectId, mixedBindings());
      const bindingIds = [NODE_REPOSITORY, PYTHON_REPOSITORY].map(
        (name) => written.bindings[name]!.id,
      );
      const pending = await environmentList(fixture, projectId);
      assert.ok(
        pending.every((item) => item.status !== EnvironmentStatus.Ready),
      );
      await assertMixedRefusal(fixture, projectId, bindingIds);
      release();
      await awaitItems(
        t,
        fixture,
        projectId,
        (items) =>
          items.length === MIXED_GROUPS &&
          items.every((item) => item.status === EnvironmentStatus.Ready),
      );
      await assertMixedRefusal(fixture, projectId, bindingIds);
      const { mission, body } = await importBody(fixture, projectId, [
        mixedPlan(SINGLE_NODE_FILE, [NODE_REPOSITORY]),
      ]);
      const call = humanCaller(fixture);
      const preview = await call(missionOperations["import.preview"], {
        params: { mission_id: mission.id },
        query: {},
        body,
      });
      assert.deepEqual(preview.violations, []);
      await call(missionOperations["import.apply"], {
        params: { mission_id: mission.id },
        query: {},
        body: {
          ...body,
          preview_digest: preview.preview_digest,
          confirmed_retirements: [],
        },
      });
      assert.equal(await nodeCount(fixture, mission.id), SINGLE_ITEM);
    } finally {
      release();
    }
  },
);

test(
  "the memory bound reaches the layer build, the image check and the proof container but not the devcontainer build",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const l3 = await l3Fixture(t, { memoryMb: MEMORY_MB });
    const project = await createProject(l3.fixture, {
      name: "environment-l3-memory",
      placement: "container",
      instanceCount: 1,
      environment: {
        image: NODE_IMAGE,
        postCreateCommand: POST_CREATE_COMMAND,
      },
      workerEnvironment: REPOSITORY_BINDING,
    });
    await settledItem(t, l3.fixture, project.id);
    const layers = layerBuilds(l3);
    const checks = checkRuns(l3);
    const proofs = proofRuns(l3);
    for (const group of [layers, checks, proofs]) {
      assert.equal(group.length, SINGLE_ITEM);
      assert.ok(holdsMemory(group[0]!), JSON.stringify(group[0]));
    }
    const builds = l3.devcontainer.invocations();
    assert.equal(builds.length, DEVCONTAINER_BUILD_COUNT);
    assert.ok(!builds[0]!.args.includes(Option.Memory));
  },
);

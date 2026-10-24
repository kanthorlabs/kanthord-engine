import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  EnvironmentStatus,
  EnvironmentTarget,
  WorkerPlacement,
  type RepositoryFiles,
} from "../../project/contract.ts";
import {
  environmentTagOf,
  type EnvironmentState,
} from "../../project/environment-state.ts";
import { RepositoryFileState } from "../../repository/contract.ts";
import { until } from "./cli-support.ts";
import { fakeContainerHost } from "./container-fakes.ts";
import type { RuntimeHost } from "./container-runtime.ts";
import {
  createProject,
  type ProjectInput,
  environmentList,
  gateFixture,
  NO_ITEMS,
  SINGLE_SLOT,
  importNode,
  recordingSlotDriver,
  RUN_VERB,
  slotRuns,
  worker,
  REPOSITORY_BINDING,
  type SlotStart,
} from "./environment-test-support.ts";

const TEST_TIMEOUT_MS = 120000;
const FAKE_COMMIT = "a".repeat(40);
const CONTAINER_IMAGE = "kanthord-test";
const BUILD_VERB = "build";
const EXEC_VERB = "exec";
const INSPECT_VERB = "image";
const INSPECT_SUBJECT = "inspect";
const FORMAT_OPTION = "--format";
const TAG_OPTION = "--tag";
const SEPARATOR_OPTION = "--";
const SHELL_NAME = "bash";
const SHELL_INDEX = 4;
const METADATA_LABEL = "devcontainer.metadata";
const IMAGE_PREFIX = "mcr.microsoft.com/devcontainers";
const UNIVERSAL_PATH = "static/environment/universal.json";
const SETTLED_STATUSES: readonly EnvironmentStatus[] = [
  EnvironmentStatus.Ready,
  EnvironmentStatus.None,
  EnvironmentStatus.Failed,
];

function cliSource(log: string): string {
  return `import { appendFileSync, readFileSync } from "node:fs";
const config = process.argv[process.argv.indexOf("--config") + 1];
appendFileSync(${JSON.stringify(log)}, readFileSync(config, "utf8") + "\\n");
`;
}

async function memoryRepository(
  t: TestContext,
  files: Record<string, string>,
): Promise<RepositoryFiles> {
  const seed = join(temporary(t), "seed");
  mkdirSync(seed);
  for (const [path, text] of Object.entries(files))
    writeFileSync(join(seed, path), text);
  const git = simpleGit(seed);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.name", "Detection Gate");
  await git.addConfig("user.email", "detection_gate@example.invalid");
  await git.add(".");
  await git.commit("initial", ["--allow-empty"]);
  return {
    resolveBranchCommit: async () => FAKE_COMMIT,
    readFilesAtCommit: async (_address, _commit, paths) =>
      paths.map((path) =>
        Object.hasOwn(files, path)
          ? { path, state: RepositoryFileState.Present, text: files[path]! }
          : { path, state: RepositoryFileState.Absent, text: null },
      ),
    listFilesAtCommit: async () => [],
    readObjectIds: async (_address, _commit, paths) => paths.map(() => null),
    cloneSnapshot: async (_address, revision, directory) => {
      cpSync(seed, directory, { recursive: true });
      return revision;
    },
  };
}

function fakeDevcontainerCli(t: TestContext) {
  const directory = temporary(t);
  const cli = join(directory, "devcontainer.mjs");
  const log = join(directory, "builds.log");
  writeFileSync(cli, cliSource(log));
  writeFileSync(log, "");
  const builds = (): Record<string, unknown>[] =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { cli, builds };
}

function inspectedSettings(document: Record<string, unknown> | undefined) {
  const metadata =
    document?.onCreateCommand === undefined
      ? []
      : [{ onCreateCommand: document.onCreateCommand }];
  return JSON.stringify([
    {
      Config: {
        Env: [],
        Labels: { [METADATA_LABEL]: JSON.stringify(metadata) },
      },
    },
  ]);
}

async function detectionFixture(
  t: TestContext,
  files: Record<string, string>,
  placement: ProjectInput["placement"],
) {
  const podman = fakeContainerHost(t);
  const devcontainer = fakeDevcontainerCli(t);
  const host: RuntimeHost = {
    ...podman.host,
    run: async (runtime, args, timeoutMs) => {
      const inspected =
        args[0] === INSPECT_VERB &&
        args[1] === INSPECT_SUBJECT &&
        !args.includes(FORMAT_OPTION);
      if (!inspected) return podman.host.run(runtime, args, timeoutMs);
      podman.calls.push([...args]);
      return {
        code: 0,
        stdout: inspectedSettings(devcontainer.builds().at(-1)),
        stderr: "",
      };
    },
  };
  const starts: SlotStart[] = [];
  const fixture = await gateFixture(t, {
    containerImage: CONTAINER_IMAGE,
    containerRuntimeHost: host,
    environmentDevcontainerCli: () => devcontainer.cli,
    containerSlotDriver: recordingSlotDriver(podman, starts),
    repositoryFiles: await memoryRepository(t, files),
  });
  if (placement === WorkerPlacement.Container) {
    fixture.worker.startPool();
    t.after(async () => {
      fixture.project.cancelEnvironmentRuns();
      await fixture.worker.stopPool();
    });
  }
  const project = await createProject(fixture, {
    name: "environment-detection-gate",
    placement,
    instanceCount:
      placement === WorkerPlacement.Container ? SINGLE_SLOT : NO_ITEMS,
    ...(placement === WorkerPlacement.Container
      ? { workerEnvironment: REPOSITORY_BINDING }
      : {}),
  });
  return { fixture, podman, devcontainer, starts, project };
}

type Detection = Awaited<ReturnType<typeof detectionFixture>>;

async function settled(
  t: TestContext,
  detection: Detection,
): Promise<EnvironmentState> {
  const items = await until(
    () => environmentList(detection.fixture, detection.project.id),
    (found) => found.some((item) => SETTLED_STATUSES.includes(item.status)),
    t.signal,
  );
  assert.equal(items.length, SINGLE_SLOT);
  return items[0]!;
}

function layerBuilds(detection: Detection): string[][] {
  return detection.podman.commands().filter((args) => args[0] === BUILD_VERB);
}

function proofCommands(detection: Detection): string[] {
  return detection.podman
    .commands()
    .filter((args) => args[0] === EXEC_VERB && args[SHELL_INDEX] === SHELL_NAME)
    .map((args) => args.at(-1)!);
}

function assertLayerStep(detection: Detection, script: string) {
  const [build] = layerBuilds(detection);
  assert.ok(build);
  const containerfile = detection.podman.containerfile(
    build[build.indexOf(TAG_OPTION) + 1]!,
  );
  const step = `RUN ${JSON.stringify(["/bin/sh", "-c", script])}`;
  assert.ok(containerfile.split("\n").includes(step), containerfile);
}

async function claimOnReadyTag(
  t: TestContext,
  detection: Detection,
  ready: EnvironmentState,
) {
  assert.ok(ready.tag && ready.digest);
  assert.equal(
    ready.tag,
    environmentTagOf(ready.resource_identity, ready.digest),
  );
  const runs = await until(
    () =>
      detection.starts.flatMap((start) =>
        slotRuns(detection.podman, start.clientId),
      ),
    (found) => found.length > NO_ITEMS,
    t.signal,
  );
  for (const run of runs)
    assert.equal(run[run.indexOf(SEPARATOR_OPTION) - 1], ready.tag);
  assert.ok(detection.starts.length > NO_ITEMS);
  const nodeId = await importNode(detection.fixture, detection.project);
  const slot = detection.starts[0]!.poolSlot;
  const client = await worker(
    t,
    detection.fixture,
    detection.project.id,
    nodeId,
    slot.slot,
    { token: await detection.fixture.slotTokenOf(slot) },
  );
  await client.claimed();
}

interface StackCase {
  name: string;
  files: Record<string, string>;
  image: string;
  commands: string[];
  layerStep?: string;
}

const STACK_CASES: StackCase[] = [
  {
    name: "a node repository with pnpm",
    files: {
      "package.json": JSON.stringify({ packageManager: "pnpm@9.12.0" }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      ".nvmrc": "20\n",
    },
    image: `${IMAGE_PREFIX}/javascript-node:20-bookworm`,
    commands: [
      "pnpm install --frozen-lockfile",
      "node --version",
      "pnpm --version",
    ],
    layerStep: "npm install -g pnpm@9.12.0",
  },
  {
    name: "a python repository with uv",
    files: {
      "pyproject.toml": '[project]\nname = "demo"\n',
      "uv.lock": "version = 1\n",
      ".python-version": "3.12\n",
    },
    image: `${IMAGE_PREFIX}/python:3.12-bookworm`,
    commands: ["uv sync --frozen", "python --version", "uv --version"],
  },
  {
    name: "a go repository",
    files: { "go.mod": "module example.com/demo\n\ngo 1.22\n" },
    image: `${IMAGE_PREFIX}/go:1.22-bookworm`,
    commands: ["go mod download", "go version"],
  },
  {
    name: "a rust repository",
    files: { "Cargo.toml": '[package]\nname = "demo"\n' },
    image: `${IMAGE_PREFIX}/rust:1-bookworm`,
    commands: ["cargo fetch", "cargo --version"],
  },
  {
    name: "a java repository with maven",
    files: { "pom.xml": "<project/>\n", mvnw: "#!/bin/sh\n" },
    image: `${IMAGE_PREFIX}/java:21-bookworm`,
    commands: ["./mvnw -B -q dependency:go-offline", "java -version"],
  },
];

for (const stack of STACK_CASES)
  test(
    `${stack.name} reaches ready as detected with no user act and claims the node`,
    { timeout: TEST_TIMEOUT_MS },
    async (t) => {
      const detection = await detectionFixture(
        t,
        stack.files,
        WorkerPlacement.Container,
      );
      const ready = await settled(t, detection);
      assert.equal(ready.status, EnvironmentStatus.Ready);
      assert.equal(ready.source, EnvironmentSource.Detected);
      assert.equal(ready.target, EnvironmentTarget.Image);
      const builds = detection.devcontainer.builds();
      assert.equal(builds.length, SINGLE_SLOT);
      assert.equal(builds[0]!.image, stack.image);
      assert.equal(layerBuilds(detection).length, SINGLE_SLOT);
      assert.deepEqual(proofCommands(detection), stack.commands);
      if (stack.layerStep !== undefined)
        assertLayerStep(detection, stack.layerStep);
      await claimOnReadyTag(t, detection, ready);
    },
  );

test(
  "a repository with no manifest and an image target reaches ready as universal with no user act and claims the node",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const detection = await detectionFixture(t, {}, WorkerPlacement.Container);
    const ready = await settled(t, detection);
    assert.equal(ready.status, EnvironmentStatus.Ready);
    assert.equal(ready.source, EnvironmentSource.Universal);
    const builds = detection.devcontainer.builds();
    assert.equal(builds.length, SINGLE_SLOT);
    const { customizations, ...universal } = JSON.parse(
      readFileSync(UNIVERSAL_PATH, "utf8"),
    ) as { customizations: { kanthord: { checks: string[] } } };
    assert.deepEqual(builds[0], universal);
    assert.deepEqual(proofCommands(detection), customizations.kanthord.checks);
    await claimOnReadyTag(t, detection, ready);
  },
);

test(
  "a repository with no manifest and a host target reaches none with no build and no proof command",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const detection = await detectionFixture(t, {}, WorkerPlacement.Server);
    const none = await settled(t, detection);
    assert.equal(none.status, EnvironmentStatus.None);
    assert.equal(none.target, EnvironmentTarget.Host);
    assert.deepEqual(detection.devcontainer.builds(), []);
    assert.deepEqual(detection.podman.commands(), []);
    assert.deepEqual(
      detection.podman.calls.filter((args) =>
        [BUILD_VERB, RUN_VERB, EXEC_VERB].includes(args[0]!),
      ),
      [],
    );
  },
);

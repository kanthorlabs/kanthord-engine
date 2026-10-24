import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { test, type TestContext } from "node:test";
import {
  setImmediate as turn,
  setTimeout as pause,
} from "node:timers/promises";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import pino from "pino";
import { CustodyComponent, custodyMigrations } from "../custody/index.ts";
import {
  CUSTODY_SERVICE_NAME,
  type CredentialAnswer,
} from "../custody/contract.ts";
import { INTAKE_SERVICE_NAME } from "../intake/contract.ts";
import { IdentityKind } from "../kernel/caller.ts";
import {
  DEVCONTAINER_FILE,
  EnvironmentSource,
  environmentSchema,
  type Environment,
} from "../kernel/devcontainer.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { temporary } from "../kernel/test-support.ts";
import { testServiceIdentity } from "../kernel/test-identity.ts";
import { SpanStatus, type ServerTrace } from "../tracking/contract.ts";
import {
  RepositoryFileState,
  type RepositoryFile,
} from "../repository/contract.ts";
import {
  BindingKind,
  PROJECT_SERVICE_NAME,
  ProjectErrorCode,
  WorkerPlacement,
  bindingSetWriteInputSchema,
  type RepositoryFiles,
} from "./contract.ts";
import {
  DETECTION_PATHS,
  WORKFLOW_DIRECTORY,
  WORKFLOW_FILES_MAX,
  detectEnvironment,
} from "./detection.ts";
import { ProjectEnvironments, type GroupResolution } from "./environment.ts";
import type {
  EnvironmentSessionHandle,
  EnvironmentSessionInput,
} from "./environment-agent.ts";
import type { ProbeAnswer } from "./environment-probe-contract.ts";
import {
  ENVIRONMENT_SECRET_PLATFORM,
  ENVIRONMENT_SECRET_PLATFORMS,
} from "./environment-secret-platform.ts";
import { EnvironmentSecrets } from "./environment-secrets.ts";
import type { EnvironmentContribution } from "./environment-telemetry.ts";
import {
  BASE_SUFFIX,
  EnvironmentStatus,
  EnvironmentTarget,
  PROVED_SUFFIX,
  ProofFiles,
  environmentDigest,
  environmentPath,
  environmentTagOf,
  type CommandResult,
  type EnvironmentRuntime,
  type ImageBuildInput,
  type ImageBuildResult,
  type ProofFile,
  type ProofInput,
} from "./environment-state.ts";
import {
  ENV_AGENT_ATTEMPT_LIMIT,
  ENV_AGENT_TOOL_CALL_LIMIT,
  Onboarding,
  environmentStateSchema,
  statusOf,
  targetOf,
  type BindingFacts,
  type EnvironmentFailedInput,
  type GroupRecord,
  type OnboardingDependencies,
  type RepositoryGroup,
  type WorkerBindingFacts,
} from "./onboarding.ts";
import { projectMigrations } from "./migrations.ts";
import {
  insertProject,
  readCurrentBindingSet,
  writeBindingSet,
} from "./store.ts";

const PROJECT = "project_1";
const APP: RepositoryGroup = {
  binding_id: "binding_app",
  binding_name: "app",
  resource_identity: "repository:github:acme/app",
};
const DOCS: RepositoryGroup = {
  binding_id: "binding_docs",
  binding_name: "docs",
  resource_identity: "repository:github:acme/docs",
};
const SECRET_VARIABLE = "REGISTRY_AUTH";
const SECRET_CREDENTIAL = "registry-auth";
const SECRET_TEXT = "s3cr3t-value";
const REDACTED_TAIL = "token=[redacted]";
const ROTATED_SECRET_TEXT = "registry-secret-two";
const SECRET_APP: RepositoryGroup = {
  ...APP,
  environment_secrets: { [SECRET_VARIABLE]: SECRET_CREDENTIAL },
};
const PRIVATE_MODE = 0o600;
const MODE_MASK = 0o777;
const WORKER_IDENTITY = "worker:builder";
const SLOT_IMAGE = "registry/kanthord:1.0.0";
const VERSION = "1.0.0";
const BASE = "base";
const TEST_TIMEOUT_MS = 20000;
const STORED_SOURCE = "stored";
const REPOSITORY_SOURCE = "repository";
const NONE_SOURCE = "none";
const TRANSIENT = "transient fetch failure";
const UNREACHABLE = "ssh unreachable";
const BRANCH_ABSENT = "base branch absent";
const COMMAND_ABSENT = "command_absent";
const DOCS_NAME = "docs";
const DOCS_REPAIRS = 2;
const ONE_CALL = 1;
const NO_CALLS = 0;
const NO_REPAIRS = 0;
const PASSED = "passed";
const FAILED = "failed";
const ONBOARDING = "onboarding";
const EXECUTION = "execution";
const BUILD_FAILED = "build_failed";
const NO_SPACE = "no space";
const BOOM = "boom";
const MAKE_SETUP = "make setup";
const MAKE_TEST = "make test";
const PROVE = "prove";
const APP_NAME = "app";
const IMAGE = "image";
const EXECUTION_ID = "execution_1";
const SETUP_FAILED = "setup_failed";
const PROOF_CRASHED = "proof crashed";
const HOST_CRASHED = "host crashed";
const DEADLINE_TAIL = "the run deadline of 30 minutes passed";
const TWO_CALLS = 2;
const THREE_DIGESTS = 3;
const THREE_CALLS = 3;
const RUNTIME_NAME = "podman";
const UNTIL_ATTEMPTS = 1000;
const SETUP_EXIT = 3;
const COMMAND_ABSENT_EXIT = 127;
const RUN_DEADLINE_MS = 1800000;
const SHORT_DEADLINE_MS = 1000;
const DEADLINE_POLL_MS = 50;
const DEADLINE_POLL_ATTEMPTS = 100;
const PENDING_RETRY_MS = 60000;
const REMOVE_STALE_RUNS = "removeStaleRuns";
const RENAMED_BINDING_ID = "binding_app_2";
const STRAY_IDENTITY = "repository:github:acme/gone";
const RUN_STARTED = "project.onboarding.run_started";
const RUN_ENDED = "project.onboarding.run_ended";
const CHECKOUT = "/tmp/checkout";
const INVALID_DOCUMENT = "bad document";
const PROBE_ANSWER: ProbeAnswer = {
  image: "image_1",
  exit_code: 0,
  output: "probe output",
};
const REFUSED_ENVIRONMENT = { invalid: true };
const SESSION_FAILED = "project.onboarding.session_failed";
const DOCUMENT: Environment = {
  image: BASE,
  postCreateCommand: "make setup",
  customizations: { kanthord: { checks: ["make test"] } },
};
const REPOSITORY: GroupResolution = {
  source: "repository",
  commit: "c1",
  document: DOCUMENT,
  files: [
    { path: ".devcontainer/devcontainer.json", state: "present", text: "{}" },
  ],
};
const STORED: GroupResolution = { ...REPOSITORY, source: "stored" };
const NOTHING: GroupResolution = {
  source: "none",
  commit: "c1",
  document: null,
  files: [],
};

const container = (environment: string | null): WorkerBindingFacts => ({
  placement: WorkerPlacement.Container,
  external: false,
  environment,
});
const server: WorkerBindingFacts = {
  placement: WorkerPlacement.Server,
  external: false,
  environment: null,
};
const remoteWorker: WorkerBindingFacts = {
  placement: WorkerPlacement.Worker,
  external: false,
  environment: null,
};
const external: WorkerBindingFacts = {
  placement: null,
  external: true,
  environment: null,
};

function facts(
  repositories: readonly RepositoryGroup[],
  workers: readonly WorkerBindingFacts[],
): BindingFacts {
  return { repositories, workers };
}

function proofFile(sum: string, override: Partial<ProofFile> = {}): ProofFile {
  return {
    digest: sum,
    outcome: "passed",
    class: null,
    origin: "onboarding",
    execution_id: null,
    command: null,
    exit_code: null,
    tail: "",
    reproduce: null,
    checks: [{ command: "make test", exit_code: 2 }],
    repairs: 0,
    ended_at: 1,
    ...override,
  };
}

class Deferred {
  readonly promise: Promise<void>;
  release!: () => void;
  constructor() {
    this.promise = new Promise((resolve) => (this.release = resolve));
  }
}

type ResolveGroup = OnboardingDependencies["resolveGroup"];

class Harness {
  bindings: BindingFacts = facts([APP], [container("app")]);
  workerEnvironment: string | null = "app";
  resolution: GroupResolution | Error = REPOSITORY;
  resolveCalls: Array<{ bindingId: string; target: EnvironmentTarget }> = [];
  bindingsCalls = 0;
  resolveGate: Deferred | null = null;
  buildGate: Deferred | null = new Deferred();
  proveGate: Deferred | null = new Deferred();
  buildResult: ImageBuildResult = { outcome: "built" };
  buildError: Error | null = null;
  proveResults: CommandResult[] = [];
  proveError: Error | null = null;
  images = new Map<string, string>([
    [BASE, "sha256:base"],
    [SLOT_IMAGE, "sha256:slot"],
  ]);
  existing = new Set<string>();
  calls: string[] = [];
  events: string[] = [];
  buildInputs: ImageBuildInput[] = [];
  proveInputs: ProofInput[] = [];
  woken: string[] = [];
  lines: string[] = [];
  spans: Array<{ trace: ServerTrace; contribution: EnvironmentContribution }> =
    [];
  telemetryFails = false;
  cacheList: Array<{ project_id: string; resource_identity: string }> = [];
  cacheRemovalFails = false;
  clock = 0;
  beforeRelease: (() => void) | null = null;
  script: (tools: ToolDefinition[]) => Promise<void> = async () => {};
  sessionInputs: EnvironmentSessionInput[] = [];
  sessionEnds = 0;
  agentEnabled = false;
  writes: unknown[] = [];
  probes: Array<{
    tags: readonly string[];
    checkout: string;
    argv: readonly string[];
  }> = [];
  readonly root: string;
  readonly proofs: ProofFiles;
  readonly secrets: EnvironmentSecrets;
  readonly custody: CustodyComponent;
  readonly custodyStore: Store;
  readonly onboarding: Onboarding;

  constructor(
    t: TestContext,
    resolve?: ResolveGroup,
    environmentBuildTimeoutMs: number = RUN_DEADLINE_MS,
  ) {
    this.root = temporary(t);
    this.proofs = new ProofFiles(this.root);
    this.custodyStore = new Store(IN_MEMORY_DATABASE);
    t.after(() => this.custodyStore.close());
    this.custodyStore.migrate([
      { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
    ]);
    this.custody = secretCustody(this.custodyStore);
    this.secrets = new EnvironmentSecrets({
      root: this.root,
      transaction: (write) => this.custodyStore.transaction(write),
      identity: testServiceIdentity(PROJECT_SERVICE_NAME),
      custody: this.custody,
      records: this.custody,
      now: () => Date.now(),
    });
    const runtime = {
      runtimeName: RUNTIME_NAME,
      imageId: async (reference: string) => {
        this.calls.push(`imageId ${reference}`);
        return this.images.get(reference) ?? null;
      },
      pullImage: async (reference: string) => {
        this.calls.push(`pullImage ${reference}`);
        this.images.set(reference, "sha256:pulled");
      },
      imageExists: async (tag: string) => this.existing.has(tag),
      build: async (input: ImageBuildInput, signal: AbortSignal) => {
        this.events.push("build");
        this.buildInputs.push(input);
        await hold(this.buildGate, signal);
        if (this.buildError !== null) throw this.buildError;
        return this.buildResult;
      },
      prove: async (
        input: ProofInput & { tag: string },
        signal: AbortSignal,
      ) => {
        this.events.push("prove");
        this.proveInputs.push(input);
        await hold(this.proveGate, signal);
        if (this.proveError !== null) throw this.proveError;
        return this.proveResults;
      },
      proveOnHost: async (input: ProofInput, signal: AbortSignal) => {
        this.events.push("proveOnHost");
        this.proveInputs.push(input);
        await hold(this.proveGate, signal);
        if (this.proveError !== null) throw this.proveError;
        return this.proveResults;
      },
      tagProved: async (tag: string) => {
        this.events.push(`tagProved ${tag}`);
        this.existing.add(`${tag}${PROVED_SUFFIX}`);
      },
      removeTags: async (tags: readonly string[]) => {
        this.events.push(`removeTags ${tags.join(",")}`);
        for (const tag of tags) this.existing.delete(tag);
      },
      collect: async (path: string, keep: string | null) => {
        this.events.push(`collect ${path} ${keep}`);
      },
      removeStaleRuns: async () => {
        this.events.push("removeStaleRuns");
      },
      cacheVolumes: async () => [...this.cacheList],
      removeCacheVolume: async (projectId: string, identity: string) => {
        this.events.push(`removeCacheVolume ${projectId} ${identity}`);
        if (this.cacheRemovalFails) throw new Error(BOOM);
        this.cacheList = this.cacheList.filter(
          (entry) =>
            entry.project_id !== projectId ||
            entry.resource_identity !== identity,
        );
      },
    } as unknown as EnvironmentRuntime;
    this.onboarding = new Onboarding({
      bindingsOf: (projectId) => {
        this.bindingsCalls++;
        return projectId === PROJECT ? this.bindings : facts([], []);
      },
      workerEnvironmentOf: () => this.workerEnvironment,
      projectIds: () => [PROJECT],
      resolveGroup:
        resolve ??
        (async (bindingId, target) => {
          this.resolveCalls.push({ bindingId, target });
          await this.resolveGate?.promise;
          if (this.resolution instanceof Error) throw this.resolution;
          return this.resolution;
        }),
      runtime,
      proofs: this.proofs,
      secrets: {
        entriesOf: (variables) => this.secrets.entriesOf(variables),
        release: (input) => {
          this.beforeRelease?.();
          return this.secrets.release(input);
        },
        remove: (runId) => this.secrets.remove(runId),
      },
      slotImage: SLOT_IMAGE,
      version: VERSION,
      wake: (projectId) => {
        this.events.push(`wake ${projectId}`);
        this.woken.push(projectId);
      },
      environmentAgent: {
        enabled: () => this.agentEnabled,
        run: async (input) => {
          this.sessionInputs.push(input);
          const handle: EnvironmentSessionHandle = {
            session_id: "session_1",
            checkout: CHECKOUT,
            end: () => {
              this.sessionEnds++;
            },
          };
          await this.script(input.tools(handle));
          return "ended";
        },
      },
      probe: {
        run: async (input) => {
          this.probes.push({
            tags: input.tags,
            checkout: input.checkout,
            argv: input.command.argv,
          });
          return PROBE_ANSWER;
        },
      },
      writeEnvironment: async (_projectId, _bindingId, environment) => {
        this.writes.push(environment);
        const written = environment as { invalid?: boolean } & Environment;
        if (written.invalid === true)
          return { written: false, reason: INVALID_DOCUMENT };
        this.resolution = { ...STORED, document: written };
        return { written: true };
      },
      environmentReady: async (projectId, identity, tag) => {
        this.events.push(`environmentReady ${projectId} ${identity} ${tag}`);
      },
      logger: pino(
        { level: "info" },
        { write: (line) => this.lines.push(line) },
      ),
      now: () => ++this.clock,
      runId: () => "run_1",
      environmentBuildTimeoutMs,
      telemetry: {
        span: (trace, contribution) => {
          if (this.telemetryFails) throw new Error(BOOM);
          this.spans.push({ trace, contribution });
        },
      },
    });
    t.after(() => this.onboarding.stop());
  }

  createSecret(text: string = SECRET_TEXT): void {
    this.custodyStore.transaction((tx) =>
      this.custody.create(
        tx,
        SECRET_SET,
        {
          name: SECRET_CREDENTIAL,
          platform: ENVIRONMENT_SECRET_PLATFORM,
          secret: { key: text },
          metadata: null,
        },
        undefined,
      ),
    );
  }

  rotateSecret(expectedRevision: number, text = ROTATED_SECRET_TEXT): void {
    this.custodyStore.transaction((tx) =>
      this.custody.rotate(
        tx,
        SECRET_SET,
        SECRET_CREDENTIAL,
        { expected_revision: expectedRevision, secret: { key: text } },
        undefined,
      ),
    );
  }

  archiveSecret(): CredentialAnswer {
    return this.custodyStore.transaction((tx) =>
      this.custody.archive(tx, SECRET_SET, SECRET_CREDENTIAL),
    );
  }

  secretFile(runId = "run_1"): string {
    return join(this.root, `run-${runId}`, "secrets", SECRET_VARIABLE);
  }

  openBuild(): void {
    const gate = this.buildGate;
    this.buildGate = null;
    gate?.release();
  }

  openProve(): void {
    const gate = this.proveGate;
    this.proveGate = null;
    gate?.release();
  }

  open(): void {
    this.openBuild();
    this.openProve();
  }

  recorded(): string[] {
    return this.spans.map(
      ({ contribution }) =>
        `${contribution.operation}:${contribution.status ?? "start"}`,
    );
  }

  spanOf(operation: string): EnvironmentContribution | undefined {
    return this.spans
      .map(({ contribution }) => contribution)
      .find((contribution) => contribution.operation === operation);
  }

  logged(message: string): Array<Record<string, unknown>> {
    return this.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === message);
  }

  async until(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < UNTIL_ATTEMPTS; attempt++) {
      if (condition()) return;
      await turn();
    }
    assert.fail("The condition did not hold.");
  }

  async ended(count = ONE_CALL): Promise<void> {
    await this.until(() => this.logged(RUN_ENDED).length >= count);
  }

  async endedAfterDeadline(): Promise<void> {
    for (let attempt = 0; attempt < DEADLINE_POLL_ATTEMPTS; attempt++) {
      if (this.logged(RUN_ENDED).length >= ONE_CALL) return;
      await pause(DEADLINE_POLL_MS);
    }
    assert.fail("The run did not end after its deadline.");
  }

  async compute(group: RepositoryGroup = APP): Promise<void> {
    await this.onboarding.compute(PROJECT, group.resource_identity);
  }

  state(group: RepositoryGroup = APP) {
    const found = this.onboarding
      .states(PROJECT)
      .find((state) => state.resource_identity === group.resource_identity);
    assert.ok(found);
    return found;
  }

  tagOf(sum: string, group: RepositoryGroup = APP): string {
    return environmentTagOf(group.resource_identity, sum);
  }

  provedOf(sum: string, group: RepositoryGroup = APP): string {
    return `${this.tagOf(sum, group)}${PROVED_SUFFIX}`;
  }

  pathOf(group: RepositoryGroup = APP): string {
    return environmentPath(group.resource_identity);
  }

  proofOf(sum: string, group: RepositoryGroup = APP): ProofFile | null {
    return this.proofs.read(this.pathOf(group), sum);
  }

  writeProof(file: ProofFile, group: RepositoryGroup = APP): void {
    this.proofs.write(this.pathOf(group), file);
  }

  digest(group: RepositoryGroup = APP): string {
    assert.ok(!(this.resolution instanceof Error));
    const { document } = this.resolution;
    const image = targetOf(group, this.bindings) === EnvironmentTarget.Image;
    return environmentDigest({
      resource_identity: group.resource_identity,
      target: targetOf(group, this.bindings),
      source: this.resolution.source,
      document,
      files: this.resolution.files,
      base_image:
        image && document?.image !== undefined
          ? (this.images.get(document.image) ?? null)
          : null,
      slot_image: image ? (this.images.get(SLOT_IMAGE) ?? null) : null,
      secrets: this.secrets.entriesOf(group.environment_secrets ?? {}),
      version: VERSION,
    });
  }
}

const SECRET_SET = { platforms: ENVIRONMENT_SECRET_PLATFORMS };

function secretCustody(store: Store): CustodyComponent {
  const unexpected = () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  };
  return new CustodyComponent({
    executions: {
      requireRunning: unexpected,
      pinCredential: unexpected,
      liveExecutionsPinning: () => [],
    },
    authorization: { authorizeModelInference: unexpected },
    missionAuthorization: {
      frozenAction: unexpected,
      requestEvidence: unexpected,
      evidenceAsset: unexpected,
      objectPut: unexpected,
    },
    clientSecret: () => Buffer.alloc(32, 9).toString("base64"),
    store,
    platforms: ENVIRONMENT_SECRET_PLATFORMS,
    envelopeKey: Buffer.alloc(32, 7),
    logger: pino({ enabled: false }),
    agentProvidersDependentOn: () => [],
    bindingsNaming: () => [],
    inboundsNaming: () => [],
    intakeServiceName: INTAKE_SERVICE_NAME,
    projectServiceName: PROJECT_SERVICE_NAME,
  });
}

async function hold(gate: Deferred | null, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (gate === null) return;
  await Promise.race([
    gate.promise,
    new Promise<void>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    ),
  ]);
}

function record(override: Partial<GroupRecord> = {}): GroupRecord {
  return {
    project_id: PROJECT,
    binding_id: APP.binding_id,
    binding_name: APP.binding_name,
    resource_identity: APP.resource_identity,
    target: EnvironmentTarget.Image,
    source: "repository",
    commit: "c1",
    document: DOCUMENT,
    secrets: [],
    digest: "d",
    tag: "t",
    proof: null,
    proved: false,
    read_succeeded: true,
    step: null,
    run_started_at: null,
    step_started_at: null,
    reason: null,
    session: null,
    environment_from_agent: false,
    ...override,
  };
}

test("targetOf answers image for a container worker binding that names the group", () => {
  assert.equal(
    targetOf(APP, facts([APP, DOCS], [container("app")])),
    EnvironmentTarget.Image,
  );
  assert.equal(
    targetOf(DOCS, facts([APP, DOCS], [container("app")])),
    EnvironmentTarget.Host,
  );
});

test("targetOf answers image through the default of the environment key", () => {
  assert.equal(
    targetOf(APP, facts([APP], [container(null)])),
    EnvironmentTarget.Image,
  );
  assert.equal(
    targetOf(APP, facts([APP, DOCS], [container(null)])),
    EnvironmentTarget.Host,
  );
});

test("targetOf answers image for a server binding next to a container binding of the group", () => {
  assert.equal(
    targetOf(APP, facts([APP], [server, container("app")])),
    EnvironmentTarget.Image,
  );
});

test("targetOf answers remote when every worker binding is at the worker placement or external", () => {
  assert.equal(
    targetOf(APP, facts([APP], [remoteWorker])),
    EnvironmentTarget.Remote,
  );
  assert.equal(
    targetOf(APP, facts([APP], [remoteWorker, external])),
    EnvironmentTarget.Remote,
  );
  assert.equal(
    targetOf(APP, facts([APP], [remoteWorker, server])),
    EnvironmentTarget.Host,
  );
});

test("targetOf answers host with no worker binding", () => {
  assert.equal(targetOf(APP, facts([APP], [])), EnvironmentTarget.Host);
});

function result(
  phase: CommandResult["phase"],
  command: string,
  exit_code: number | null,
  override: Partial<CommandResult> = {},
): CommandResult {
  return {
    phase,
    command,
    exit_code,
    timed_out: false,
    output: "",
    ...override,
  };
}

const PASSING_RESULTS = [
  result("setup", "make setup", 0),
  result("check", "make test", 0),
];

test("a stored environment answers stored at every target", async (t) => {
  for (const workers of [[container("app")], [], [remoteWorker]]) {
    const h = new Harness(t);
    h.resolution = STORED;
    h.bindings = facts([APP], workers);
    await h.compute();
    assert.equal(h.state().source, STORED_SOURCE);
  }
});

test("a repository devcontainer answers repository at image and none at host", async (t) => {
  const image = new Harness(t);
  await image.compute();
  assert.equal(image.state().source, REPOSITORY_SOURCE);
  assert.deepEqual(image.resolveCalls, [
    { bindingId: APP.binding_id, target: EnvironmentTarget.Image },
  ]);
  const host = new Harness(t);
  host.bindings = facts([APP], []);
  host.resolution = NOTHING;
  await host.compute();
  assert.equal(host.state().source, NONE_SOURCE);
  assert.equal(host.resolveCalls[0]?.target, EnvironmentTarget.Host);
});

test("no document answers none", async (t) => {
  const h = new Harness(t);
  h.resolution = NOTHING;
  await h.compute();
  assert.equal(h.state().source, NONE_SOURCE);
  assert.equal(h.state().status, EnvironmentStatus.None);
});

test("the digest of a record equals the environment digest of its inputs at image", async (t) => {
  const h = new Harness(t);
  await h.compute();
  const expected = environmentDigest({
    resource_identity: APP.resource_identity,
    target: EnvironmentTarget.Image,
    source: "repository",
    document: DOCUMENT,
    files: REPOSITORY.files,
    base_image: "sha256:base",
    slot_image: "sha256:slot",
    secrets: [],
    version: VERSION,
  });
  assert.equal(h.state().digest, expected);
  assert.equal(h.state().digest, h.digest());
  assert.equal(h.state().tag, h.tagOf(expected));
  assert.deepEqual(h.calls, [`imageId ${BASE}`, `imageId ${SLOT_IMAGE}`]);
});

test("the run pulls a missing base image before the digest", async (t) => {
  const h = new Harness(t);
  h.images.delete(BASE);
  await h.compute();
  assert.deepEqual(h.calls, [
    `imageId ${BASE}`,
    `pullImage ${BASE}`,
    `imageId ${BASE}`,
    `imageId ${SLOT_IMAGE}`,
  ]);
  const expected = environmentDigest({
    resource_identity: APP.resource_identity,
    target: EnvironmentTarget.Image,
    source: "repository",
    document: DOCUMENT,
    files: REPOSITORY.files,
    base_image: "sha256:pulled",
    slot_image: "sha256:slot",
    secrets: [],
    version: VERSION,
  });
  assert.equal(h.state().digest, expected);
});

test("the digest holds null base and slot images outside image", async (t) => {
  const h = new Harness(t);
  h.bindings = facts([APP], []);
  h.resolution = STORED;
  await h.compute();
  const expected = environmentDigest({
    resource_identity: APP.resource_identity,
    target: EnvironmentTarget.Host,
    source: "stored",
    document: DOCUMENT,
    files: REPOSITORY.files,
    base_image: null,
    slot_image: null,
    secrets: [],
    version: VERSION,
  });
  assert.equal(h.state().digest, expected);
  assert.deepEqual(h.calls, []);
});

test("status rule 2: a group with no successful read is pending", async (t) => {
  const h = new Harness(t);
  h.resolution = new Error(UNREACHABLE);
  await h.compute();
  assert.equal(h.state().status, EnvironmentStatus.Pending);
  assert.equal(h.state().reason, UNREACHABLE);
  assert.equal(h.state().digest, null);
  assert.equal(
    h.onboarding.environmentsClaimable(PROJECT, [APP.resource_identity]),
    false,
  );
});

test("status rule 3: a failed proof file decides failed before a proved tag", async (t) => {
  const h = new Harness(t);
  const sum = h.digest();
  h.existing.add(h.provedOf(sum));
  h.writeProof(
    proofFile(sum, {
      outcome: "failed",
      class: "setup_failed",
      command: "make setup",
      exit_code: 3,
      tail: "boom",
      reproduce: "docker run",
      ended_at: 7,
    }),
  );
  await h.compute();
  const state = h.state();
  assert.equal(state.status, EnvironmentStatus.Failed);
  assert.deepEqual(state.failure, {
    class: "setup_failed",
    origin: "onboarding",
    execution_id: null,
    command: "make setup",
    exit_code: 3,
    tail: "boom",
    reproduce: "docker run",
    ended_at: 7,
  });
});

test("status rule 4: a proved tag at image and a passed proof at host decide ready", async (t) => {
  const h = new Harness(t);
  h.existing.add(h.provedOf(h.digest()));
  await h.compute();
  assert.equal(h.state().status, EnvironmentStatus.Ready);
  assert.equal(h.state().failure, null);

  const host = new Harness(t);
  host.bindings = facts([APP], []);
  host.resolution = STORED;
  host.writeProof(proofFile(host.digest()));
  await host.compute();
  assert.equal(host.state().status, EnvironmentStatus.Ready);
  assert.deepEqual(host.state().checks, [
    { command: "make test", exit_code: 2 },
  ]);
});

test("status rule 5: source none decides none", async (t) => {
  for (const workers of [[container("app")], []]) {
    const h = new Harness(t);
    h.bindings = facts([APP], workers);
    h.resolution = NOTHING;
    await h.compute();
    assert.equal(h.state().status, EnvironmentStatus.None);
  }
});

test("status rule 6: the step is building without the tag and proving with it", async (t) => {
  const h = new Harness(t);
  await h.compute();
  assert.equal(h.state().status, EnvironmentStatus.Building);

  const tagged = new Harness(t);
  tagged.existing.add(tagged.tagOf(tagged.digest()));
  await tagged.compute();
  assert.equal(tagged.state().status, EnvironmentStatus.Proving);

  const host = new Harness(t);
  host.bindings = facts([APP], []);
  host.resolution = STORED;
  await host.compute();
  assert.equal(host.state().status, EnvironmentStatus.Proving);
});

test("status rule 1: an active run decides the step before any other rule", () => {
  const failed = proofFile("d", { outcome: "failed", class: "setup_failed" });
  assert.equal(
    statusOf(
      record({
        step: EnvironmentStatus.Building,
        run_started_at: 1,
        proof: failed,
      }),
    ),
    EnvironmentStatus.Building,
  );
  assert.equal(
    statusOf(record({ step: EnvironmentStatus.Proving, run_started_at: 1 })),
    EnvironmentStatus.Proving,
  );
});

test("at remote the status is failed by a failed proof file, or none", async (t) => {
  const h = new Harness(t);
  h.bindings = facts([APP], [remoteWorker]);
  h.resolution = STORED;
  const sum = h.digest();
  await h.compute();
  assert.equal(h.state().target, EnvironmentTarget.Remote);
  assert.equal(h.state().status, EnvironmentStatus.None);
  assert.deepEqual(h.resolveCalls[0], {
    bindingId: APP.binding_id,
    target: EnvironmentTarget.Remote,
  });
  h.writeProof(proofFile(sum));
  await h.compute();
  assert.equal(h.state().status, EnvironmentStatus.None);
  h.writeProof(proofFile(sum, { outcome: "failed", class: "setup_failed" }));
  await h.compute();
  assert.equal(h.state().status, EnvironmentStatus.Failed);
  assert.deepEqual(h.events, [`wake ${PROJECT}`]);
});

test("a failed first read sets the reason and keeps the group pending", async (t) => {
  const h = new Harness(t);
  h.resolution = new Error(BRANCH_ABSENT);
  await h.compute();
  assert.equal(h.state().status, EnvironmentStatus.Pending);
  assert.equal(h.state().reason, BRANCH_ABSENT);
});

test("a failed read after a successful read keeps the status and the digest", async (t) => {
  const h = new Harness(t);
  const sum = h.digest();
  h.existing.add(h.provedOf(sum));
  await h.compute();
  assert.equal(h.state().status, EnvironmentStatus.Ready);
  h.resolution = new Error(TRANSIENT);
  await h.compute();
  assert.equal(h.state().status, EnvironmentStatus.Ready);
  assert.equal(h.state().digest, sum);
  assert.equal(h.state().reason, TRANSIENT);
  assert.equal(
    h.onboarding.environmentsClaimable(PROJECT, [APP.resource_identity]),
    true,
  );
  h.resolution = REPOSITORY;
  await h.compute();
  assert.equal(h.state().reason, null);
});

const READ_FAILED = "project.onboarding.read_failed";
const SSH_READ_FAILED = "Repository SSH read failed.";
const KEY_REFUSED = "key_refused";
const SSH_UNREACHABLE_STATUS = 422;
const ERROR_LEVEL = 50;
const TWO_RECORDS = 2;

function sshReadError(failureReason: string = KEY_REFUSED): OperationError {
  return new OperationError(
    SSH_UNREACHABLE_STATUS,
    ProjectErrorCode.RepositorySshUnreachable,
    SSH_READ_FAILED,
    { failure_reason: failureReason },
  );
}

test("a failed SSH read carries the failure reason into the reason", async (t) => {
  const h = new Harness(t);
  h.resolution = sshReadError();
  await h.compute();
  assert.equal(h.state().status, EnvironmentStatus.Pending);
  assert.equal(
    h.state().reason,
    `${SSH_READ_FAILED} The failure reason is ${KEY_REFUSED}.`,
  );
});

test("a failed read logs one read_failed record until the reason changes", async (t) => {
  const h = new Harness(t);
  h.resolution = sshReadError();
  await h.compute();
  await h.compute();
  assert.deepEqual(
    h
      .logged(READ_FAILED)
      .map(
        ({
          level,
          project_id,
          binding,
          resource_identity,
          reason,
          failure_reason,
        }) => ({
          level,
          project_id,
          binding,
          resource_identity,
          reason,
          failure_reason,
        }),
      ),
    [
      {
        level: ERROR_LEVEL,
        project_id: PROJECT,
        binding: APP_NAME,
        resource_identity: APP.resource_identity,
        reason: `${SSH_READ_FAILED} The failure reason is ${KEY_REFUSED}.`,
        failure_reason: KEY_REFUSED,
      },
    ],
  );
  h.resolution = new Error(TRANSIENT);
  await h.compute();
  await h.compute();
  const records = h.logged(READ_FAILED);
  assert.equal(records.length, TWO_RECORDS);
  assert.equal(records[1]?.reason, TRANSIENT);
  assert.equal(records[1]?.failure_reason, null);
});

test("a read that answers an invalid document logs a read_failed record", async (t) => {
  const h = new Harness(t);
  h.resolution = { ...REPOSITORY, reason: INVALID_DOCUMENT };
  await h.compute();
  assert.equal(h.state().status, EnvironmentStatus.Pending);
  const [record] = h.logged(READ_FAILED);
  assert.equal(record?.reason, INVALID_DOCUMENT);
  assert.equal(record?.failure_reason, null);
});

test("a binding change re-arms the read_failed record", async (t) => {
  const h = new Harness(t);
  h.resolution = sshReadError();
  await h.compute();
  assert.equal(h.logged(READ_FAILED).length, ONE_CALL);
  h.bindings = facts(
    [{ ...APP, binding_id: RENAMED_BINDING_ID }],
    [container("app")],
  );
  h.onboarding.bindingsChanged(PROJECT);
  await h.until(() => h.logged(READ_FAILED).length === TWO_RECORDS);
  const [, record] = h.logged(READ_FAILED);
  assert.equal(
    record?.reason,
    `${SSH_READ_FAILED} The failure reason is ${KEY_REFUSED}.`,
  );
});

test("a target change re-arms the read_failed record", async (t) => {
  const h = new Harness(t);
  h.bindings = facts([APP], [server]);
  h.resolution = sshReadError();
  await h.compute();
  assert.equal(h.logged(READ_FAILED).length, ONE_CALL);
  h.bindings = facts([APP], [container("app")]);
  h.onboarding.bindingsChanged(PROJECT);
  await h.until(() => h.logged(READ_FAILED).length === TWO_RECORDS);
});

test("a failed read after a target change writes the new target, and a later write of the same facts logs no second record", async (t) => {
  const h = new Harness(t);
  h.bindings = facts([APP], [server]);
  h.resolution = sshReadError();
  await h.compute();
  h.bindings = facts([APP], [container("app")]);
  h.onboarding.bindingsChanged(PROJECT);
  await h.until(() => h.logged(READ_FAILED).length === TWO_RECORDS);
  assert.equal(h.state().target, EnvironmentTarget.Image);
  h.onboarding.bindingsChanged(PROJECT);
  await h.until(() => h.resolveCalls.length === THREE_CALLS);
  await h.until(() => !h.onboarding["computing"].size);
  assert.equal(h.logged(READ_FAILED).length, TWO_RECORDS);
});

test("a successful read logs nothing and rearms the read_failed record", async (t) => {
  const h = new Harness(t);
  h.existing.add(h.provedOf(h.digest()));
  h.resolution = sshReadError();
  await h.compute();
  h.resolution = REPOSITORY;
  await h.compute();
  assert.equal(h.state().status, EnvironmentStatus.Ready);
  assert.equal(h.logged(READ_FAILED).length, ONE_CALL);
  h.resolution = sshReadError();
  await h.compute();
  assert.equal(h.logged(READ_FAILED).length, TWO_RECORDS);
});

test("states answers the fields of an environment state in binding name order", async (t) => {
  const h = new Harness(t);
  h.bindings = facts([DOCS, APP], []);
  h.resolution = STORED;
  h.writeProof(
    proofFile(h.digest(DOCS), {
      outcome: "failed",
      class: COMMAND_ABSENT,
      command: "make test",
      exit_code: 127,
      tail: "not found",
      checks: [],
      repairs: 2,
    }),
    DOCS,
  );
  await h.compute(DOCS);
  await h.compute(APP);
  const states = h.onboarding.states(PROJECT);
  assert.deepEqual(
    states.map((state) => state.binding_name),
    ["app", "docs"],
  );
  for (const state of states) environmentStateSchema.parse(state);
  const [app, docs] = states;
  assert.ok(app && docs);
  assert.equal(app.tag, null);
  assert.equal(app.target, EnvironmentTarget.Host);
  assert.equal(app.repairing, false);
  assert.equal(app.failure, null);
  assert.equal(docs.status, EnvironmentStatus.Failed);
  assert.equal(docs.failure?.class, COMMAND_ABSENT);
  assert.equal(docs.repairs, DOCS_REPAIRS);
  assert.deepEqual(docs.checks, []);
  assert.equal(docs.binding_id, DOCS.binding_id);
  assert.equal(docs.resource_identity, DOCS.resource_identity);
  assert.equal(docs.binding_name, DOCS_NAME);
  assert.equal(docs.digest, h.digest(DOCS));
  assert.equal(docs.reason, null);
  assert.equal(docs.repairing, false);
  assert.deepEqual(h.onboarding.states("project_2"), []);
});

test("environmentsClaimable answers true for none and ready only", async (t) => {
  const identities = [APP.resource_identity];
  const claimableOf = (h: Harness) =>
    h.onboarding.environmentsClaimable(PROJECT, identities);

  const none = new Harness(t);
  none.resolution = NOTHING;
  await none.compute();
  assert.equal(claimableOf(none), true);

  const ready = new Harness(t);
  ready.existing.add(ready.provedOf(ready.digest()));
  await ready.compute();
  assert.equal(claimableOf(ready), true);

  const building = new Harness(t);
  await building.compute();
  assert.equal(building.state().status, EnvironmentStatus.Building);
  assert.equal(claimableOf(building), false);

  const proving = new Harness(t);
  proving.existing.add(proving.tagOf(proving.digest()));
  await proving.compute();
  assert.equal(proving.state().status, EnvironmentStatus.Proving);
  assert.equal(claimableOf(proving), false);

  const failed = new Harness(t);
  failed.writeProof(
    proofFile(failed.digest(), { outcome: "failed", class: "setup_failed" }),
  );
  await failed.compute();
  assert.equal(failed.state().status, EnvironmentStatus.Failed);
  assert.equal(claimableOf(failed), false);

  const pending = new Harness(t);
  pending.resolution = new Error("down");
  await pending.compute();
  assert.equal(claimableOf(pending), false);

  assert.equal(none.onboarding.environmentsClaimable(PROJECT, []), true);
});

test(
  "environmentsClaimable answers false for an unknown group and computes it",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.resolution = NOTHING;
    assert.equal(
      h.onboarding.environmentsClaimable(PROJECT, [APP.resource_identity]),
      false,
    );
    await turn();
    assert.equal(
      h.onboarding.environmentsClaimable(PROJECT, [APP.resource_identity]),
      true,
    );
    assert.equal(h.resolveCalls.length, ONE_CALL);
  },
);

test("a group that becomes claimable by a compute wakes the project once", async (t) => {
  const h = new Harness(t);
  h.resolution = NOTHING;
  await h.compute();
  await h.compute();
  assert.deepEqual(h.woken, [PROJECT]);
});

test("environmentDigestOf answers the digest, keeps it after a failed read and answers null with no record", async (t) => {
  const h = new Harness(t);
  assert.equal(
    h.onboarding.environmentDigestOf(PROJECT, APP.resource_identity),
    null,
  );
  const sum = h.digest();
  h.existing.add(h.provedOf(sum));
  await h.compute();
  assert.equal(
    h.onboarding.environmentDigestOf(PROJECT, APP.resource_identity),
    sum,
  );
  h.resolution = new Error("down");
  await h.compute();
  assert.equal(
    h.onboarding.environmentDigestOf(PROJECT, APP.resource_identity),
    sum,
  );
});

test(
  "a trigger during a compute marks the group for one more compute",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.resolution = NOTHING;
    h.resolveGate = new Deferred();
    const first = h.compute();
    await turn();
    const second = h.compute();
    const third = h.compute();
    assert.equal(h.resolveCalls.length, ONE_CALL);
    h.resolveGate.release();
    await Promise.all([first, second, third]);
    assert.equal(h.resolveCalls.length, TWO_CALLS);
  },
);

test(
  "slotImage resolves the tag for ready and the slot image for none",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
    const ready = new Harness(t);
    const sum = ready.digest();
    ready.existing.add(ready.provedOf(sum));
    await ready.compute();
    assert.equal(
      await ready.onboarding.slotImage(PROJECT, WORKER_IDENTITY, signal),
      ready.tagOf(sum),
    );

    const none = new Harness(t);
    none.resolution = NOTHING;
    assert.equal(
      await none.onboarding.slotImage(PROJECT, WORKER_IDENTITY, signal),
      SLOT_IMAGE,
    );
  },
);

test(
  "slotImage waits through building and resolves after the record turns ready",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    await h.compute();
    assert.equal(h.state().status, EnvironmentStatus.Building);
    let settled = false;
    const answer = h.onboarding
      .slotImage(PROJECT, WORKER_IDENTITY, AbortSignal.timeout(TEST_TIMEOUT_MS))
      .finally(() => (settled = true));
    await turn();
    await turn();
    assert.equal(settled, false);
    h.open();
    assert.equal(await answer, h.tagOf(h.digest()));
    assert.equal(h.state().status, EnvironmentStatus.Ready);
  },
);

test(
  "slotImage rejects when the signal aborts",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    await h.compute();
    const controller = new AbortController();
    const answer = h.onboarding.slotImage(
      PROJECT,
      WORKER_IDENTITY,
      controller.signal,
    );
    await turn();
    const reason = new Error("stop");
    controller.abort(reason);
    await assert.rejects(answer, reason);
  },
);

test(
  "two groups that need a run start in arrival order",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.bindings = facts([APP, DOCS], [container("app"), container("docs")]);
    await h.compute(APP);
    await h.compute(DOCS);
    await h.until(() => h.events.length > NO_CALLS);
    assert.deepEqual(h.events, ["build"]);
    assert.equal(h.buildInputs[0]?.resource_identity, APP.resource_identity);
    assert.equal(h.state(DOCS).status, EnvironmentStatus.Building);
    assert.equal(h.state(DOCS).run_started_at, null);
    h.open();
    await h.ended(TWO_CALLS);
    const builds = h.buildInputs.map((input) => input.resource_identity);
    assert.deepEqual(builds, [APP.resource_identity, DOCS.resource_identity]);
    assert.ok(
      h.events.indexOf(`collect ${h.pathOf(APP)} ${h.digest(APP)}`) <
        h.events.lastIndexOf("build"),
    );
  },
);

test(
  "an image run builds, proves, tags, collects, drains the slots and then wakes",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.open();
    h.proveResults = PASSING_RESULTS;
    await h.compute();
    await h.ended();
    const sum = h.digest();
    const tag = h.tagOf(sum);
    assert.deepEqual(h.events, [
      "build",
      "prove",
      `tagProved ${tag}`,
      `collect ${h.pathOf()} ${sum}`,
      `environmentReady ${PROJECT} ${APP.resource_identity} ${tag}`,
      `wake ${PROJECT}`,
    ]);
    assert.deepEqual(h.buildInputs[0], {
      run_id: "run_1",
      binding_id: APP.binding_id,
      resource_identity: APP.resource_identity,
      commit: "c1",
      tag,
      document: DOCUMENT,
      secrets: [],
    });
    assert.deepEqual(h.proveInputs[0], {
      run_id: "run_1",
      project_id: PROJECT,
      binding_id: APP.binding_id,
      resource_identity: APP.resource_identity,
      commit: "c1",
      setup: ["make setup"],
      checks: ["make test"],
      tag,
    });
    const file = h.proofOf(sum);
    assert.ok(file);
    assert.equal(file.outcome, PASSED);
    assert.equal(file.origin, ONBOARDING);
    assert.equal(file.class, null);
    assert.equal(file.repairs, NO_REPAIRS);
    assert.deepEqual(file.checks, []);
    assert.equal(file.reproduce, `${RUNTIME_NAME} run -it --rm ${tag} bash`);
    assert.equal(h.state().status, EnvironmentStatus.Ready);
  },
);

test(
  "an image run with an existing tag skips the build",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.open();
    h.existing.add(h.tagOf(h.digest()));
    await h.compute();
    await h.ended();
    assert.equal(h.events.includes("build"), false);
    assert.equal(h.events[0], PROVE);
    assert.equal(h.state().status, EnvironmentStatus.Ready);
  },
);

test(
  "a failed build writes the failure, runs no proof and tags nothing",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.open();
    h.buildResult = {
      outcome: "failed",
      class: "build_failed",
      tail: "no space",
    };
    await h.compute();
    await h.ended();
    const file = h.proofOf(h.digest());
    assert.ok(file);
    assert.equal(file.outcome, FAILED);
    assert.equal(file.class, BUILD_FAILED);
    assert.equal(file.tail, NO_SPACE);
    assert.equal(h.events.includes("prove"), false);
    assert.equal(
      h.events.some((event) => event.startsWith("tagProved")),
      false,
    );
    assert.equal(h.state().status, EnvironmentStatus.Failed);
    assert.equal(h.woken.length, NO_CALLS);
  },
);

test(
  "a proof with a failed setup writes setup_failed and the reproduce command",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.open();
    h.proveResults = [
      result("setup", "make setup", 3, { output: "boom" }),
      result("check", "make test", 0),
    ];
    await h.compute();
    await h.ended();
    const sum = h.digest();
    const file = h.proofOf(sum);
    assert.ok(file);
    assert.equal(file.outcome, FAILED);
    assert.equal(file.class, SETUP_FAILED);
    assert.equal(file.command, MAKE_SETUP);
    assert.equal(file.exit_code, SETUP_EXIT);
    assert.equal(file.tail, BOOM);
    assert.equal(file.reproduce, `podman run -it --rm ${h.tagOf(sum)} bash`);
    const [ended] = h.logged(RUN_ENDED);
    assert.equal(ended?.class, SETUP_FAILED);
    assert.equal(ended?.status, EnvironmentStatus.Failed);
  },
);

test(
  "a proof with a red check writes passed with the baseline",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.open();
    h.proveResults = [
      result("setup", "make setup", 0),
      result("check", "make test", 2),
    ];
    await h.compute();
    await h.ended();
    const file = h.proofOf(h.digest());
    assert.ok(file);
    assert.equal(file.outcome, PASSED);
    assert.deepEqual(file.checks, [{ command: "make test", exit_code: 2 }]);
  },
);

test(
  "a timed out proof result is classified",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.open();
    h.proveResults = [result("setup", "make setup", null, { timed_out: true })];
    await h.compute();
    await h.ended();
    assert.equal(h.proofOf(h.digest())?.class, SETUP_FAILED);
  },
);

test(
  "a host run proves on the host, never builds and writes a null reproduce",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.open();
    h.bindings = facts([APP], []);
    h.resolution = STORED;
    h.proveResults = PASSING_RESULTS;
    await h.compute();
    await h.ended();
    const sum = h.digest();
    assert.deepEqual(h.events, [
      "proveOnHost",
      `collect ${h.pathOf()} ${sum}`,
      `wake ${PROJECT}`,
    ]);
    const file = h.proofOf(sum);
    assert.ok(file);
    assert.equal(file.reproduce, null);
    assert.equal(h.state().status, EnvironmentStatus.Ready);
  },
);

test(
  "the status goes building, proving and ready with the start times set during the run",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    await h.compute();
    await h.until(() => h.state().run_started_at !== null);
    const building = h.state();
    assert.equal(building.status, EnvironmentStatus.Building);
    assert.notEqual(building.step_started_at, null);
    h.openBuild();
    await h.until(() => h.state().status === EnvironmentStatus.Proving);
    const proving = h.state();
    assert.equal(proving.run_started_at, building.run_started_at);
    assert.ok(
      proving.step_started_at !== null &&
        building.step_started_at !== null &&
        proving.step_started_at > building.step_started_at,
    );
    h.openProve();
    await h.ended();
    const ready = h.state();
    assert.equal(ready.status, EnvironmentStatus.Ready);
    assert.equal(ready.run_started_at, null);
    assert.equal(ready.step_started_at, null);
  },
);

test(
  "a trigger during a run marks the group and a second compute follows the run",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    await h.compute();
    await h.until(() => h.state().run_started_at !== null);
    await h.compute();
    assert.equal(h.resolveCalls.length, ONE_CALL);
    h.open();
    await h.until(() => h.resolveCalls.length === TWO_CALLS);
    await h.ended();
    assert.equal(h.state().status, EnvironmentStatus.Ready);
  },
);

test(
  "a stop of the component aborts the run and writes no proof file",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    await h.compute();
    await h.until(() => h.events.length > NO_CALLS);
    await h.onboarding.stop();
    assert.deepEqual(h.proofs.digests(h.pathOf()), []);
    assert.equal(
      h.events.some((event) => event.startsWith("tagProved")),
      false,
    );
    assert.equal(h.woken.length, NO_CALLS);
  },
);

test(
  "a deadline in the build writes build_failed with the deadline tail",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    const timeouts: number[] = [];
    t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
      timeouts.push(milliseconds);
      return AbortSignal.abort(new Error("deadline"));
    });
    await h.compute();
    await h.ended();
    assert.deepEqual(timeouts, [RUN_DEADLINE_MS]);
    const file = h.proofOf(h.digest());
    assert.ok(file);
    assert.equal(file.class, BUILD_FAILED);
    assert.equal(file.tail, DEADLINE_TAIL);
  },
);

test(
  "the deadline option cancels a build that never ends and writes build_failed",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t, undefined, SHORT_DEADLINE_MS);
    await h.compute();
    await h.endedAfterDeadline();
    const file = h.proofOf(h.digest());
    assert.ok(file);
    assert.equal(file.outcome, FAILED);
    assert.equal(file.class, BUILD_FAILED);
    assert.equal(h.state().status, EnvironmentStatus.Failed);
  },
);

test(
  "a rejection of the proof writes a failed proof file and leaves no pending status",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.proveError = new Error(PROOF_CRASHED);
    await h.compute();
    h.open();
    await h.ended();
    const file = h.proofOf(h.digest());
    assert.ok(file);
    assert.equal(file.outcome, FAILED);
    assert.equal(file.class, SETUP_FAILED);
    assert.equal(file.tail, PROOF_CRASHED);
    assert.equal(h.state().status, EnvironmentStatus.Failed);
    assert.equal(h.state().run_started_at, null);
  },
);

test(
  "a rejection of the host proof writes a failed proof file",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.bindings = facts([APP], []);
    h.resolution = STORED;
    h.proveError = new Error(HOST_CRASHED);
    await h.compute();
    h.open();
    await h.ended();
    const file = h.proofOf(h.digest());
    assert.ok(file);
    assert.equal(file.outcome, FAILED);
    assert.equal(file.tail, HOST_CRASHED);
    assert.equal(h.state().status, EnvironmentStatus.Failed);
  },
);

test(
  "a deadline in the proof writes setup_failed with the deadline tail",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.existing.add(h.tagOf(h.digest()));
    t.mock.method(AbortSignal, "timeout", () =>
      AbortSignal.abort(new Error("deadline")),
    );
    await h.compute();
    await h.ended();
    const file = h.proofOf(h.digest());
    assert.ok(file);
    assert.equal(file.class, SETUP_FAILED);
    assert.equal(file.tail, DEADLINE_TAIL);
  },
);

test(
  "the logger receives the start and the end of a run",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    await h.compute();
    await h.until(() => h.logged(RUN_STARTED).length > NO_CALLS);
    h.open();
    await h.ended();
    const sum = h.digest();
    const [started] = h.logged(RUN_STARTED);
    const [ended] = h.logged(RUN_ENDED);
    assert.equal(started?.binding, APP_NAME);
    assert.equal(started?.digest, sum);
    assert.equal(started?.target, IMAGE);
    assert.equal(started?.status, EnvironmentStatus.Building);
    assert.equal(started?.class, null);
    assert.equal(ended?.status, EnvironmentStatus.Ready);
    assert.equal(ended?.digest, sum);
    assert.equal(ended?.target, IMAGE);
    assert.equal(ended?.binding, APP_NAME);
    assert.equal(ended?.class, null);
  },
);

test(
  "the collection removes the proof files of other digests of the path",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.open();
    h.writeProof(proofFile("old"));
    await h.compute();
    await h.ended();
    assert.deepEqual(h.proofs.digests(h.pathOf()), [h.digest()]);
  },
);

function failureInput(
  h: Harness,
  override: Partial<EnvironmentFailedInput> = {},
): EnvironmentFailedInput {
  return {
    project_id: PROJECT,
    execution_id: "execution_1",
    resource_identities: [APP.resource_identity],
    stop: { code: "setup_failed", detail: "boom" },
    ...override,
    digests: override.digests ?? { [APP.resource_identity]: h.digest() },
  };
}

async function readyHarness(t: TestContext): Promise<Harness> {
  const h = new Harness(t);
  h.existing.add(h.provedOf(h.digest()));
  await h.compute();
  assert.equal(h.state().status, EnvironmentStatus.Ready);
  h.woken.length = 0;
  return h;
}

test("environmentFailed writes the failed proof file of the current digest", async (t) => {
  const h = await readyHarness(t);
  h.onboarding.environmentFailed(
    failureInput(h, {
      stop: {
        code: "command_absent",
        detail: JSON.stringify({ command: "make test", exit_code: 127 }),
      },
    }),
  );
  const file = h.proofOf(h.digest());
  assert.ok(file);
  assert.equal(file.outcome, FAILED);
  assert.equal(file.origin, EXECUTION);
  assert.equal(file.execution_id, EXECUTION_ID);
  assert.equal(file.class, COMMAND_ABSENT);
  assert.equal(
    file.tail,
    JSON.stringify({ command: "make test", exit_code: 127 }),
  );
  assert.equal(file.command, MAKE_TEST);
  assert.equal(file.exit_code, COMMAND_ABSENT_EXIT);
  assert.equal(h.state().status, EnvironmentStatus.Failed);
  assert.equal(h.state().failure?.origin, EXECUTION);
  assert.equal(h.woken.length, NO_CALLS);
});

test("environmentFailed keeps a null command and exit code for a text detail", async (t) => {
  const h = await readyHarness(t);
  h.onboarding.environmentFailed(failureInput(h));
  const file = h.proofOf(h.digest());
  assert.ok(file);
  assert.equal(file.tail, BOOM);
  assert.equal(file.command, null);
  assert.equal(file.exit_code, null);
});

test("environmentFailed skips a group with no record or no digest", async (t) => {
  const h = new Harness(t);
  h.resolution = new Error("down");
  await h.compute();
  h.onboarding.environmentFailed({
    ...failureInput(h, { digests: {} }),
    resource_identities: [APP.resource_identity, DOCS.resource_identity],
  });
  assert.deepEqual(h.proofs.digests(h.pathOf()), []);
  assert.deepEqual(h.proofs.digests(h.pathOf(DOCS)), []);
  assert.equal(h.state().status, EnvironmentStatus.Pending);
});

test("environmentFailed keeps the status of a group with another current digest", async (t) => {
  const h = await readyHarness(t);
  h.onboarding.environmentFailed(
    failureInput(h, { digests: { [APP.resource_identity]: "older" } }),
  );
  assert.deepEqual(h.proofs.digests(h.pathOf()), []);
  assert.equal(h.state().status, EnvironmentStatus.Ready);
});

test("environmentFailed keeps the status of a group with no digests entry", async (t) => {
  const h = await readyHarness(t);
  h.onboarding.environmentFailed(failureInput(h, { digests: {} }));
  assert.deepEqual(h.proofs.digests(h.pathOf()), []);
  assert.equal(h.state().status, EnvironmentStatus.Ready);

  const none = new Harness(t);
  none.bindings = facts([APP], []);
  none.resolution = NOTHING;
  await none.compute();
  none.onboarding.environmentFailed(failureInput(none, { digests: {} }));
  assert.equal(none.state().status, EnvironmentStatus.None);
  none.onboarding.environmentFailed(
    failureInput(none, {
      digests: { [APP.resource_identity]: none.digest() },
    }),
  );
  assert.equal(none.state().status, EnvironmentStatus.Failed);
  assert.equal(none.state().failure?.reproduce, null);
});

async function readyWithProof(t: TestContext): Promise<Harness> {
  const h = await readyHarness(t);
  h.writeProof(proofFile(h.digest()));
  return h;
}

test(
  "rebuild removes the proof file and the tags, pulls the image, starts a run and answers the state",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = await readyWithProof(t);
    const oldSum = h.digest();
    const oldTag = h.tagOf(oldSum);
    const state = await h.onboarding.rebuild(PROJECT, APP.binding_id);
    assert.equal(h.proofOf(oldSum), null);
    assert.ok(
      h.events.includes(
        `removeTags ${oldTag},${oldTag}${BASE_SUFFIX},${oldTag}${PROVED_SUFFIX}`,
      ),
    );
    assert.deepEqual(
      h.calls.filter((call) => call.startsWith("pull")),
      [`pullImage ${BASE}`],
    );
    await h.until(() => h.events.includes("build"));
    assert.equal(state.binding_id, APP.binding_id);
    assert.equal(
      h.onboarding.states(PROJECT)[0]?.status,
      EnvironmentStatus.Building,
    );
    assert.ok(
      state.status === EnvironmentStatus.Building ||
        state.status === EnvironmentStatus.Proving,
    );
    environmentStateSchema.parse(state);
  },
);

test(
  "rebuild answers 409 during an active run of the group",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    await h.compute();
    await h.until(() => h.state().run_started_at !== null);
    await assert.rejects(
      h.onboarding.rebuild(PROJECT, APP.binding_id),
      (error: unknown) =>
        error instanceof OperationError &&
        error.status === HttpStatus.Conflict &&
        error.code === ProjectErrorCode.EnvironmentRunActive,
    );
  },
);

test("rebuild answers 404 for an unknown, a foreign, a removed and a worker binding", async (t) => {
  const h = new Harness(t);
  h.resolution = NOTHING;
  await h.compute();
  const notFound = (error: unknown) =>
    error instanceof OperationError &&
    error.status === HttpStatus.NotFound &&
    error.code === ProjectErrorCode.BindingNotFound;
  await assert.rejects(
    h.onboarding.rebuild(PROJECT, "binding_unknown"),
    notFound,
  );
  await assert.rejects(
    h.onboarding.rebuild("project_2", APP.binding_id),
    notFound,
  );
  await assert.rejects(
    h.onboarding.rebuild(PROJECT, "binding_worker"),
    notFound,
  );
  h.bindings = facts([DOCS], []);
  await assert.rejects(h.onboarding.rebuild(PROJECT, APP.binding_id), notFound);
});

test("bindingsChanged sets a changed record to pending before it returns, computes again and drops a removed binding", async (t) => {
  const h = new Harness(t);
  h.resolution = NOTHING;
  await h.compute();
  assert.equal(h.state().status, EnvironmentStatus.None);
  h.bindings = facts(
    [{ ...APP, binding_id: RENAMED_BINDING_ID }],
    [container("app")],
  );
  h.onboarding.bindingsChanged(PROJECT);
  assert.equal(h.state().status, EnvironmentStatus.Pending);
  assert.equal(h.state().binding_id, RENAMED_BINDING_ID);
  await h.until(() => h.state().status === EnvironmentStatus.None);
  assert.deepEqual(
    h.resolveCalls.map((call) => call.bindingId),
    [APP.binding_id, RENAMED_BINDING_ID],
  );
  h.bindings = facts([], []);
  h.onboarding.bindingsChanged(PROJECT);
  assert.deepEqual(h.onboarding.states(PROJECT), []);
});

test("bindingsChanged keeps the record of an unchanged binding and computes it again", async (t) => {
  const h = new Harness(t);
  h.resolution = NOTHING;
  await h.compute();
  h.onboarding.bindingsChanged(PROJECT);
  assert.equal(h.state().status, EnvironmentStatus.None);
  await h.until(() => h.resolveCalls.length === TWO_CALLS);
});

test("a worker binding write that changes the target sets the record to pending", async (t) => {
  const h = new Harness(t);
  h.resolution = NOTHING;
  h.bindings = facts([APP], [server]);
  await h.compute();
  assert.equal(h.state().status, EnvironmentStatus.None);
  assert.equal(h.state().target, EnvironmentTarget.Host);
  const record = Array.from(h.onboarding["records"].values()).find(
    (candidate) => candidate.resource_identity === APP.resource_identity,
  );
  assert.ok(record);
  record.environment_from_agent = true;
  const gate = new Deferred();
  h.resolveGate = gate;
  h.bindings = facts([APP], [container("app")]);
  h.onboarding.bindingsChanged(PROJECT);
  assert.equal(h.state().status, EnvironmentStatus.Pending);
  assert.equal(h.state().binding_id, APP.binding_id);
  assert.equal(record.environment_from_agent, true);
  assert.equal(
    h.onboarding.environmentsClaimable(PROJECT, [APP.resource_identity]),
    false,
  );
  const waiting = new AbortController();
  let slot: string | null = null;
  const answer = h.onboarding
    .slotImage(PROJECT, WORKER_IDENTITY, waiting.signal)
    .then((image) => (slot = image));
  await turn();
  assert.equal(slot, null);
  gate.release();
  await answer;
  assert.equal(slot, SLOT_IMAGE);
  assert.equal(h.state().target, EnvironmentTarget.Image);
  assert.deepEqual(
    h.resolveCalls.map((call) => call.target),
    [EnvironmentTarget.Host, EnvironmentTarget.Image],
  );
});

test("environmentClaimed returns before any dependency of the compute runs", async (t) => {
  const h = new Harness(t);
  h.onboarding.environmentClaimed(PROJECT, APP.resource_identity);
  assert.equal(h.bindingsCalls, NO_CALLS);
  await turn();
  assert.equal(h.bindingsCalls, ONE_CALL);
});

test("environmentsClaimable for a group with no record answers false before any dependency of the compute runs", async (t) => {
  const h = new Harness(t);
  assert.equal(
    h.onboarding.environmentsClaimable(PROJECT, [APP.resource_identity]),
    false,
  );
  assert.equal(h.bindingsCalls, NO_CALLS);
  await turn();
  assert.equal(h.bindingsCalls, ONE_CALL);
  await h.until(() => h.onboarding.states(PROJECT).length === ONE_CALL);
});

test("a trigger during a running compute runs the compute once more and starts no parallel compute", async (t) => {
  const h = new Harness(t);
  const gate = new Deferred();
  h.resolveGate = gate;
  const running = h.compute();
  await h.until(() => h.resolveCalls.length === ONE_CALL);
  h.onboarding.environmentClaimed(PROJECT, APP.resource_identity);
  await turn();
  await turn();
  assert.equal(h.bindingsCalls, ONE_CALL);
  gate.release();
  await running;
  assert.equal(h.bindingsCalls, TWO_CALLS);
});

test("a deferred trigger starts no compute after stop", async (t) => {
  const h = new Harness(t);
  h.onboarding.environmentClaimed(PROJECT, APP.resource_identity);
  await h.onboarding.stop();
  await turn();
  assert.equal(h.bindingsCalls, NO_CALLS);
});

test("environmentsClaimable answers false for a changed ready binding until its computation ends", async (t) => {
  const h = new Harness(t);
  h.existing.add(h.provedOf(h.digest()));
  await h.compute();
  const claimable = () =>
    h.onboarding.environmentsClaimable(PROJECT, [APP.resource_identity]);
  assert.equal(claimable(), true);
  h.bindings = facts(
    [{ ...APP, binding_id: RENAMED_BINDING_ID }],
    [container("app")],
  );
  const gate = new Deferred();
  h.resolveGate = gate;
  h.onboarding.bindingsChanged(PROJECT);
  assert.equal(claimable(), false);
  await turn();
  assert.equal(claimable(), false);
  gate.release();
  await h.until(claimable);
  assert.equal(h.state().status, EnvironmentStatus.Ready);
});

test("start removes the stale runs, computes each binding and collects each path that no binding holds", async (t) => {
  const h = new Harness(t);
  h.resolution = NOTHING;
  const stray = environmentPath(STRAY_IDENTITY);
  h.proofs.write(stray, proofFile("old"));
  h.writeProof(proofFile(h.digest()));
  await h.onboarding.start();
  assert.equal(h.events.at(NO_CALLS), REMOVE_STALE_RUNS);
  assert.deepEqual(
    h.events.filter((event) => event.startsWith("collect")),
    [`collect ${stray} null`],
  );
  assert.deepEqual(h.proofs.paths(), [h.pathOf()]);
  await h.until(() => h.onboarding.states(PROJECT).length === ONE_CALL);
  assert.deepEqual(
    h.resolveCalls.map((call) => call.bindingId),
    [APP.binding_id],
  );
});

test("a binding write during a held read keeps the record pending and computes again with the new binding", async (t) => {
  const h = new Harness(t);
  h.resolution = NOTHING;
  await h.compute();
  const held = new Deferred();
  h.resolveGate = held;
  const running = h.compute();
  await h.until(() => h.resolveCalls.length === TWO_CALLS);
  h.bindings = facts(
    [{ ...APP, binding_id: RENAMED_BINDING_ID }],
    [container("app")],
  );
  h.onboarding.bindingsChanged(PROJECT);
  const rerun = new Deferred();
  h.resolveGate = rerun;
  held.release();
  await h.until(() => h.resolveCalls.length === THREE_CALLS);
  assert.equal(h.state().status, EnvironmentStatus.Pending);
  assert.equal(
    h.onboarding.environmentsClaimable(PROJECT, [APP.resource_identity]),
    false,
  );
  rerun.release();
  await running;
  await h.until(() => h.state().status === EnvironmentStatus.None);
  assert.deepEqual(
    h.resolveCalls.map((call) => call.bindingId).slice(NO_CALLS, THREE_CALLS),
    [APP.binding_id, APP.binding_id, RENAMED_BINDING_ID],
  );
});

test("a binding write during the first read writes no record until the read of the new binding ends", async (t) => {
  const h = new Harness(t);
  h.resolution = NOTHING;
  const held = new Deferred();
  h.resolveGate = held;
  const running = h.compute();
  await h.until(() => h.resolveCalls.length === ONE_CALL);
  h.bindings = facts(
    [{ ...APP, binding_id: RENAMED_BINDING_ID }],
    [container("app")],
  );
  h.onboarding.bindingsChanged(PROJECT);
  const rerun = new Deferred();
  h.resolveGate = rerun;
  held.release();
  await h.until(() => h.resolveCalls.length === TWO_CALLS);
  assert.deepEqual(h.onboarding.states(PROJECT), []);
  rerun.release();
  await running;
  await h.until(() => h.onboarding.states(PROJECT).length === ONE_CALL);
  assert.equal(h.state().binding_id, RENAMED_BINDING_ID);
});

test("a target flip-back during a held read keeps the record pending and computes again at the new target", async (t) => {
  const h = new Harness(t);
  h.resolution = NOTHING;
  await h.compute();
  assert.equal(h.state().target, EnvironmentTarget.Image);
  const held = new Deferred();
  h.resolveGate = held;
  h.bindings = facts([APP], [server]);
  h.onboarding.bindingsChanged(PROJECT);
  await h.until(() => h.resolveCalls.length === TWO_CALLS);
  h.bindings = facts([APP], [container("app")]);
  h.onboarding.bindingsChanged(PROJECT);
  const rerun = new Deferred();
  h.resolveGate = rerun;
  held.release();
  await h.until(() => h.resolveCalls.length === THREE_CALLS);
  assert.equal(h.state().status, EnvironmentStatus.Pending);
  assert.equal(
    h.onboarding.environmentsClaimable(PROJECT, [APP.resource_identity]),
    false,
  );
  rerun.release();
  await h.until(() => h.state().status === EnvironmentStatus.None);
  assert.equal(h.state().target, EnvironmentTarget.Image);
  assert.deepEqual(
    h.resolveCalls.map((call) => call.target).slice(NO_CALLS, THREE_CALLS),
    [EnvironmentTarget.Image, EnvironmentTarget.Host, EnvironmentTarget.Image],
  );
});

test("a binding removal during a held read leaves no record", async (t) => {
  const h = new Harness(t);
  h.resolution = NOTHING;
  await h.compute();
  const held = new Deferred();
  h.resolveGate = held;
  const running = h.compute();
  await h.until(() => h.resolveCalls.length === TWO_CALLS);
  h.bindings = facts([], []);
  h.onboarding.bindingsChanged(PROJECT);
  assert.deepEqual(h.onboarding.states(PROJECT), []);
  held.release();
  await running;
  await h.until(() => !h.onboarding["computing"].size);
  assert.deepEqual(h.onboarding.states(PROJECT), []);
});

test("a binding-set write of another project keeps a held read of this project", async (t) => {
  const h = new Harness(t);
  h.resolution = NOTHING;
  await h.compute();
  const held = new Deferred();
  h.resolveGate = held;
  const running = h.compute();
  await h.until(() => h.resolveCalls.length === TWO_CALLS);
  h.onboarding.bindingsChanged("project_2");
  held.release();
  await running;
  await h.until(() => !h.onboarding["computing"].size);
  assert.equal(h.resolveCalls.length, TWO_CALLS);
  assert.equal(h.state().status, EnvironmentStatus.None);
});

test("a held read discarded by a write computes no more after cancel", async (t) => {
  const h = new Harness(t);
  h.resolution = NOTHING;
  await h.compute();
  const held = new Deferred();
  h.resolveGate = held;
  const running = h.compute();
  await h.until(() => h.resolveCalls.length === TWO_CALLS);
  h.onboarding.bindingsChanged(PROJECT);
  h.onboarding.cancel();
  held.release();
  await running;
  await turn();
  assert.equal(h.resolveCalls.length, TWO_CALLS);
});

const GONE_CACHE = { project_id: PROJECT, resource_identity: STRAY_IDENTITY };

function cacheOf(identity: string) {
  return { project_id: PROJECT, resource_identity: identity };
}

function cacheRemovals(h: Harness): string[] {
  return h.events.filter((event) => event.startsWith("removeCacheVolume"));
}

test("start removes the cache volume of a group that no repository binding holds and keeps the cache volume of a current group", async (t) => {
  const h = new Harness(t);
  h.resolution = NOTHING;
  h.cacheList = [GONE_CACHE, cacheOf(APP.resource_identity)];
  await h.onboarding.start();
  assert.deepEqual(cacheRemovals(h), [
    `removeCacheVolume ${PROJECT} ${STRAY_IDENTITY}`,
  ]);
  assert.deepEqual(h.cacheList, [cacheOf(APP.resource_identity)]);
});

test("a binding-set write that removes a repository binding leads to the removal of the cache volume of its group", async (t) => {
  const h = new Harness(t);
  h.resolution = NOTHING;
  h.cacheList = [cacheOf(APP.resource_identity)];
  await h.compute();
  h.onboarding.bindingsChanged(PROJECT);
  await turn();
  assert.deepEqual(cacheRemovals(h), []);
  h.bindings = facts([], []);
  h.onboarding.bindingsChanged(PROJECT);
  await h.until(() => h.cacheList.length === NO_CALLS);
  assert.deepEqual(cacheRemovals(h), [
    `removeCacheVolume ${PROJECT} ${APP.resource_identity}`,
  ]);
});

test("a failed cache volume removal leaves the volume and the next collection removes it", async (t) => {
  const h = new Harness(t);
  h.resolution = NOTHING;
  h.cacheList = [GONE_CACHE];
  h.cacheRemovalFails = true;
  await h.onboarding.start();
  assert.deepEqual(h.cacheList, [GONE_CACHE]);
  h.cacheRemovalFails = false;
  h.onboarding.bindingsChanged(PROJECT);
  await h.until(() => h.cacheList.length === NO_CALLS);
});

test("a new digest of a current group keeps its cache volume", async (t) => {
  const h = new Harness(t);
  h.cacheList = [cacheOf(APP.resource_identity)];
  h.existing.add(h.provedOf(h.digest()));
  await h.compute();
  h.resolution = {
    ...REPOSITORY,
    document: { ...DOCUMENT, postCreateCommand: "make other" },
  };
  h.onboarding.environmentClaimed(PROJECT, APP.resource_identity);
  await h.until(() => h.events.includes("build"));
  h.buildGate?.release();
  h.proveGate?.release();
  await h.until(() => h.events.some((event) => event.startsWith("collect")));
  await turn();
  assert.deepEqual(cacheRemovals(h), []);
  assert.deepEqual(h.cacheList, [cacheOf(APP.resource_identity)]);
});

test("environmentClaimed returns at once, starts a run for a changed digest and none for an equal digest", async (t) => {
  const h = new Harness(t);
  h.existing.add(h.provedOf(h.digest()));
  await h.compute();
  assert.equal(h.resolveCalls.length, ONE_CALL);
  assert.equal(
    h.onboarding.environmentClaimed(PROJECT, APP.resource_identity),
    undefined,
  );
  await h.until(() => h.resolveCalls.length === TWO_CALLS);
  for (let attempt = 0; attempt < TWO_CALLS * TWO_CALLS; attempt++)
    await turn();
  assert.equal(h.events.includes("build"), false);
  assert.equal(h.state().status, EnvironmentStatus.Ready);
  h.resolution = {
    ...REPOSITORY,
    document: { ...DOCUMENT, postCreateCommand: "make other" },
  };
  h.onboarding.environmentClaimed(PROJECT, APP.resource_identity);
  await h.until(() => h.events.includes("build"));
  assert.equal(h.state().status, EnvironmentStatus.Building);
});

test("a pending group computes again every 60 seconds and a ready group does not", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = new Harness(t);
  pending.resolution = new Error(UNREACHABLE);
  await pending.compute();
  assert.equal(pending.resolveCalls.length, ONE_CALL);
  t.mock.timers.tick(PENDING_RETRY_MS - ONE_CALL);
  await turn();
  assert.equal(pending.resolveCalls.length, ONE_CALL);
  t.mock.timers.tick(ONE_CALL);
  await pending.until(() => pending.resolveCalls.length === TWO_CALLS);
  await turn();
  t.mock.timers.tick(PENDING_RETRY_MS);
  await pending.until(
    () => pending.resolveCalls.length === TWO_CALLS + ONE_CALL,
  );

  const ready = new Harness(t);
  ready.existing.add(ready.provedOf(ready.digest()));
  await ready.compute();
  t.mock.timers.tick(PENDING_RETRY_MS * TWO_CALLS);
  await turn();
  assert.equal(ready.resolveCalls.length, ONE_CALL);
});

test("stop aborts the active run, clears the timer and rejects each slotImage wait", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const waiting = new Harness(t);
  await waiting.compute();
  await waiting.until(() => waiting.events.includes("build"));
  const wait = assert.rejects(
    waiting.onboarding.slotImage(
      PROJECT,
      WORKER_IDENTITY,
      new AbortController().signal,
    ),
  );
  await waiting.onboarding.stop();
  await wait;
  assert.deepEqual(waiting.proofs.digests(waiting.pathOf()), []);
  assert.equal(waiting.state().run_started_at, null);
  await assert.rejects(
    waiting.onboarding.slotImage(
      PROJECT,
      WORKER_IDENTITY,
      new AbortController().signal,
    ),
  );

  const pending = new Harness(t);
  pending.resolution = new Error(UNREACHABLE);
  await pending.compute();
  await pending.onboarding.stop();
  t.mock.timers.tick(PENDING_RETRY_MS * TWO_CALLS);
  await turn();
  assert.equal(pending.resolveCalls.length, ONE_CALL);
});

const UNIVERSAL_IMAGE = "mcr.microsoft.com/devcontainers/base:bookworm";
const REPOSITORY_ADDRESS = "git@github.com:owner/repo.git";
const PACKAGE_JSON = "package.json";
const PACKAGE_LOCK = "package-lock.json";
const WORKFLOW_FILE = `${WORKFLOW_DIRECTORY}/ci.yml`;
const NODE_PACKAGE = '{"engines":{"node":"22"}}';
const ADDED_PACKAGE = '{"engines":{"node":"20"}}';
const WORKFLOW_TEXT = (version: string) =>
  `jobs:\n  test:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${version}\n`;
const BROKEN_DEVCONTAINER = "{";
const UNIVERSAL_FILE = new URL(
  "../../static/environment/universal.json",
  import.meta.url,
);
const REPOSITORY_SERVICE = {
  kind: IdentityKind.Service,
  service: PROJECT_SERVICE_NAME,
} as const;

class FakeRepository {
  files = new Map<string, string>();
  reads: Array<{ commit: string; paths: string[] }> = [];
  lists: Array<{
    commit: string;
    directory: string;
    limit: number;
  }> = [];

  readPaths(): string[] {
    return this.reads.flatMap((read) => read.paths);
  }

  asRepositoryFiles(): RepositoryFiles {
    const unexpected = (): never => {
      throw new Error("Unexpected repository call.");
    };
    return {
      resolveBranchCommit: async () => "c1",
      readFilesAtCommit: async (_address, commit, paths) => {
        this.reads.push({ commit, paths: [...paths] });
        return paths.map((path) => {
          const text = this.files.get(path) ?? null;
          return {
            path,
            state:
              text === null
                ? RepositoryFileState.Absent
                : RepositoryFileState.Present,
            text,
          };
        });
      },
      listFilesAtCommit: async (_address, commit, directory, limit) => {
        this.lists.push({ commit, directory, limit });
        return [...this.files.keys()]
          .filter((path) => posix.dirname(path) === directory)
          .sort()
          .slice(0, limit);
      },
      readObjectIds: unexpected,
      cloneSnapshot: unexpected,
    };
  }
}

function resolvingHarness(
  t: TestContext,
  repository: FakeRepository,
  workers: (name: string) => readonly WorkerBindingFacts[],
) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([{ service: "project", migrations: projectMigrations }]);
  const group = store.transaction((tx) => {
    const project = insertProject(tx, "alpha");
    writeBindingSet(
      tx,
      project.id,
      project.binding_set_version,
      new Map(
        Object.entries(
          bindingSetWriteInputSchema.shape.bindings.parse({
            repo: {
              kind: BindingKind.Repository,
              config: {
                available: true,
                platform: "github",
                address: REPOSITORY_ADDRESS,
                strategy: { base_branch: "main" },
                ssh_credential: "ssh-github.com",
                credential: "github-key",
              },
            },
          }),
        ),
      ),
    );
    const binding = readCurrentBindingSet(tx, project.id).get("repo");
    assert.ok(binding);
    return {
      binding_id: binding.id,
      binding_name: "repo",
      resource_identity: binding.resource_identity,
    };
  });
  const environments = new ProjectEnvironments({
    store,
    repositoryFiles: repository.asRepositoryFiles(),
    identity: REPOSITORY_SERVICE,
    targetOf: () => {
      throw new Error("Unexpected target read.");
    },
    sshAccess: () => ({ address: REPOSITORY_ADDRESS, ssh: {} as never }),
    writeBindings: () => {
      throw new Error("Unexpected binding write.");
    },
  });
  const h = new Harness(t, (bindingId, target, context) =>
    environments.resolveGroup(bindingId, target, context),
  );
  h.bindings = facts([group], workers(group.binding_name));
  h.workerEnvironment = group.binding_name;
  return { h, group };
}

const imageWorkers = (name: string) => [container(name)];
const hostWorkers = () => [server];
const remoteWorkers = () => [remoteWorker];

function textOnlyFiles(
  paths: readonly string[],
  files: Map<string, string>,
): RepositoryFile[] {
  return paths
    .map((path) => ({
      path,
      state: files.has(path)
        ? RepositoryFileState.Present
        : RepositoryFileState.Absent,
      text: files.get(path) ?? null,
    }))
    .sort((first, second) => (first.path < second.path ? -1 : 1));
}

test("an image target without a stored environment or a devcontainer resolves the detected source", async (t) => {
  const repository = new FakeRepository();
  repository.files.set(PACKAGE_JSON, NODE_PACKAGE);
  repository.files.set(PACKAGE_LOCK, "{}");
  const { h, group } = resolvingHarness(t, repository, imageWorkers);
  await h.compute(group);
  assert.equal(h.state(group).source, EnvironmentSource.Detected);
  await h.until(() => h.events.includes("build"));
  const detected = detectEnvironment(
    textOnlyFiles([...DETECTION_PATHS], repository.files) as Parameters<
      typeof detectEnvironment
    >[0],
  );
  assert.ok(detected);
  assert.deepEqual(h.buildInputs[0]?.document, detected.document);
});

test("an image target with a repository devcontainer reads no detection input", async (t) => {
  const repository = new FakeRepository();
  repository.files.set(DEVCONTAINER_FILE, `{"image":"${BASE}"}`);
  repository.files.set(PACKAGE_JSON, NODE_PACKAGE);
  const { h, group } = resolvingHarness(t, repository, imageWorkers);
  await h.compute(group);
  assert.equal(h.state(group).source, EnvironmentSource.Repository);
  assert.deepEqual(repository.readPaths(), [DEVCONTAINER_FILE]);
  assert.equal(repository.lists.length, NO_CALLS);
});

test("an image target keeps the repository source and the reason of a devcontainer that fails to parse", async (t) => {
  const repository = new FakeRepository();
  repository.files.set(DEVCONTAINER_FILE, BROKEN_DEVCONTAINER);
  repository.files.set(PACKAGE_JSON, NODE_PACKAGE);
  const { h, group } = resolvingHarness(t, repository, imageWorkers);
  await h.compute(group);
  const state = h.state(group);
  assert.equal(state.source, EnvironmentSource.Repository);
  assert.match(
    state.reason ?? "",
    /^\.devcontainer\/devcontainer\.json: invalid JSON/,
  );
  assert.equal(state.status, EnvironmentStatus.Pending);
  assert.deepEqual(repository.readPaths(), [DEVCONTAINER_FILE]);
  assert.equal(repository.lists.length, NO_CALLS);
});

test("an image target without a manifest resolves the universal source", async (t) => {
  const repository = new FakeRepository();
  const { h, group } = resolvingHarness(t, repository, imageWorkers);
  await h.compute(group);
  assert.equal(h.state(group).source, EnvironmentSource.Universal);
  await h.until(() => h.events.includes("build"));
  assert.deepEqual(
    h.buildInputs[0]?.document,
    JSON.parse(readFileSync(UNIVERSAL_FILE, "utf8")),
  );
});

test("a host target proves only the checks of a detected source", async (t) => {
  const repository = new FakeRepository();
  repository.files.set("go.mod", "module example.com/app\n\ngo 1.25\n");
  const { h, group } = resolvingHarness(t, repository, hostWorkers);
  await h.compute(group);
  assert.equal(h.state(group).source, EnvironmentSource.Detected);
  await h.until(() => h.proveInputs.length === ONE_CALL);
  assert.deepEqual(h.proveInputs[0]?.checks, ["go version"]);
  assert.deepEqual(h.proveInputs[0]?.setup, []);
  assert.deepEqual(h.events, ["proveOnHost"]);
});

test("a host target ignores the repository devcontainer", async (t) => {
  const repository = new FakeRepository();
  repository.files.set(DEVCONTAINER_FILE, `{"image":"${BASE}"}`);
  const { h, group } = resolvingHarness(t, repository, hostWorkers);
  await h.compute(group);
  assert.equal(h.state(group).source, EnvironmentSource.None);
  assert.ok(!repository.readPaths().includes(DEVCONTAINER_FILE));
});

test("a remote target resolves the detected source and starts no run", async (t) => {
  const repository = new FakeRepository();
  repository.files.set("Cargo.toml", '[package]\nname = "app"\n');
  const { h, group } = resolvingHarness(t, repository, remoteWorkers);
  await h.compute(group);
  assert.equal(h.state(group).source, EnvironmentSource.Detected);
  assert.equal(h.state(group).status, EnvironmentStatus.None);
  assert.deepEqual(h.events, [`wake ${PROJECT}`]);
  const digest = h.state(group).digest;
  assert.ok(digest);
  h.onboarding.environmentFailed({
    project_id: PROJECT,
    execution_id: EXECUTION_ID,
    resource_identities: [group.resource_identity],
    stop: { code: SETUP_FAILED, detail: BOOM },
    digests: { [group.resource_identity]: digest },
  });
  assert.equal(h.state(group).status, EnvironmentStatus.Failed);
});

test("the digest changes with the text of a manifest and of a workflow file", async (t) => {
  const repository = new FakeRepository();
  repository.files.set(PACKAGE_JSON, NODE_PACKAGE);
  repository.files.set(WORKFLOW_FILE, WORKFLOW_TEXT("22"));
  const { h, group } = resolvingHarness(t, repository, remoteWorkers);
  await h.compute(group);
  const first = h.state(group).digest;
  assert.deepEqual(repository.lists, [
    { commit: "c1", directory: WORKFLOW_DIRECTORY, limit: WORKFLOW_FILES_MAX },
  ]);
  repository.files.set(PACKAGE_JSON, ADDED_PACKAGE);
  await h.compute(group);
  const second = h.state(group).digest;
  repository.files.set(WORKFLOW_FILE, WORKFLOW_TEXT("20"));
  await h.compute(group);
  const third = h.state(group).digest;
  assert.ok(first && second && third);
  assert.equal(new Set([first, second, third]).size, THREE_DIGESTS);
});

test("the digest input lists every read file in path order", async (t) => {
  const repository = new FakeRepository();
  repository.files.set(PACKAGE_JSON, NODE_PACKAGE);
  repository.files.set(WORKFLOW_FILE, WORKFLOW_TEXT("22"));
  const { h, group } = resolvingHarness(t, repository, remoteWorkers);
  await h.compute(group);
  const detected = detectEnvironment(
    textOnlyFiles([...DETECTION_PATHS, WORKFLOW_FILE], repository.files),
  );
  assert.ok(detected);
  const files = textOnlyFiles(
    [...DETECTION_PATHS, WORKFLOW_FILE],
    repository.files,
  );
  assert.equal(
    h.state(group).digest,
    environmentDigest({
      resource_identity: group.resource_identity,
      target: EnvironmentTarget.Remote,
      source: EnvironmentSource.Detected,
      document: detected.document,
      files,
      base_image: null,
      slot_image: null,
      secrets: [],
      version: VERSION,
    }),
  );
});

test("the universal environment passes the schema and holds the pinned stacks", () => {
  const document = JSON.parse(readFileSync(UNIVERSAL_FILE, "utf8"));
  assert.ok(environmentSchema.safeParse(document).success);
  assert.equal(document.image, UNIVERSAL_IMAGE);
  const features = document.features as Record<string, { version: string }>;
  for (const name of ["node", "python", "go", "java"])
    assert.ok(
      features[`ghcr.io/devcontainers/features/${name}:1`]?.version,
      name,
    );
  assert.deepEqual(Object.keys(document.containerEnv), [
    "PATH",
    "GOPATH",
    "CARGO_HOME",
  ]);
  assert.deepEqual(document.customizations.kanthord.checks, [
    "node --version",
    "python --version",
    "go version",
    "java -version",
  ]);
  assert.equal(document.updateContentCommand, undefined);
});

const ROOT_SPAN = "project.environment";
const BUILD_SPAN = "environment.build";
const SETUP_SPAN = "environment.setup";
const PROOF_SPAN = "environment.proof";

function rootEndOf(h: Harness): EnvironmentContribution | undefined {
  return h.spans
    .map(({ contribution }) => contribution)
    .find(
      (contribution) =>
        contribution.operation === ROOT_SPAN &&
        contribution.status !== undefined,
    );
}

test(
  "a passed image run records the root, the three steps and the root end in order under one trace",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.open();
    h.proveResults = PASSING_RESULTS;
    await h.compute();
    await h.ended();
    assert.deepEqual(h.recorded(), [
      `${ROOT_SPAN}:start`,
      `${BUILD_SPAN}:${SpanStatus.Ok}`,
      `${SETUP_SPAN}:${SpanStatus.Ok}`,
      `${PROOF_SPAN}:${SpanStatus.Ok}`,
      `${ROOT_SPAN}:${SpanStatus.Ok}`,
    ]);
    const [first] = h.spans;
    assert.ok(first);
    assert.equal(first.trace.project_id, PROJECT);
    assert.match(first.trace.trace_id, /^[0-9a-f]{32}$/);
    assert.match(first.trace.root_span_id, /^[0-9a-f]{16}$/);
    for (const { trace } of h.spans) assert.deepEqual(trace, first.trace);
    assert.deepEqual(first.contribution.attributes, {
      "project.id": PROJECT,
      "project.binding.name": APP_NAME,
      "environment.target": IMAGE,
      "environment.source": REPOSITORY_SOURCE,
      "environment.digest": h.digest(),
    });
  },
);

test(
  "a failed setup records the setup span with setup_failed, no proof span and a root end with Error",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.open();
    h.proveResults = [
      result("setup", "make setup", SETUP_EXIT, { output: "SECRET_OUTPUT" }),
      result("check", "make test", 0),
    ];
    await h.compute();
    await h.ended();
    const setup = h.spanOf(SETUP_SPAN);
    assert.equal(setup?.status, SpanStatus.Error);
    assert.equal(setup?.attributes?.["error.type"], SETUP_FAILED);
    assert.equal(h.spanOf(PROOF_SPAN), undefined);
    const end = rootEndOf(h);
    assert.equal(end?.status, SpanStatus.Error);
    assert.equal(end?.attributes?.["error.type"], SETUP_FAILED);
    assert.ok(!JSON.stringify(h.spans).includes("SECRET_OUTPUT"));
  },
);

test(
  "a failed build records the build span with build_failed and a root end with Error",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.open();
    h.buildResult = {
      outcome: "failed",
      class: "build_failed",
      tail: "SECRET_TAIL",
    };
    await h.compute();
    await h.ended();
    const build = h.spanOf(BUILD_SPAN);
    assert.equal(build?.status, SpanStatus.Error);
    assert.equal(build?.attributes?.["error.type"], BUILD_FAILED);
    assert.equal(h.spanOf(SETUP_SPAN), undefined);
    assert.equal(h.spanOf(PROOF_SPAN), undefined);
    const end = rootEndOf(h);
    assert.equal(end?.status, SpanStatus.Error);
    assert.equal(end?.attributes?.["error.type"], BUILD_FAILED);
    assert.ok(!JSON.stringify(h.spans).includes("SECRET_TAIL"));
  },
);

test(
  "a rejected build records the build span with build_failed",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.open();
    t.mock.method(AbortSignal, "timeout", () =>
      AbortSignal.abort(new Error("deadline")),
    );
    await h.compute();
    await h.ended();
    const build = h.spanOf(BUILD_SPAN);
    assert.equal(build?.status, SpanStatus.Error);
    assert.equal(build?.attributes?.["error.type"], BUILD_FAILED);
  },
);

test(
  "a host run records no build span",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.open();
    h.bindings = facts([APP], []);
    h.resolution = STORED;
    h.proveResults = PASSING_RESULTS;
    await h.compute();
    await h.ended();
    assert.deepEqual(h.recorded(), [
      `${ROOT_SPAN}:start`,
      `${SETUP_SPAN}:${SpanStatus.Ok}`,
      `${PROOF_SPAN}:${SpanStatus.Ok}`,
      `${ROOT_SPAN}:${SpanStatus.Ok}`,
    ]);
    assert.equal(h.spanOf(BUILD_SPAN), undefined);
  },
);

test(
  "a run with an existing tag records no build span",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.open();
    h.existing.add(h.tagOf(h.digest()));
    h.proveResults = PASSING_RESULTS;
    await h.compute();
    await h.ended();
    assert.equal(h.spanOf(BUILD_SPAN), undefined);
    assert.equal(h.recorded().at(-1), `${ROOT_SPAN}:${SpanStatus.Ok}`);
  },
);

test(
  "a cancelled run records the root end with Error and no class",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    await h.compute();
    await h.until(() => h.events.length > NO_CALLS);
    await h.onboarding.stop();
    const end = rootEndOf(h);
    assert.equal(end?.status, SpanStatus.Error);
    assert.equal(end?.attributes?.["error.type"], undefined);
    assert.equal(h.spanOf(BUILD_SPAN), undefined);
  },
);

test(
  "a telemetry that throws changes no status and no proof file",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.open();
    h.telemetryFails = true;
    h.proveResults = PASSING_RESULTS;
    await h.compute();
    await h.ended();
    const file = h.proofOf(h.digest());
    assert.ok(file);
    assert.equal(file.outcome, PASSED);
    assert.equal(h.state().status, EnvironmentStatus.Ready);
    assert.equal(h.spans.length, NO_CALLS);
  },
);

function secretHarness(t: TestContext): Harness {
  const h = new Harness(t);
  h.bindings = facts([SECRET_APP], [container("app")]);
  h.createSecret();
  return h;
}

test(
  "a run writes each secret to a private file before the build and passes only the variable and the path",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = secretHarness(t);
    await h.compute(SECRET_APP);
    await h.until(() => h.buildInputs.length > NO_CALLS);
    const file = h.secretFile();
    assert.equal(readFileSync(file, "utf8"), SECRET_TEXT);
    assert.equal(statSync(file).mode & MODE_MASK, PRIVATE_MODE);
    assert.deepEqual(h.buildInputs[0]?.secrets, [
      { variable: SECRET_VARIABLE, file },
    ]);
    assert.ok(!JSON.stringify(h.buildInputs).includes(SECRET_TEXT));
  },
);

test(
  "the secrets directory is gone after a passed run, a failed build and a cancelled run",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const passed = secretHarness(t);
    passed.open();
    passed.proveResults = PASSING_RESULTS;
    await passed.compute(SECRET_APP);
    await passed.ended();
    assert.equal(passed.state(SECRET_APP).status, EnvironmentStatus.Ready);
    assert.equal(existsSync(passed.secretFile()), false);

    const failed = secretHarness(t);
    failed.openBuild();
    failed.buildResult = {
      outcome: "failed",
      class: "build_failed",
      tail: "x",
    };
    await failed.compute(SECRET_APP);
    await failed.ended();
    assert.equal(failed.state(SECRET_APP).status, EnvironmentStatus.Failed);
    assert.equal(existsSync(failed.secretFile()), false);

    const cancelled = secretHarness(t);
    await cancelled.compute(SECRET_APP);
    await cancelled.until(() => cancelled.buildInputs.length > NO_CALLS);
    assert.equal(existsSync(cancelled.secretFile()), true);
    await cancelled.onboarding.stop();
    assert.equal(existsSync(cancelled.secretFile()), false);
  },
);

test(
  "a rotation of the credential gives the next trigger a new digest and a new run",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = secretHarness(t);
    h.open();
    h.proveResults = PASSING_RESULTS;
    await h.compute(SECRET_APP);
    await h.ended();
    const first = h.state(SECRET_APP).digest;
    assert.equal(h.state(SECRET_APP).status, EnvironmentStatus.Ready);
    h.rotateSecret(1);
    await h.compute(SECRET_APP);
    await h.ended(TWO_CALLS);
    const second = h.state(SECRET_APP).digest;
    assert.notEqual(second, first);
    assert.equal(second, h.digest(SECRET_APP));
    assert.equal(h.buildInputs.length, TWO_CALLS);
  },
);

test(
  "a credential archived after the binding write ends the run with build_failed and a tail without the secret",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = secretHarness(t);
    h.open();
    h.beforeRelease = () => h.archiveSecret();
    await h.compute(SECRET_APP);
    const sum = h.state(SECRET_APP).digest;
    assert.ok(sum);
    await h.ended();
    const file = h.proofOf(sum, SECRET_APP);
    assert.ok(file);
    assert.equal(file.outcome, FAILED);
    assert.equal(file.class, BUILD_FAILED);
    assert.equal(
      file.tail,
      `environment secret ${SECRET_VARIABLE} is unavailable`,
    );
    assert.ok(!file.tail.includes(SECRET_TEXT));
    assert.equal(h.buildInputs.length, NO_CALLS);
    assert.equal(existsSync(h.secretFile()), false);
  },
);

test(
  "a rotation between the digest and the release ends the run with no proof file and computes the group again",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = secretHarness(t);
    h.open();
    h.proveResults = PASSING_RESULTS;
    h.beforeRelease = () => {
      h.beforeRelease = null;
      h.rotateSecret(1);
    };
    const staleDigest = h.digest(SECRET_APP);
    await h.compute(SECRET_APP);
    await h.ended();
    assert.equal(h.proofOf(staleDigest, SECRET_APP), null);
    assert.equal(h.buildInputs.length, NO_CALLS);
    assert.equal(existsSync(h.secretFile()), false);
    await h.until(() => h.state(SECRET_APP).status === EnvironmentStatus.Ready);
    const fresh = h.state(SECRET_APP).digest;
    assert.notEqual(fresh, staleDigest);
    assert.equal(fresh, h.digest(SECRET_APP));
    assert.equal(h.buildInputs.length, ONE_CALL);
  },
);

test(
  "a failed build writes a proof file whose tail holds no secret value",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = secretHarness(t);
    h.openBuild();
    h.buildResult = {
      outcome: "failed",
      class: "build_failed",
      tail: `token=${SECRET_TEXT}`,
    };
    await h.compute(SECRET_APP);
    const sum = h.state(SECRET_APP).digest;
    assert.ok(sum);
    await h.ended();
    const file = h.proofOf(sum, SECRET_APP);
    assert.ok(file);
    assert.equal(file.tail, REDACTED_TAIL);
    assert.ok(!JSON.stringify(h.state(SECRET_APP)).includes(SECRET_TEXT));
  },
);

test(
  "no log line of a run holds a secret value",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = secretHarness(t);
    h.openBuild();
    h.buildError = new Error(`token=${SECRET_TEXT}`);
    await h.compute(SECRET_APP);
    const sum = h.state(SECRET_APP).digest;
    assert.ok(sum);
    await h.ended();
    assert.equal(h.logged(RUN_ENDED).length, ONE_CALL);
    assert.ok(h.lines.length > ONE_CALL);
    for (const line of h.lines) assert.ok(!line.includes(SECRET_TEXT), line);
    const file = h.proofOf(sum, SECRET_APP);
    assert.ok(file);
    assert.equal(file.tail, REDACTED_TAIL);
  },
);

test(
  "the proof container and the slot of a ready group get no secret",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = secretHarness(t);
    h.open();
    h.proveResults = PASSING_RESULTS;
    await h.compute(SECRET_APP);
    await h.ended();
    assert.equal(h.state(SECRET_APP).status, EnvironmentStatus.Ready);
    const slot = await h.onboarding.slotImage(
      PROJECT,
      WORKER_IDENTITY,
      AbortSignal.timeout(TEST_TIMEOUT_MS),
    );
    const seen = JSON.stringify([h.proveInputs, slot, h.events]);
    for (const forbidden of [SECRET_TEXT, "secrets", "--secret"])
      assert.ok(!seen.includes(forbidden), forbidden);
    assert.ok(seen.includes(SECRET_APP.resource_identity));
  },
);

const FAILING_RESULTS = [result("setup", "make setup", 3, { output: BOOM })];

function agentDocument(number: number): Environment {
  return { ...DOCUMENT, postCreateCommand: `make setup ${number}` };
}

async function callTool(
  tools: ToolDefinition[],
  name: string,
  params: object,
): Promise<Record<string, unknown>> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool);
  const answer = await tool.execute(
    "call",
    params as never,
    new AbortController().signal,
    undefined,
    undefined as never,
  );
  const [first] = answer.content as Array<{ text: string }>;
  assert.ok(first);
  return JSON.parse(first.text) as Record<string, unknown>;
}

function writeTool(
  tools: ToolDefinition[],
  environment: object,
): Promise<Record<string, unknown>> {
  return callTool(tools, "environment_write", { environment });
}

async function failedHarness(t: TestContext): Promise<Harness> {
  const h = new Harness(t);
  h.open();
  h.proveResults = FAILING_RESULTS;
  await h.compute();
  await h.ended();
  return h;
}

function startSession(h: Harness, group: RepositoryGroup = APP): Promise<void> {
  const current = Array.from(h.onboarding["records"].values()).find(
    (candidate) => candidate.resource_identity === group.resource_identity,
  );
  assert.ok(current);
  const failure = h.proofOf(h.digest(group), group);
  assert.ok(failure);
  return h.onboarding["startSession"](current, failure);
}

test(
  "a session write answers the proof file of the new digest and runs the new digest once",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = await failedHarness(t);
    const answers: Array<Record<string, unknown>> = [];
    h.script = async (tools) => {
      answers.push(await writeTool(tools, agentDocument(1)));
    };
    await startSession(h);
    assert.deepEqual(answers, [
      {
        outcome: FAILED,
        class: SETUP_FAILED,
        tail: BOOM,
        checks: [],
        attempts_left: ENV_AGENT_ATTEMPT_LIMIT - ONE_CALL,
      },
    ]);
    const tag = h.tagOf(h.digest());
    assert.equal(
      h.proveInputs.filter((input) => "tag" in input && input.tag === tag)
        .length,
      ONE_CALL,
    );
    assert.equal(h.sessionInputs.length, ONE_CALL);
    assert.equal(h.sessionInputs[0]?.failure.class, SETUP_FAILED);
  },
);

test(
  "a session write that passes the proof answers passed, makes the group ready and ends the session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = await failedHarness(t);
    h.proveResults = PASSING_RESULTS;
    const answers: Array<Record<string, unknown>> = [];
    let endsAtAnswer = NO_CALLS;
    h.script = async (tools) => {
      answers.push(await writeTool(tools, agentDocument(1)));
      endsAtAnswer = h.sessionEnds;
    };
    await startSession(h);
    assert.deepEqual(answers, [
      {
        outcome: PASSED,
        class: null,
        tail: "",
        checks: [],
        attempts_left: ENV_AGENT_ATTEMPT_LIMIT - ONE_CALL,
      },
    ]);
    assert.equal(h.state().status, EnvironmentStatus.Ready);
    assert.equal(endsAtAnswer, ONE_CALL);
  },
);

test(
  "a session answers 5 attempts, then attempt_limit with no write and no run, and ends",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = await failedHarness(t);
    const answers: Array<Record<string, unknown>> = [];
    let endsAtFifth = NO_CALLS;
    let runsAtSixth = NO_CALLS;
    h.script = async (tools) => {
      for (let attempt = 1; attempt <= ENV_AGENT_ATTEMPT_LIMIT; attempt++)
        answers.push(await writeTool(tools, agentDocument(attempt)));
      endsAtFifth = h.sessionEnds;
      runsAtSixth = h.proveInputs.length;
      answers.push(await writeTool(tools, agentDocument(NO_CALLS)));
    };
    await startSession(h);
    assert.deepEqual(
      answers.slice(NO_CALLS, ENV_AGENT_ATTEMPT_LIMIT).map((answer) => ({
        outcome: answer.outcome,
        attempts_left: answer.attempts_left,
      })),
      [4, 3, 2, 1, 0].map((attemptsLeft) => ({
        outcome: FAILED,
        attempts_left: attemptsLeft,
      })),
    );
    assert.deepEqual(answers[ENV_AGENT_ATTEMPT_LIMIT], {
      outcome: null,
      reason: "attempt_limit",
      detail: null,
      attempts_left: NO_CALLS,
    });
    assert.equal(endsAtFifth, ONE_CALL);
    assert.equal(h.sessionEnds, TWO_CALLS);
    assert.equal(h.writes.length, ENV_AGENT_ATTEMPT_LIMIT);
    assert.equal(h.proveInputs.length, runsAtSixth);
  },
);

test(
  "a refused document counts as one attempt",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = await failedHarness(t);
    const answers: Array<Record<string, unknown>> = [];
    h.script = async (tools) => {
      answers.push(await writeTool(tools, REFUSED_ENVIRONMENT));
      for (let attempt = 1; attempt < ENV_AGENT_ATTEMPT_LIMIT; attempt++)
        answers.push(await writeTool(tools, agentDocument(attempt)));
      answers.push(await writeTool(tools, agentDocument(NO_CALLS)));
    };
    await startSession(h);
    assert.deepEqual(answers[NO_CALLS], {
      outcome: null,
      reason: "write_refused",
      detail: INVALID_DOCUMENT,
      attempts_left: ENV_AGENT_ATTEMPT_LIMIT - ONE_CALL,
    });
    assert.deepEqual(answers.at(-ONE_CALL), {
      outcome: null,
      reason: "attempt_limit",
      detail: null,
      attempts_left: NO_CALLS,
    });
    assert.equal(answers.length, ENV_AGENT_ATTEMPT_LIMIT + ONE_CALL);
    assert.equal(h.writes.length, ENV_AGENT_ATTEMPT_LIMIT);
    assert.equal(h.sessionEnds, TWO_CALLS);
  },
);

test(
  "probe calls the runner with the tags of the current digest and the checkout",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = await failedHarness(t);
    let answer: Record<string, unknown> = {};
    h.script = async (tools) => {
      answer = await callTool(tools, "probe", { command: "uname -a" });
    };
    await startSession(h);
    const tag = h.tagOf(h.digest());
    assert.deepEqual(h.probes, [
      {
        tags: [tag, `${tag}${BASE_SUFFIX}`],
        checkout: CHECKOUT,
        argv: ["uname", "-a"],
      },
    ]);
    assert.deepEqual(answer, PROBE_ANSWER);
  },
);

test(
  "states answers repairing for the group only while its session runs",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = await failedHarness(t);
    h.bindings = facts([APP, DOCS], [container("app")]);
    await h.compute(DOCS);
    const gate = new Deferred();
    const seen: boolean[] = [];
    h.script = async () => {
      seen.push(h.state().repairing, h.state(DOCS).repairing);
      await gate.promise;
    };
    assert.equal(h.state().repairing, false);
    const running = startSession(h);
    await h.until(() => seen.length > NO_CALLS);
    assert.deepEqual(seen, [true, false]);
    gate.release();
    await running;
    assert.equal(h.state().repairing, false);
    assert.equal(h.state(DOCS).repairing, false);
  },
);

test(
  "a session ends at the 65th tool call and answers tool_limit with no other work",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = await failedHarness(t);
    let answer: Record<string, unknown> = {};
    h.script = async (tools) => {
      for (let call = NO_CALLS; call < ENV_AGENT_TOOL_CALL_LIMIT; call++)
        await callTool(tools, "probe", { command: "uname -a" });
      assert.equal(h.sessionEnds, NO_CALLS);
      answer = await callTool(tools, "probe", { command: "uname -a" });
    };
    await startSession(h);
    assert.deepEqual(answer, { reason: "tool_limit" });
    assert.equal(h.probes.length, ENV_AGENT_TOOL_CALL_LIMIT);
    assert.equal(h.sessionEnds, ONE_CALL);
  },
);

test(
  "a write counts toward the tool call limit",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = await failedHarness(t);
    let answer: Record<string, unknown> = {};
    h.script = async (tools) => {
      for (
        let call = NO_CALLS;
        call < ENV_AGENT_TOOL_CALL_LIMIT - ONE_CALL;
        call++
      )
        await callTool(tools, "probe", { command: "uname -a" });
      await writeTool(tools, REFUSED_ENVIRONMENT);
      answer = await writeTool(tools, agentDocument(ONE_CALL));
    };
    await startSession(h);
    assert.deepEqual(answer, { reason: "tool_limit" });
    assert.equal(h.writes.length, ONE_CALL);
    assert.equal(h.sessionEnds, ONE_CALL);
  },
);

test(
  "a failed session logs session_failed and clears the session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = await failedHarness(t);
    h.script = async () => {
      throw new Error(BOOM);
    };
    await startSession(h);
    assert.equal(h.logged(SESSION_FAILED).length, ONE_CALL);
    assert.equal(h.state().repairing, false);
  },
);

const UNIVERSAL: GroupResolution = { ...REPOSITORY, source: "universal" };
const REPAIR_LIMIT = 3;
const ABORT_ERROR = "AbortError";

function agentHarness(
  t: TestContext,
  resolution: GroupResolution = UNIVERSAL,
): Harness {
  const h = new Harness(t);
  h.resolution = resolution;
  h.agentEnabled = true;
  h.open();
  h.proveResults = FAILING_RESULTS;
  return h;
}

async function provedAgentHarness(
  t: TestContext,
  resolution: GroupResolution = UNIVERSAL,
): Promise<Harness> {
  const h = agentHarness(t, resolution);
  h.existing.add(h.provedOf(h.digest()));
  await h.compute();
  assert.equal(h.state().status, EnvironmentStatus.Ready);
  return h;
}

async function sessionsEnded(h: Harness, count: number): Promise<void> {
  await h.until(
    () =>
      h.sessionInputs.length >= count &&
      h.onboarding.states(PROJECT).every((state) => !state.repairing),
  );
  assert.equal(h.sessionInputs.length, count);
}

async function failRun(
  h: Harness,
  group: RepositoryGroup = APP,
): Promise<void> {
  await h.compute(group);
  await h.ended();
}

test(
  "a first run that fails at the image target with the source universal starts one session after it counts a repair",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = agentHarness(t);
    const repairsInSession: Array<number | undefined> = [];
    h.script = async () => {
      repairsInSession.push(h.proofOf(h.digest())?.repairs);
    };
    await failRun(h);
    await sessionsEnded(h, ONE_CALL);
    assert.deepEqual(repairsInSession, [ONE_CALL]);
    assert.equal(h.sessionInputs[0]?.failure.repairs, ONE_CALL);
    assert.equal(h.state().status, EnvironmentStatus.Failed);
    assert.equal(h.state().repairs, ONE_CALL);
  },
);

test(
  "the source detected starts a session and the source repository starts none",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const detected = agentHarness(t, { ...REPOSITORY, source: "detected" });
    await failRun(detected);
    await sessionsEnded(detected, ONE_CALL);
    const repository = agentHarness(t, REPOSITORY);
    await failRun(repository);
    assert.equal(repository.sessionInputs.length, NO_CALLS);
    assert.equal(repository.state().repairs, NO_REPAIRS);
  },
);

test(
  "the source none starts a session at an execution failure",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = agentHarness(t, NOTHING);
    await h.compute();
    h.onboarding.environmentFailed(failureInput(h, { digests: digestsOf(h) }));
    await sessionsEnded(h, ONE_CALL);
  },
);

function digestsOf(h: Harness): Record<string, string> {
  const sum = h.state().digest;
  assert.ok(sum);
  return { [APP.resource_identity]: sum };
}

test(
  "the source stored starts no session for a human write and one after a session write",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const human = agentHarness(t, STORED);
    await failRun(human);
    assert.equal(human.sessionInputs.length, NO_CALLS);
    const h = agentHarness(t);
    h.script = async (tools) => {
      await writeTool(tools, agentDocument(ONE_CALL));
    };
    await failRun(h);
    await sessionsEnded(h, ONE_CALL);
    h.script = async () => {};
    h.onboarding.environmentFailed(failureInput(h));
    await sessionsEnded(h, TWO_CALLS);
    h.bindings = facts(
      [{ ...APP, binding_id: RENAMED_BINDING_ID }],
      [container("app")],
    );
    h.onboarding.bindingsChanged(PROJECT);
    await h.compute();
    h.onboarding.environmentFailed(failureInput(h));
    assert.equal(h.sessionInputs.length, TWO_CALLS);
  },
);

test(
  "a failed run after a target change during the run starts no session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.resolution = UNIVERSAL;
    h.agentEnabled = true;
    h.proveResults = FAILING_RESULTS;
    h.openBuild();
    await h.compute();
    await h.until(() => h.state().run_started_at !== null);
    h.bindings = facts([APP], [server]);
    h.onboarding.bindingsChanged(PROJECT);
    h.openProve();
    await h.ended();
    await turn();
    await turn();
    assert.equal(h.sessionInputs.length, NO_CALLS);
    assert.equal(h.state().repairs, NO_REPAIRS);
  },
);

test(
  "a failed run after a binding rename during the run starts one session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = new Harness(t);
    h.resolution = UNIVERSAL;
    h.agentEnabled = true;
    h.proveResults = FAILING_RESULTS;
    h.openBuild();
    await h.compute();
    await h.until(() => h.state().run_started_at !== null);
    h.bindings = facts(
      [{ ...APP, binding_id: RENAMED_BINDING_ID }],
      [container("app")],
    );
    h.onboarding.bindingsChanged(PROJECT);
    h.openProve();
    await sessionsEnded(h, ONE_CALL);
  },
);

async function heldAfterWrite(h: Harness, bindings: BindingFacts) {
  await h.compute();
  const digests = digestsOf(h);
  const held = new Deferred();
  h.resolveGate = held;
  h.bindings = bindings;
  h.onboarding.bindingsChanged(PROJECT);
  await h.until(() => h.resolveCalls.length === TWO_CALLS);
  assert.equal(h.state().status, EnvironmentStatus.Pending);
  return { digests, held };
}

test(
  "an execution failure after a binding rename during a held read starts one session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = agentHarness(t, NOTHING);
    const { digests, held } = await heldAfterWrite(
      h,
      facts([{ ...APP, binding_id: RENAMED_BINDING_ID }], [container("app")]),
    );
    h.onboarding.environmentFailed(failureInput(h, { digests }));
    await sessionsEnded(h, ONE_CALL);
    held.release();
  },
);

test(
  "an execution failure after a target change during a held read starts no session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = agentHarness(t, NOTHING);
    const { digests, held } = await heldAfterWrite(h, facts([APP], [server]));
    h.onboarding.environmentFailed(failureInput(h, { digests }));
    await turn();
    await turn();
    assert.equal(h.sessionInputs.length, NO_CALLS);
    held.release();
  },
);

test(
  "a failure at the host target starts no session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = agentHarness(t);
    h.bindings = facts([APP], []);
    await failRun(h);
    assert.equal(h.state().status, EnvironmentStatus.Failed);
    assert.equal(h.sessionInputs.length, NO_CALLS);
  },
);

test(
  "an execution failure at the remote target starts no session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = agentHarness(t);
    h.bindings = facts([APP], [remoteWorker]);
    await h.compute();
    h.onboarding.environmentFailed(failureInput(h, { digests: digestsOf(h) }));
    assert.equal(h.state().target, EnvironmentTarget.Remote);
    assert.equal(h.sessionInputs.length, NO_CALLS);
  },
);

test(
  "a failure with no enabled env@1 starts no session and counts no repair",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = agentHarness(t);
    h.agentEnabled = false;
    await failRun(h);
    assert.equal(h.sessionInputs.length, NO_CALLS);
    assert.equal(h.state().repairs, NO_REPAIRS);
    assert.equal(h.state().status, EnvironmentStatus.Failed);
  },
);

test(
  "environmentFailed at the image target starts a session and counts a repair",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = await provedAgentHarness(t);
    h.onboarding.environmentFailed(failureInput(h));
    await sessionsEnded(h, ONE_CALL);
    assert.equal(h.proofOf(h.digest())?.repairs, ONE_CALL);
    assert.equal(h.sessionInputs[0]?.failure.repairs, ONE_CALL);
  },
);

test(
  "four failures of one digest start 3 sessions",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = await provedAgentHarness(t);
    for (let failure = 1; failure <= REPAIR_LIMIT + ONE_CALL; failure++) {
      h.onboarding.environmentFailed(failureInput(h));
      await sessionsEnded(h, Math.min(failure, REPAIR_LIMIT));
    }
    assert.equal(h.proofOf(h.digest())?.repairs, REPAIR_LIMIT);
    assert.equal(h.sessionInputs.length, REPAIR_LIMIT);
  },
);

test(
  "a failed run of an active session starts no second session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = agentHarness(t);
    h.script = async (tools) => {
      const answer = await writeTool(tools, agentDocument(ONE_CALL));
      assert.equal(answer.outcome, FAILED);
    };
    await failRun(h);
    await sessionsEnded(h, ONE_CALL);
    await h.ended(TWO_CALLS);
    assert.equal(h.sessionInputs.length, ONE_CALL);
  },
);

test(
  "a session that ends after 5 failed attempts starts no new session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = agentHarness(t);
    h.script = async (tools) => {
      for (let attempt = 1; attempt <= ENV_AGENT_ATTEMPT_LIMIT; attempt++)
        await writeTool(tools, agentDocument(attempt));
    };
    await failRun(h);
    await sessionsEnded(h, ONE_CALL);
    await h.ended(ENV_AGENT_ATTEMPT_LIMIT + ONE_CALL);
    assert.equal(h.sessionInputs.length, ONE_CALL);
  },
);

test(
  "a failure while a session of another group runs starts a session for this group",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = agentHarness(t);
    h.bindings = facts([APP, DOCS], [container("app"), container("docs")]);
    const gate = new Deferred();
    h.script = () => gate.promise;
    await failRun(h);
    await h.until(() => h.state().repairing);
    await h.compute(DOCS);
    await h.ended(TWO_CALLS);
    await h.until(() => h.state(DOCS).repairing);
    assert.equal(h.sessionInputs.length, TWO_CALLS);
    gate.release();
    await sessionsEnded(h, TWO_CALLS);
  },
);

test(
  "a rebuild removes the proof file and the next failure starts a session with one repair",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = agentHarness(t);
    const repairsInSession: Array<number | undefined> = [];
    h.script = async () => {
      repairsInSession.push(h.proofOf(h.digest())?.repairs);
    };
    await failRun(h);
    await sessionsEnded(h, ONE_CALL);
    await h.onboarding.rebuild(PROJECT, APP.binding_id);
    await sessionsEnded(h, TWO_CALLS);
    assert.deepEqual(repairsInSession, [ONE_CALL, ONE_CALL]);
  },
);

test(
  "the stop of the component aborts each running session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const h = agentHarness(t);
    const gate = new Deferred();
    h.script = () => gate.promise;
    await failRun(h);
    await h.until(() => h.state().repairing);
    const signal = h.sessionInputs[0]?.context.signal;
    assert.ok(signal);
    assert.equal(signal.aborted, false);
    await h.onboarding.stop();
    assert.equal(signal.aborted, true);
    assert.equal((signal.reason as Error).name, ABORT_ERROR);
    gate.release();
    await sessionsEnded(h, ONE_CALL);
  },
);

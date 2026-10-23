import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import pino from "pino";
import type { Environment } from "../kernel/devcontainer.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { temporary } from "../kernel/test-support.ts";
import { ProjectErrorCode, WorkerPlacement } from "./contract.ts";
import type { GroupResolution } from "./environment.ts";
import {
  BASE_SUFFIX,
  EnvironmentStatus,
  EnvironmentTarget,
  PROVED_SUFFIX,
  ProofFiles,
  environmentDigest,
  environmentPath,
  environmentStateSchema,
  environmentTagOf,
  type CommandResult,
  type EnvironmentRuntime,
  type ImageBuildInput,
  type ImageBuildResult,
  type ProofFile,
  type ProofInput,
} from "./environment-state.ts";
import {
  Onboarding,
  statusOf,
  targetOf,
  type BindingFacts,
  type EnvironmentFailedInput,
  type GroupRecord,
  type RepositoryGroup,
  type WorkerBindingFacts,
} from "./onboarding.ts";

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
const SETUP_FAILED = "setup_failed";
const NO_SPACE = "no space";
const BOOM = "boom";
const MAKE_SETUP = "make setup";
const MAKE_TEST = "make test";
const PROVE = "prove";
const APP_NAME = "app";
const IMAGE = "image";
const EXECUTION_ID = "execution_1";
const DEADLINE_TAIL = "the run deadline of 30 minutes passed";
const TWO_CALLS = 2;
const RUNTIME_NAME = "podman";
const UNTIL_ATTEMPTS = 1000;
const SETUP_EXIT = 3;
const COMMAND_ABSENT_EXIT = 127;
const RUN_DEADLINE_MS = 1800000;
const RUN_STARTED = "project.onboarding.run_started";
const RUN_ENDED = "project.onboarding.run_ended";
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

class Harness {
  bindings: BindingFacts = facts([APP], [container("app")]);
  workerEnvironment: string | null = "app";
  resolution: GroupResolution | Error = REPOSITORY;
  resolveCalls: Array<{ bindingId: string; target: EnvironmentTarget }> = [];
  resolveGate: Deferred | null = null;
  buildGate: Deferred | null = new Deferred();
  proveGate: Deferred | null = new Deferred();
  buildResult: ImageBuildResult = { outcome: "built" };
  proveResults: CommandResult[] = [];
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
  clock = 0;
  readonly proofs: ProofFiles;
  readonly onboarding: Onboarding;

  constructor(t: TestContext) {
    this.proofs = new ProofFiles(temporary(t));
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
        return this.buildResult;
      },
      prove: async (
        input: ProofInput & { tag: string },
        signal: AbortSignal,
      ) => {
        this.events.push("prove");
        this.proveInputs.push(input);
        await hold(this.proveGate, signal);
        return this.proveResults;
      },
      proveOnHost: async (input: ProofInput, signal: AbortSignal) => {
        this.events.push("proveOnHost");
        this.proveInputs.push(input);
        await hold(this.proveGate, signal);
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
    } as unknown as EnvironmentRuntime;
    this.onboarding = new Onboarding({
      bindingsOf: (projectId) =>
        projectId === PROJECT ? this.bindings : facts([], []),
      workerEnvironmentOf: () => this.workerEnvironment,
      projectIds: () => [PROJECT],
      resolveGroup: async (bindingId, target) => {
        this.resolveCalls.push({ bindingId, target });
        await this.resolveGate?.promise;
        if (this.resolution instanceof Error) throw this.resolution;
        return this.resolution;
      },
      runtime,
      proofs: this.proofs,
      slotImage: SLOT_IMAGE,
      version: VERSION,
      wake: (projectId) => {
        this.events.push(`wake ${projectId}`);
        this.woken.push(projectId);
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
    });
    t.after(() => this.onboarding.stop());
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
      version: VERSION,
    });
  }
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
    digest: "d",
    tag: "t",
    proof: null,
    proved: false,
    read_succeeded: true,
    step: null,
    run_started_at: null,
    step_started_at: null,
    reason: null,
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
    });
    assert.deepEqual(h.proveInputs[0], {
      run_id: "run_1",
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

test("environmentFailed closes the gate of a group with no digests entry", async (t) => {
  const h = await readyHarness(t);
  h.onboarding.environmentFailed(failureInput(h, { digests: {} }));
  assert.equal(h.state().status, EnvironmentStatus.Failed);

  const none = new Harness(t);
  none.bindings = facts([APP], []);
  none.resolution = NOTHING;
  await none.compute();
  assert.equal(none.state().status, EnvironmentStatus.None);
  none.onboarding.environmentFailed(failureInput(none, { digests: {} }));
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

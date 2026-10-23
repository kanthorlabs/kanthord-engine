import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import pino from "pino";
import type { Environment } from "../kernel/devcontainer.ts";
import { temporary } from "../kernel/test-support.ts";
import { WorkerPlacement } from "./contract.ts";
import type { GroupResolution } from "./environment.ts";
import {
  EnvironmentStatus,
  EnvironmentTarget,
  PROVED_SUFFIX,
  ProofFiles,
  environmentDigest,
  environmentPath,
  environmentStateSchema,
  environmentTagOf,
  type EnvironmentRuntime,
  type ProofFile,
} from "./environment-state.ts";
import {
  Onboarding,
  statusOf,
  targetOf,
  type BindingFacts,
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
const TWO_CALLS = 2;
const DOCUMENT: Environment = {
  image: BASE,
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
  images = new Map<string, string>([
    [BASE, "sha256:base"],
    [SLOT_IMAGE, "sha256:slot"],
  ]);
  existing = new Set<string>();
  calls: string[] = [];
  woken: string[] = [];
  readonly proofs: ProofFiles;
  readonly onboarding: Onboarding;

  constructor(t: TestContext) {
    this.proofs = new ProofFiles(temporary(t));
    const runtime = {
      runtimeName: "fake",
      imageId: async (reference: string) => {
        this.calls.push(`imageId ${reference}`);
        return this.images.get(reference) ?? null;
      },
      pullImage: async (reference: string) => {
        this.calls.push(`pullImage ${reference}`);
        this.images.set(reference, "sha256:pulled");
      },
      imageExists: async (tag: string) => this.existing.has(tag),
    } as unknown as EnvironmentRuntime;
    this.onboarding = new Onboarding({
      bindingsOf: () => this.bindings,
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
      wake: (projectId) => this.woken.push(projectId),
      environmentReady: () => undefined,
      logger: pino({ level: "silent" }),
      now: () => 1,
      runId: () => "run_1",
    });
    t.after(() => this.onboarding.close());
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

  writeProof(file: ProofFile, group: RepositoryGroup = APP): void {
    this.proofs.write(environmentPath(group.resource_identity), file);
  }

  async digestOf(group: RepositoryGroup = APP): Promise<string> {
    await this.compute(group);
    const sum = this.onboarding.environmentDigestOf(
      PROJECT,
      group.resource_identity,
    );
    assert.ok(sum !== null);
    return sum;
  }
}

function record(override: Partial<GroupRecord> = {}): GroupRecord {
  return {
    project_id: PROJECT,
    binding_id: APP.binding_id,
    binding_name: APP.binding_name,
    resource_identity: APP.resource_identity,
    target: EnvironmentTarget.Image,
    source: "repository",
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

test("a stored environment answers stored at every target", async (t) => {
  const h = new Harness(t);
  h.resolution = STORED;
  for (const workers of [[container("app")], [], [remoteWorker]]) {
    h.bindings = facts([APP], workers);
    await h.compute();
    assert.equal(h.state().source, STORED_SOURCE);
  }
});

test("a repository devcontainer answers repository at image and none at host", async (t) => {
  const h = new Harness(t);
  await h.compute();
  assert.equal(h.state().source, REPOSITORY_SOURCE);
  assert.deepEqual(h.resolveCalls, [
    { bindingId: APP.binding_id, target: EnvironmentTarget.Image },
  ]);
  h.bindings = facts([APP], []);
  h.resolution = NOTHING;
  await h.compute();
  assert.equal(h.state().source, NONE_SOURCE);
  assert.equal(h.resolveCalls[1]?.target, EnvironmentTarget.Host);
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
  const sum = await h.digestOf();
  h.existing.add(`${h.tagOf(sum)}${PROVED_SUFFIX}`);
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
  const sum = await h.digestOf();
  h.existing.add(`${h.tagOf(sum)}${PROVED_SUFFIX}`);
  await h.compute();
  assert.equal(h.state().status, EnvironmentStatus.Ready);
  assert.equal(h.state().failure, null);

  const host = new Harness(t);
  host.bindings = facts([APP], []);
  host.resolution = STORED;
  const hostSum = await host.digestOf();
  assert.equal(host.state().status, EnvironmentStatus.Proving);
  host.writeProof(proofFile(hostSum));
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

test("status rule 6: the queued step is building without the tag and proving with it", async (t) => {
  const h = new Harness(t);
  const sum = await h.digestOf();
  assert.equal(h.state().status, EnvironmentStatus.Building);
  assert.equal(h.state().run_started_at, null);
  assert.equal(h.state().step_started_at, null);
  h.existing.add(h.tagOf(sum));
  await h.compute();
  assert.equal(h.state().status, EnvironmentStatus.Proving);

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
  const sum = await h.digestOf();
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
  const sum = await h.digestOf();
  h.existing.add(`${h.tagOf(sum)}${PROVED_SUFFIX}`);
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
  const sum = await h.digestOf(DOCS);
  await h.compute(APP);
  h.writeProof(
    proofFile(sum, {
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
  assert.equal(docs.digest, sum);
  assert.equal(docs.reason, null);
  assert.equal(docs.repairing, false);
  assert.deepEqual(h.onboarding.states("project_2"), []);
});

test("environmentsClaimable answers true for none and ready only", async (t) => {
  const identities = [APP.resource_identity];
  const none = new Harness(t);
  none.resolution = NOTHING;
  await none.compute();
  assert.equal(
    none.onboarding.environmentsClaimable(PROJECT, identities),
    true,
  );

  const ready = new Harness(t);
  const sum = await ready.digestOf();
  ready.existing.add(`${ready.tagOf(sum)}${PROVED_SUFFIX}`);
  await ready.compute();
  assert.equal(
    ready.onboarding.environmentsClaimable(PROJECT, identities),
    true,
  );

  const building = new Harness(t);
  await building.compute();
  assert.equal(building.state().status, EnvironmentStatus.Building);
  assert.equal(
    building.onboarding.environmentsClaimable(PROJECT, identities),
    false,
  );

  const proving = new Harness(t);
  const provingSum = await proving.digestOf();
  proving.existing.add(proving.tagOf(provingSum));
  await proving.compute();
  assert.equal(proving.state().status, EnvironmentStatus.Proving);
  assert.equal(
    proving.onboarding.environmentsClaimable(PROJECT, identities),
    false,
  );

  const failed = new Harness(t);
  const failedSum = await failed.digestOf();
  failed.writeProof(
    proofFile(failedSum, { outcome: "failed", class: "setup_failed" }),
  );
  await failed.compute();
  assert.equal(failed.state().status, EnvironmentStatus.Failed);
  assert.equal(
    failed.onboarding.environmentsClaimable(PROJECT, identities),
    false,
  );

  const pending = new Harness(t);
  pending.resolution = new Error("down");
  await pending.compute();
  assert.equal(
    pending.onboarding.environmentsClaimable(PROJECT, identities),
    false,
  );

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

test("a group that becomes claimable wakes the project once", async (t) => {
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
  const sum = await h.digestOf();
  assert.equal(h.state().digest, sum);
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
    const sum = await ready.digestOf();
    ready.existing.add(`${ready.tagOf(sum)}${PROVED_SUFFIX}`);
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
    const sum = await h.digestOf();
    assert.equal(h.state().status, EnvironmentStatus.Building);
    let settled = false;
    const answer = h.onboarding
      .slotImage(PROJECT, WORKER_IDENTITY, AbortSignal.timeout(TEST_TIMEOUT_MS))
      .finally(() => (settled = true));
    await turn();
    await turn();
    assert.equal(settled, false);
    h.existing.add(`${h.tagOf(sum)}${PROVED_SUFFIX}`);
    await h.compute();
    assert.equal(await answer, h.tagOf(sum));
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

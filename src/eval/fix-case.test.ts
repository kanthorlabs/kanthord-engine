import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentErrorCode, agentOperations } from "../agent/contract.ts";
import { EnablementState } from "../agent/enablements.ts";
import {
  BindingKind,
  EnvironmentStatus,
  projectOperations,
} from "../project/contract.ts";
import { temporary } from "../kernel/test-support.ts";
import { loadSuite } from "./case.ts";
import { CredentialSourceKind } from "./credential.ts";
import { schedulerOperations } from "../scheduler/contract.ts";
import { RegistrationActivity, workerOperations } from "../worker/contract.ts";
import { EVAL_CONFIGURATION } from "./run.ts";
import { openSandbox, prepareCase, type Sandbox } from "./sandbox.ts";

const SUBJECT = "ops@1";
const KEY = "sk-eval-test-key";
const FIX_AGENT = "swe@1";
const FIXTURE_KEY = "p";
const CODER_BINDING = "coder";
const REPOSITORY_BINDING = "repo";
const PENDING_THRESHOLD_MS = 600000;
const REVIEWER_BINDING = "reviewer";
const REGISTRATION_LIMIT = 100;
const SINGLE_REGISTRATION = 1;
const SINGLE_JOB = 1;
const NATIVE_PLATFORM = "anthropic";
const NATIVE_CREDENTIAL = "native-credential";
const NO_JOBS = 0;
const TEST_TIMEOUT_MS = 60000;
const FAR_EXPIRY_MS = 86400000;
const SUITE_AGENTS = ["ops@1", "re@1"];

async function preparedSandbox(t: TestContext, id: string) {
  const sandbox = await openSandbox(t, {
    subject: SUBJECT,
    credential: { kind: CredentialSourceKind.Key, key: KEY },
    configuration: EVAL_CONFIGURATION,
  });
  const [loaded] = loadSuite(SUBJECT, [id]);
  assert.ok(loaded);
  const { ids, failed } = await prepareCase(sandbox, loaded);
  assert.equal(failed, null);
  return { sandbox, projectId: ids[FIXTURE_KEY]!.project_id };
}

async function bindingId(sandbox: Sandbox, projectId: string, name: string) {
  const bindings = await sandbox.call(projectOperations["binding.list"], {
    params: { project_id: projectId },
    query: {},
    body: null,
  });
  const binding = bindings.items.find(
    (item) => item.name === name && item.removed_at === null,
  );
  assert.ok(binding);
  return binding.id;
}

async function environmentOf(sandbox: Sandbox, projectId: string) {
  const listed = await sandbox.call(projectOperations["environment.list"], {
    params: { project_id: projectId },
    query: {},
    body: null,
  });
  const state = listed.items.find(
    (item) => item.binding_name === REPOSITORY_BINDING,
  );
  assert.ok(state);
  return state;
}

test(
  "case-fix-agent_invalid leaves swe@1 enabled with an invalid default configuration",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { sandbox, projectId } = await preparedSandbox(
      t,
      "case-fix-agent_invalid",
    );
    const enablement = await sandbox.call(agentOperations["enablement.get"], {
      params: { agent_name: FIX_AGENT },
      query: {},
      body: null,
    });
    assert.equal(enablement.state, EnablementState.Enabled);
    const view = await sandbox.call(
      projectOperations["agentConfiguration.get"],
      {
        params: {
          project_id: projectId,
          binding_id: await bindingId(sandbox, projectId, CODER_BINDING),
          agent_name: FIX_AGENT,
        },
        query: {},
        body: null,
      },
    );
    assert.equal(view.valid, false);
    assert.deepEqual(view.issues, [
      {
        path: ["reasoning_effort"],
        code: AgentErrorCode.ReasoningUnsupported,
      },
    ]);
  },
);

test(
  "case-fix-environment_failed seeds a failed environment state with a failure",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { sandbox, projectId } = await preparedSandbox(
      t,
      "case-fix-environment_failed",
    );
    const state = await environmentOf(sandbox, projectId);
    assert.equal(state.status, EnvironmentStatus.Failed);
    assert.notEqual(state.failure, null);
  },
);

test(
  "case-fix-environment_pending seeds a pending environment state with an old reason",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { sandbox, projectId } = await preparedSandbox(
      t,
      "case-fix-environment_pending",
    );
    const state = await environmentOf(sandbox, projectId);
    assert.equal(state.status, EnvironmentStatus.Pending);
    assert.ok(state.reason);
    assert.ok(state.reason_started_at !== null);
    assert.ok(Date.now() - state.reason_started_at > PENDING_THRESHOLD_MS);
  },
);

async function registrationsOf(sandbox: Sandbox, projectId: string) {
  const listed = await sandbox.call(workerOperations["registration.list"], {
    params: {},
    query: { project_id: projectId, limit: REGISTRATION_LIMIT },
    body: null,
  });
  return listed.items;
}

async function queuedJobs(sandbox: Sandbox, projectId: string) {
  const queue = await sandbox.call(schedulerOperations.queueList, {
    params: { project_id: projectId },
    query: {},
    body: null,
  });
  return queue.items;
}

async function workerBindings(sandbox: Sandbox, projectId: string) {
  const bindings = await sandbox.call(projectOperations["binding.list"], {
    params: { project_id: projectId },
    query: {},
    body: null,
  });
  return bindings.items
    .filter(
      (item) => item.kind === BindingKind.Worker && item.removed_at === null,
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function instancesOf(sandbox: Sandbox) {
  const listed = await sandbox.call(workerOperations["instance.list"], {
    params: {},
    query: { limit: REGISTRATION_LIMIT },
    body: null,
  });
  return listed.items;
}

const CODER_CONFIG = { worker: "coder@1", worker_instances: ["eval-coder-1"] };
const REVIEWER_CONFIG = {
  worker: "reviewer@1",
  worker_instances: ["eval-reviewer-1"],
};

test(
  "a plain fixture project binds coder and reviewer with a live idle registration each",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { sandbox, projectId } = await preparedSandbox(t, "status-all-clear");
    const workers = await workerBindings(sandbox, projectId);
    assert.deepEqual(
      workers.map((worker) => [worker.name, worker.config]),
      [
        [CODER_BINDING, CODER_CONFIG],
        [REVIEWER_BINDING, REVIEWER_CONFIG],
      ],
    );
    const instances = await instancesOf(sandbox);
    assert.deepEqual(
      instances.map((instance) => [instance.name, instance.worker]),
      [
        ["eval-coder-1", "coder@1"],
        ["eval-reviewer-1", "reviewer@1"],
      ],
    );
    for (const instance of instances)
      assert.notEqual(instance.connection, null);
    const registrations = await registrationsOf(sandbox, projectId);
    assert.equal(registrations.length, workers.length);
    for (const worker of workers) {
      const serving = registrations.filter(
        (item) => item.resource_identity === worker.resource_identity,
      );
      assert.equal(serving.length, SINGLE_REGISTRATION);
      assert.equal(serving[0]?.activity, RegistrationActivity.Idle);
      assert.equal(serving[0]?.draining, false);
    }
    const jobs = await queuedJobs(sandbox, projectId);
    assert.notEqual(jobs.length, NO_JOBS);
    for (const job of jobs) assert.equal(job.project_id, projectId);
  },
);

test(
  "case-fix-no_taker stops serving coder and leaves one aged job",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { sandbox, projectId } = await preparedSandbox(
      t,
      "case-fix-no_taker",
    );
    const workers = await workerBindings(sandbox, projectId);
    const coder = workers.find((worker) => worker.name === CODER_BINDING);
    const reviewer = workers.find((worker) => worker.name === REVIEWER_BINDING);
    assert.ok(coder && reviewer);
    assert.deepEqual(coder.config, {
      worker: "coder@1",
      worker_instances: [],
    });
    assert.deepEqual(reviewer.config, REVIEWER_CONFIG);
    const registrations = await registrationsOf(sandbox, projectId);
    assert.deepEqual(
      registrations.map((item) => item.resource_identity),
      [reviewer.resource_identity],
    );
    assert.equal((await queuedJobs(sandbox, projectId)).length, SINGLE_JOB);
  },
);

test(
  "case-fix-agent_invalid prepares without a failure",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const sandbox = await openSandbox(t, {
      subject: SUBJECT,
      credential: { kind: CredentialSourceKind.Key, key: KEY },
      configuration: EVAL_CONFIGURATION,
    });
    const [loaded] = loadSuite(SUBJECT, ["case-fix-agent_invalid"]);
    assert.ok(loaded);
    const { failed } = await prepareCase(sandbox, loaded);
    assert.equal(failed, null);
  },
);

test(
  "case-fix-request_rejected prepares on the native credential",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const sandbox = await openSandbox(t, {
      subject: SUBJECT,
      credential: { kind: CredentialSourceKind.Key, key: KEY },
      configuration: EVAL_CONFIGURATION,
    });
    const [loaded] = loadSuite(SUBJECT, ["case-fix-request_rejected"]);
    assert.ok(loaded);
    const { failed } = await prepareCase(sandbox, loaded);
    assert.equal(failed, null);
    assert.equal(sandbox.native.platform, NATIVE_PLATFORM);
    const enablement = await sandbox.call(agentOperations["enablement.get"], {
      params: { agent_name: FIX_AGENT },
      query: {},
      body: null,
    });
    assert.deepEqual(
      enablement.agent_providers.map((item) => item.credential),
      [NATIVE_CREDENTIAL],
    );
  },
);

function credentialSources(t: TestContext) {
  const path = join(temporary(t), "auth.json");
  writeFileSync(
    path,
    JSON.stringify({
      anthropic: {
        type: "oauth",
        access: "eval-access-value",
        refresh: "eval-refresh-value",
        expires: Date.now() + FAR_EXPIRY_MS,
      },
    }),
  );
  return [
    { kind: CredentialSourceKind.AuthFile, path },
    { kind: CredentialSourceKind.Key, key: KEY },
  ] as const;
}

for (const agent of SUITE_AGENTS)
  for (const loaded of loadSuite(agent, []))
    test(
      `${agent} ${loaded.id} prepares with the subscription source and with the key source`,
      { timeout: TEST_TIMEOUT_MS * 2 },
      async (t) => {
        for (const credential of credentialSources(t)) {
          const sandbox = await openSandbox(t, {
            subject: agent,
            credential,
            configuration: EVAL_CONFIGURATION,
          });
          const { failed } = await prepareCase(sandbox, loaded);
          assert.equal(
            failed,
            null,
            `${credential.kind}: ${failed?.score.checks[0]?.detail ?? ""}`,
          );
        }
      },
    );

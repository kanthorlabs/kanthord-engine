import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { AgentErrorCode, agentOperations } from "../agent/contract.ts";
import { EnablementState } from "../agent/enablements.ts";
import { EnvironmentStatus, projectOperations } from "../project/contract.ts";
import { loadSuite } from "./case.ts";
import { EVAL_CONFIGURATION } from "./run.ts";
import { openSandbox, prepareCase, type Sandbox } from "./sandbox.ts";

const SUBJECT = "ops@1";
const KEY = "sk-eval-test-key";
const FIX_AGENT = "swe@1";
const FIXTURE_KEY = "p";
const CODER_BINDING = "coder";
const REPOSITORY_BINDING = "repo";
const PENDING_THRESHOLD_MS = 600000;
const TEST_TIMEOUT_MS = 60000;

async function preparedSandbox(t: TestContext, id: string) {
  const sandbox = await openSandbox(t, {
    subject: SUBJECT,
    key: KEY,
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

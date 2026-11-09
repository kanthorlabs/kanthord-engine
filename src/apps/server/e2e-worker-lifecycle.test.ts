import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import {
  hostEnvironment,
  overrideEnvironment,
} from "../../kernel/test-support.ts";
import { NodeState } from "../../mission/contract.ts";
import { startTestSshd } from "../../repository/sshd-test-support.ts";
import { ClaimState, type ExecutionRecord } from "../../scheduler/contract.ts";
import type { registrationRecordSchema } from "../../worker/contract.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  scriptedModelRuntime,
  scriptedProvider,
} from "../../worker/unit/test-support.ts";
import { until } from "./cli-test-support.ts";
import { inProcessWorker } from "./test-support.ts";
import { fixture } from "./worker-host-test-support.ts";

type Setup = Awaited<ReturnType<typeof fixture>>;
type Registration = typeof registrationRecordSchema._output;

const SCENARIO_TIMEOUT = 300000;
const WAIT_TIMEOUT_MS = 60000;
const SINGLE_ITEM = 1;
const TWO_ITEMS = 2;
const FIRST_INDEX = 0;
const HELLO = "hello";
const HELLO_FILE = "hello.txt";

const within = (t: TestContext) =>
  AbortSignal.any([t.signal, AbortSignal.timeout(WAIT_TIMEOUT_MS)]);

const executionsOf = async (setup: Setup) =>
  (
    await setup.read<{ items: ExecutionRecord[] }>([
      "scheduler",
      "execution",
      "list",
      setup.project_id,
      "--node",
      setup.node_id,
    ])
  ).items;

const registrationsOf = async (setup: Setup) =>
  (
    await setup.read<{ items: Registration[] }>([
      "worker",
      "registration",
      "list",
      "--project",
      setup.project_id,
    ])
  ).items;

const nodeStateOf = async (setup: Setup) =>
  (
    await setup.read<{ state: NodeState }>([
      "mission",
      "node",
      "get",
      setup.node_id,
    ])
  ).state;

test(
  "E09.18 a worker restarts with the correct secret after a refused setup and claims the next execution of the node",
  { timeout: SCENARIO_TIMEOUT },
  async (t) => {
    const setup = await fixture(t, await startTestSshd(t));
    const wrongSecret = await setup.machine("general-b");

    overrideEnvironment(t, { TMPDIR: hostEnvironment().TMPDIR });
    const refused = await inProcessWorker(t, {
      endpoint: setup.fixture.endpoint,
      token: setup.auth.token,
      client_secret: wrongSecret.client_secret,
      modelRuntimeFactory: scriptedModelRuntime(scriptedProvider([])),
      repositoryTransport: setup.transport,
    });
    const released = await until(
      () => executionsOf(setup),
      (items) => items.some((item) => item.claim_state === ClaimState.Finished),
      within(t),
    );
    assert.equal(released.length, SINGLE_ITEM);
    assert.equal(await nodeStateOf(setup), NodeState.Available);
    const pulling = await registrationsOf(setup);
    assert.equal(pulling.length, SINGLE_ITEM);
    assert.equal(pulling[FIRST_INDEX]!.registered, true);

    await refused.worker.stop();
    await refused.running;
    assert.deepEqual(await registrationsOf(setup), []);
    const afterStop = await executionsOf(setup);
    assert.equal(afterStop.length, SINGLE_ITEM);
    assert.equal(afterStop[FIRST_INDEX]!.claim_state, ClaimState.Finished);
    assert.equal(await nodeStateOf(setup), NodeState.Available);

    const provider = scriptedProvider([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: `printf ${HELLO} > ${HELLO_FILE}` }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);
    overrideEnvironment(t, { TMPDIR: hostEnvironment().TMPDIR });
    await inProcessWorker(t, {
      endpoint: setup.fixture.endpoint,
      ...setup.auth,
      modelRuntimeFactory: scriptedModelRuntime(provider),
      repositoryTransport: setup.transport,
    });
    const claims = await until(
      () => executionsOf(setup),
      (items) =>
        items.length === TWO_ITEMS &&
        items.every((item) => item.claim_state === ClaimState.Finished),
      within(t),
    );
    const second = claims.find(
      (item) => item.execution_id !== released[FIRST_INDEX]!.execution_id,
    )!;
    assert.equal(second.stop, null);
    assert.ok(provider.calls.length);
    const branch = `refs/heads/kanthord/${setup.node_id}`;
    assert.equal(
      await simpleGit(setup.bare).show([`${branch}:${HELLO_FILE}`]),
      HELLO,
    );
    const registered = await registrationsOf(setup);
    assert.equal(registered.length, SINGLE_ITEM);
    assert.equal(registered[FIRST_INDEX]!.registered, true);
    assert.notEqual(
      registered[FIRST_INDEX]!.runtime_identity,
      pulling[FIRST_INDEX]!.runtime_identity,
    );
    assert.equal(await nodeStateOf(setup), NodeState.Waiting);
  },
);

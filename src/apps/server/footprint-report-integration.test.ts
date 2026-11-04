import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { httpClient } from "../../gateway/client.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { stopAfter, temporary } from "../../kernel/test-support.ts";
import { directories } from "../../kernel/xdg.ts";
import { llmOperations } from "../../llm/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import { InstancePlacement, workerOperations } from "../../worker/contract.ts";
import { sessionRootOf } from "../../worker/unit/index.ts";
import { Worker } from "../worker/index.ts";
import { completed, until } from "./cli-test-support.ts";
import {
  COVERING_WORKER_BINDINGS,
  enableCoveringAgents,
  gatewayFixture,
  humanCaller,
  provisionRepositoryCredentials,
} from "./test-support.ts";

const TEST_TIMEOUT_MS = 60000;
const INSTANCE = "laptop";
const CREDENTIAL = "anthro-1";
const PROVIDER_KEY = "footprint-provider-key";
const WORKERS_DIRECTORY = "workers";
const FAST_HEARTBEAT_MS = 50;
const SLOW_INTERVAL_MS = 3600000;
const NO_ORDERS = 0;
const ONE_ORDER = 1;
const CONFIGURATION = {
  agent_provider: "default",
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "off",
} as const;

async function boundInstance(t: TestContext) {
  const fixture = await gatewayFixture(t, {
    repositoryConnector: { gitLsRemote: async () => {} },
  });
  const call = humanCaller(fixture);
  const empty = { params: {}, query: {} };
  await call(llmOperations.create, {
    ...empty,
    body: {
      name: CREDENTIAL,
      platform: "anthropic",
      metadata: null,
      secret: { key: PROVIDER_KEY },
    },
  });
  await enableCoveringAgents(
    { KANTHORD_ENDPOINT: fixture.endpoint, KANTHORD_TOKEN: fixture.token },
    {
      platform: "anthropic",
      credential: CREDENTIAL,
      configuration: CONFIGURATION,
    },
  );
  await provisionRepositoryCredentials(fixture);
  const instance = await call(workerOperations["instance.create"], {
    ...empty,
    body: {
      name: INSTANCE,
      worker: "coder@1",
      placement: InstancePlacement.Worker,
      endpoint: fixture.endpoint,
    },
  });
  assert.ok(instance.instance_configuration);
  await call(llmOperations.create, {
    ...empty,
    body: {
      name: CREDENTIAL,
      platform: "anthropic",
      metadata: null,
      holders: [INSTANCE],
      secret: { key: PROVIDER_KEY },
    },
  });
  const project = await call(projectOperations.create, {
    ...empty,
    body: { name: "footprint-report" },
  });
  await call(projectOperations["bindingSet.write"], {
    params: { project_id: project.id },
    query: {},
    body: {
      version: 1,
      bindings: {
        ...COVERING_WORKER_BINDINGS,
        general: {
          kind: "worker",
          config: {
            worker: "coder@1",
            worker_instances: [INSTANCE],
            entries: [{ agent: "swe@1", ...CONFIGURATION }],
          },
        },
      },
    } as never,
  });
  const root = temporary(t);
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    KANTHORD_WORKER_CONFIG: instance.instance_configuration,
  };
  const session = (executionId: string) => {
    const directory = join(
      sessionRootOf(join(directories(env).data, WORKERS_DIRECTORY, INSTANCE)),
      "execution",
      executionId,
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "a.jsonl"), "{}\n");
    return directory;
  };
  const start = () => {
    const unit = new Worker({
      env,
      connectionName: "host-a",
      heartbeatIntervalMs: FAST_HEARTBEAT_MS,
      renewalIntervalMs: SLOW_INTERVAL_MS,
      log: () => {},
    });
    const run = unit.run();
    stopAfter(t, async () => {
      await unit.stop();
      await run;
    });
    return { unit, run };
  };
  const registered = () =>
    fixture.store.database
      .prepare(
        "SELECT id FROM worker_registration WHERE instance_id = ? AND ended_at IS NULL",
      )
      .get(instance.id);
  const deleteSession = async (executionId: string) =>
    completed(
      await httpClient(workerOperations, fixture.endpoint, fixture.token)[
        "instance.session.delete"
      ]({
        params: { instance_name: INSTANCE },
        query: {},
        body: {
          cleanup_id: createIdentity("cleanup"),
          execution_ids: [executionId],
        },
      }),
    );
  const orders = () => fixture.worker.instances.footprintOrdersOf(instance.id);
  return { fixture, session, start, registered, deleteSession, orders };
}

test(
  "a worker placement instance reads a session order after the work version change, runs it and reports",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const f = await boundInstance(t);
    f.start();
    await until(async () => f.registered(), Boolean, t.signal);
    const executionId = createIdentity("execution");
    const directory = f.session(executionId);
    const version = f.fixture.worker.instances.workVersionOf(INSTANCE);
    assert.deepEqual(await f.deleteSession(executionId), { queued: true });
    assert.ok(f.fixture.worker.instances.workVersionOf(INSTANCE) > version);
    await until(
      async () => !existsSync(directory) && f.orders().length === NO_ORDERS,
      Boolean,
      t.signal,
    );
  },
);

test(
  "an order queued while the unit is down reaches the unit after its restart",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const f = await boundInstance(t);
    const first = f.start();
    await until(async () => f.registered(), Boolean, t.signal);
    await first.unit.stop();
    await first.run;
    const executionId = createIdentity("execution");
    const directory = f.session(executionId);
    await f.deleteSession(executionId);
    assert.equal(f.orders().length, ONE_ORDER);
    f.start();
    await until(
      async () => !existsSync(directory) && f.orders().length === NO_ORDERS,
      Boolean,
      t.signal,
    );
  },
);

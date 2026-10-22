import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { httpClient } from "../../gateway/client.ts";
import { CancellationContext, type Context } from "../../kernel/context.ts";
import {
  ResourceFailureReason,
  ResourceStatus,
  type ResourceObserver,
} from "../../kernel/health.ts";
import { temporary } from "../../kernel/test-support.ts";
import { Connection, llmOperations } from "../../llm/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { Worker } from "../worker/index.ts";
import { completed } from "./cli-support.ts";
import { gatewayFixture } from "./test-support.ts";

const INSTANCE = "laptop";
const CREDENTIAL_NAME = "team-openai";
const PLATFORM = "openai";
const CAPABILITY = "model-list read";
const BAD_KEY = "bad-key";
const GOOD_KEY = "good-key";
const MODEL_ID = "gpt-5";
const FIRST_REVISION = 1;
const NEXT_REVISION = FIRST_REVISION + 1;
const FAST_HEARTBEAT_MS = 50;
const SLOW_INTERVAL_MS = 3600000;
const POLL_MS = 20;

async function until<T>(
  read: () => Promise<T | undefined | false>,
  signal: AbortSignal,
) {
  for (;;) {
    const value = await read();
    if (value) return value;
    await delay(POLL_MS, undefined, { signal });
  }
}

test("a live worker instance checks its own bad key and the instance page answers unhealthy with the report time", async (t) => {
  const f = await gatewayFixture(t);
  const worker = httpClient(workerOperations, f.endpoint, f.token);
  const llm = httpClient(llmOperations, f.endpoint, f.token);
  const created = completed(
    await worker["instance.create"]({
      params: {},
      query: {},
      body: { name: INSTANCE, worker: "coder@1", endpoint: f.endpoint },
    }),
  );
  assert.ok(created.instance_configuration);
  completed(
    await llm.create(
      {
        params: {},
        query: {},
        body: {
          name: CREDENTIAL_NAME,
          platform: PLATFORM,
          metadata: null,
          secret: { key: BAD_KEY },
          holders: [INSTANCE],
        },
      },
      { idempotencyKey: "idempotency_key_01ARZ3NDEKTSV4RRFFQ69G5FB1" },
    ),
  );
  const checked: string[] = [];
  const providers = {
    [PLATFORM]: {
      check: async (
        secret: unknown,
        _metadata: unknown,
        _context: Context,
        observe?: ResourceObserver,
      ) => {
        const { key } = secret as { key: string };
        checked.push(key);
        if (key === GOOD_KEY)
          return {
            connection: Connection.Ok,
            models: [{ id: MODEL_ID, owned_by: null, created: null }],
          };
        observe?.("status=401", ResourceFailureReason.Unauthorized);
        return { connection: Connection.Unauthorized, models: null };
      },
    },
  };
  const root = temporary(t);
  const instance = new Worker({
    env: {
      HOME: root,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_DATA_HOME: `${root}/data`,
      XDG_STATE_HOME: `${root}/state`,
      KANTHORD_WORKER_CONFIG: created.instance_configuration,
    },
    connectionName: "host-a",
    heartbeatIntervalMs: FAST_HEARTBEAT_MS,
    renewalIntervalMs: SLOW_INTERVAL_MS,
    llmProviders: providers,
    log: () => {},
  });
  const context = new CancellationContext();
  const running = instance.run(context);
  t.after(async () => {
    context.cancel();
    await running;
  });
  const copyOf = async () => {
    const answer = completed(
      await worker["instance.get"]({
        params: { instance_name: INSTANCE },
        query: {},
        body: null,
      }),
    );
    return answer.credentials.find(({ name }) => name === CREDENTIAL_NAME);
  };
  const started = Date.now();
  const unhealthy = await until(async () => {
    const copy = await copyOf();
    return copy?.health.reported_at !== null && copy;
  }, t.signal);
  assert.deepEqual(unhealthy!.health, {
    status: ResourceStatus.Unhealthy,
    capability: CAPABILITY,
    failure_reason: ResourceFailureReason.Unauthorized,
    models: null,
    reported_at: unhealthy!.health.reported_at,
  });
  assert.ok(unhealthy!.health.reported_at! >= started);
  assert.equal(unhealthy!.revision, FIRST_REVISION);
  completed(
    await llm.rotate(
      {
        params: { credential_name: CREDENTIAL_NAME },
        query: { holder: INSTANCE },
        body: { expected_revision: FIRST_REVISION, secret: { key: GOOD_KEY } },
      },
      { idempotencyKey: "idempotency_key_01ARZ3NDEKTSV4RRFFQ69G5FB2" },
    ),
  );
  const healthy = await until(async () => {
    const copy = await copyOf();
    return copy?.health.status === ResourceStatus.Healthy && copy;
  }, t.signal);
  assert.equal(healthy!.revision, NEXT_REVISION);
  assert.deepEqual(healthy!.health.models, [
    { id: MODEL_ID, owned_by: null, created: null },
  ]);
  assert.deepEqual(checked, [BAD_KEY, GOOD_KEY]);
  const text = JSON.stringify([f.logs, unhealthy, healthy]);
  assert.equal(text.includes(BAD_KEY), false);
  assert.equal(text.includes(GOOD_KEY), false);
});

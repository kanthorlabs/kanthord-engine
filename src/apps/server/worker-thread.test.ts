import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MessageChannel, Worker } from "node:worker_threads";
import { test } from "node:test";
import pino from "pino";
import { servePort } from "../../gateway/index.ts";
import { LogDestination } from "../../kernel/log.ts";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import { workerOperations } from "../../worker/contract.ts";
import { threadDataSchema } from "../worker/thread-data.ts";
import { until } from "./cli-support.ts";
import {
  FAKE_SSH_IDENTITY,
  gatewayFixture,
  humanCaller,
  provisionRepositoryCredentials,
  provisionWorkerProject,
} from "./test-support.ts";

const CLIENT_SECRET_BYTES = 32;
const DATA_KEYS = ["client_secret", "log", "port"];
const SINGLE_INSTANCE = 1;
const RESOURCE_IDENTITY = "worker:kanthord:general";
const FINISHED_MESSAGE = "Request finished";

test("the worker data of a thread holds a port, a client secret and a log destination only", () => {
  const { port1, port2 } = new MessageChannel();
  try {
    const data = {
      port: port1,
      client_secret: randomBytes(CLIENT_SECRET_BYTES).toString("base64"),
      log: LogDestination.File,
    };
    assert.deepEqual(Object.keys(threadDataSchema.shape).sort(), DATA_KEYS);
    assert.ok(threadDataSchema.safeParse(data).success);
    assert.ok(!threadDataSchema.safeParse({ ...data, env: {} }).success);
    assert.ok(!threadDataSchema.safeParse({ ...data, port: {} }).success);
    assert.ok(!threadDataSchema.safeParse({ ...data, log: "x" }).success);
  } finally {
    port1.close();
    port2.close();
  }
});

test("a worker thread registers its worker unit through the port and the invocation chain", async (t) => {
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
    },
  });
  await provisionRepositoryCredentials(fixture);
  const project = await provisionWorkerProject(fixture, "thread", {
    general: SINGLE_INSTANCE,
  });
  await project.pause();
  const token = await fixture.machineToken(project.id, "general", "slot");
  const records: Record<string, unknown>[] = [];
  const logger = pino(
    { level: "info" },
    { write: (line) => records.push(JSON.parse(line)) },
  );
  const { port1, port2 } = new MessageChannel();
  servePort(port1, fixture.invocation, () => token, logger);
  const root = temporary(t);
  const data = {
    port: port2,
    client_secret: randomBytes(CLIENT_SECRET_BYTES).toString("base64"),
    log: LogDestination.StandardError,
  };
  assert.deepEqual(Object.keys(data).sort(), DATA_KEYS);
  const env = {
    PATH: hostEnvironment().PATH,
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const thread = new Worker(new URL("../worker/thread.ts", import.meta.url), {
    workerData: data,
    transferList: [port2],
    env,
  });
  t.after(async () => {
    await thread.terminate();
    port1.close();
  });
  const listInstances = humanCaller(fixture);
  const page = await until(
    () =>
      listInstances(workerOperations["instance.list"], {
        params: {},
        query: { project_id: project.id },
        body: null,
      }),
    (candidate) => candidate.items.length === SINGLE_INSTANCE,
  );
  assert.equal(page.items[0]?.resource_identity, RESOURCE_IDENTITY);
  const registered = records.filter(
    (record) =>
      record.msg === FINISHED_MESSAGE &&
      record.route === workerOperations.register.path,
  );
  assert.equal(registered.length, SINGLE_INSTANCE);
});

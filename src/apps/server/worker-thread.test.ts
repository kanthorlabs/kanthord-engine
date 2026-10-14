import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { MessageChannel, Worker } from "node:worker_threads";
import { test } from "node:test";
import { build } from "esbuild";
import pino from "pino";
import { servePort } from "../../gateway/index.ts";
import { LogDestination } from "../../kernel/log.ts";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import { directories } from "../../kernel/xdg.ts";
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
const DIRECTORY_VARIABLES = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
];

function threadEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: hostEnvironment().PATH,
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
    XDG_CACHE_HOME: `${root}/cache`,
  };
}

function threadData(port: MessageChannel["port2"]) {
  return {
    port,
    client_secret: randomBytes(CLIENT_SECRET_BYTES).toString("base64"),
    log: LogDestination.File,
  };
}

function startThread(
  data: ReturnType<typeof threadData>,
  env: NodeJS.ProcessEnv,
): Worker {
  return new Worker(new URL("../worker/thread.ts", import.meta.url), {
    workerData: data,
    transferList: [data.port],
    env,
  });
}

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
    assert.ok(
      !threadDataSchema.safeParse({
        ...data,
        log: LogDestination.StandardError,
      }).success,
    );
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
  const data = threadData(port2);
  assert.deepEqual(Object.keys(data).sort(), DATA_KEYS);
  const env = threadEnvironment(root);
  const thread = startThread(data, env);
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
  assert.ok(existsSync(`${directories(env).state}/kanthord.log`));
});

test("a worker thread refuses to start without an absolute directory variable", async (t) => {
  for (const name of DIRECTORY_VARIABLES)
    for (const value of [undefined, "relative/path"]) {
      const { port1, port2 } = new MessageChannel();
      const env = threadEnvironment(temporary(t));
      if (value === undefined) delete env[name];
      else env[name] = value;
      const thread = startThread(threadData(port2), env);
      const [error] = await once(thread, "error");
      assert.match(String(error.message), new RegExp(name), name);
      port1.close();
    }
});

test("a worker thread exits by itself after its run ends", async (t) => {
  const { port1, port2 } = new MessageChannel();
  const thread = startThread(
    threadData(port2),
    threadEnvironment(temporary(t)),
  );
  t.after(() => thread.terminate());
  port1.close();
  const [error] = await once(thread, "error");
  assert.match(String(error.message), /cannot read the server package version/);
  await once(thread, "exit");
});

test("the release bundle of the worker thread starts as an eval worker", async (t) => {
  const bundle = await build({
    entryPoints: [new URL("../worker/thread.ts", import.meta.url).pathname],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    write: false,
    logLevel: "silent",
    banner: {
      js: "const __kanthord_import_meta_url=require('node:url').pathToFileURL(__filename).href;",
    },
    define: { "import.meta.url": "__kanthord_import_meta_url" },
  });
  const { port1, port2 } = new MessageChannel();
  const thread = new Worker(bundle.outputFiles[0]!.text, {
    eval: true,
    workerData: threadData(port2),
    transferList: [port2],
    env: threadEnvironment(temporary(t)),
  });
  t.after(() => thread.terminate());
  port1.close();
  const [error] = await once(thread, "error");
  assert.match(String(error.message), /package\.json|package version/);
  await once(thread, "exit");
});

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { MessageChannel, Worker } from "node:worker_threads";
import { test } from "node:test";
import { build } from "esbuild";
import pino from "pino";
import { servePort } from "../../gateway/index.ts";
import { LogDestination } from "../../kernel/log.ts";
import {
  hostEnvironment,
  requirePiTools,
  temporary,
} from "../../kernel/test-support.ts";
import { directories } from "../../kernel/xdg.ts";
import { BindingEntryState, workerOperations } from "../../worker/contract.ts";
import {
  entryPorts,
  threadDataSchema,
  type ThreadEntry,
  ThreadMessageKind,
} from "../worker/thread-data.ts";
import { until } from "./cli-test-support.ts";
import {
  gatewayFixture,
  humanCaller,
  provisionRepositoryCredentials,
  provisionWorkerProject,
} from "./test-support.ts";

const CLIENT_SECRET_BYTES = 32;
const DATA_KEYS = ["entries", "log"];
const ENTRY_KEYS = ["client_id", "client_secret", "port", "state"];
const TWO_INSTANCES = 2;
const SINGLE_INSTANCE = 1;
const NO_INSTANCES = 0;
const THREAD_EXIT_LIMIT_MS = 3000;
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

function entryOf(
  port: MessageChannel["port2"] | null,
  clientId = "client_identity_a",
  state: BindingEntryState = BindingEntryState.Serving,
): ThreadEntry {
  return {
    client_id: clientId,
    port,
    client_secret: randomBytes(CLIENT_SECRET_BYTES).toString("base64"),
    state,
  };
}

function threadData(...entries: ThreadEntry[]) {
  return { entries, log: LogDestination.File };
}

function startThread(
  data: ReturnType<typeof threadData>,
  env: NodeJS.ProcessEnv,
): Worker {
  return new Worker(new URL("../worker/thread.ts", import.meta.url), {
    workerData: data,
    transferList: entryPorts(data.entries),
    env,
  });
}

test("the worker data of a thread holds an entry list and a log destination only", () => {
  const { port1, port2 } = new MessageChannel();
  try {
    const data = threadData(entryOf(port1));
    assert.deepEqual(Object.keys(threadDataSchema.shape).sort(), DATA_KEYS);
    assert.deepEqual(Object.keys(data.entries[0]!).sort(), ENTRY_KEYS);
    assert.ok(threadDataSchema.safeParse(data).success);
    assert.ok(threadDataSchema.safeParse(threadData()).success);
    assert.ok(!threadDataSchema.safeParse({ ...data, env: {} }).success);
    assert.ok(
      !threadDataSchema.safeParse({
        ...data,
        entries: [{ ...data.entries[0], port: {} }],
      }).success,
    );
    assert.ok(
      !threadDataSchema.safeParse({
        ...data,
        entries: [{ ...data.entries[0], state: "serving-now" }],
      }).success,
    );
    assert.ok(!threadDataSchema.safeParse({ ...data, log: "x" }).success);
    assert.ok(
      threadDataSchema.safeParse({
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
  requirePiTools();
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
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
  const data = threadData(entryOf(port2));
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
      listInstances(workerOperations["registration.list"], {
        params: {},
        query: { project_id: project.id },
        body: null,
      }),
    (candidate) => candidate.items.length === SINGLE_INSTANCE,
    t.signal,
  );
  assert.equal(page.items[0]?.resource_identity, RESOURCE_IDENTITY);
  const registered = records.filter(
    (record) =>
      record.msg === FINISHED_MESSAGE &&
      record.route === workerOperations.register.path,
  );
  assert.equal(registered.length, SINGLE_INSTANCE);
  const logFile = `${directories(env).state}/kanthord.log`;
  assert.ok(await until(() => existsSync(logFile), Boolean, t.signal));
});

test("a worker thread refuses to start without an absolute directory variable", async (t) => {
  for (const name of DIRECTORY_VARIABLES)
    for (const value of [undefined, "relative/path"]) {
      const { port1, port2 } = new MessageChannel();
      const env = threadEnvironment(temporary(t));
      if (value === undefined) delete env[name];
      else env[name] = value;
      const thread = startThread(threadData(entryOf(port2)), env);
      const [error] = await once(thread, "error");
      assert.deepEqual(error.fields, [["variables", name]], name);
      port1.close();
    }
});

test("a worker thread exits by itself after its run ends", async (t) => {
  requirePiTools();
  const { port1, port2 } = new MessageChannel();
  const thread = startThread(
    threadData(entryOf(port2)),
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
  const root = realpathSync(temporary(t));
  const cwd = join(root, "release", "bundle");
  mkdirSync(cwd, { recursive: true });
  const previous = process.cwd();
  process.chdir(cwd);
  t.after(() => process.chdir(previous));
  const { port1, port2 } = new MessageChannel();
  const thread = new Worker(bundle.outputFiles[0]!.text, {
    eval: true,
    workerData: threadData(entryOf(port2)),
    transferList: [port2],
    env: threadEnvironment(temporary(t)),
  });
  t.after(() => thread.terminate());
  port1.close();
  const [error] = await once(thread, "error");
  assert.equal(
    String(error.message),
    `ENOENT: no such file or directory, open '${join(root, "package.json")}'`,
  );
  await once(thread, "exit");
});

test("a thread instance gets two entries, registers both and drains one after a new entry list", async (t) => {
  requirePiTools();
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
    },
  });
  await provisionRepositoryCredentials(fixture);
  const project = await provisionWorkerProject(fixture, "thread-pair", {
    general: SINGLE_INSTANCE,
    reviewer: SINGLE_INSTANCE,
  });
  await project.pause();
  const logger = pino({ level: "silent" });
  const served = new Map<string, MessageChannel>();
  const entryFor = async (binding: string, clientId: string) => {
    const channel = new MessageChannel();
    const token = await fixture.machineToken(project.id, binding, "slot");
    servePort(channel.port1, fixture.invocation, () => token, logger);
    served.set(clientId, channel);
    return entryOf(channel.port2, clientId);
  };
  const general = await entryFor("general", "client_identity_general");
  const reviewer = await entryFor("reviewer", "client_identity_reviewer");
  const thread = startThread(
    threadData(general, reviewer),
    threadEnvironment(temporary(t)),
  );
  t.after(async () => {
    await thread.terminate();
    for (const channel of served.values()) channel.port1.close();
  });
  const list = humanCaller(fixture);
  const registrations = () =>
    list(workerOperations["registration.list"], {
      params: {},
      query: { project_id: project.id },
      body: null,
    });
  const both = await until(
    registrations,
    (candidate) => candidate.items.length === TWO_INSTANCES,
    t.signal,
  );
  assert.deepEqual(both.items.map((item) => item.resource_identity).sort(), [
    "worker:kanthord:general",
    "worker:kanthord:reviewer",
  ]);
  thread.postMessage({
    kind: ThreadMessageKind.Bindings,
    entries: [
      { ...general, port: null },
      { ...reviewer, port: null, state: BindingEntryState.Draining },
    ],
  });
  const remaining = await until(
    registrations,
    (candidate) => candidate.items.length === SINGLE_INSTANCE,
    t.signal,
  );
  assert.equal(remaining.items[0]?.resource_identity, RESOURCE_IDENTITY);
});

test("a worker thread exits after a stop that follows a drain and a resume of its entry", async (t) => {
  requirePiTools();
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
    },
  });
  await provisionRepositoryCredentials(fixture);
  const project = await provisionWorkerProject(fixture, "thread-resume", {
    general: SINGLE_INSTANCE,
  });
  await project.pause();
  const logger = pino({ level: "silent" });
  const token = await fixture.machineToken(project.id, "general", "slot");
  const channels: MessageChannel[] = [];
  const served = () => {
    const channel = new MessageChannel();
    servePort(channel.port1, fixture.invocation, () => token, logger);
    channels.push(channel);
    return channel.port2;
  };
  const entry = entryOf(served(), "client_identity_general");
  const thread = startThread(
    threadData(entry),
    threadEnvironment(temporary(t)),
  );
  t.after(async () => {
    await thread.terminate();
    for (const channel of channels) channel.port1.close();
  });
  const list = humanCaller(fixture);
  const registrations = () =>
    list(workerOperations["registration.list"], {
      params: {},
      query: { project_id: project.id },
      body: null,
    });
  await until(
    registrations,
    (candidate) => candidate.items.length === SINGLE_INSTANCE,
    t.signal,
  );
  thread.postMessage({
    kind: ThreadMessageKind.Bindings,
    entries: [{ ...entry, port: null, state: BindingEntryState.Draining }],
  });
  await until(
    registrations,
    (candidate) => candidate.items.length === NO_INSTANCES,
    t.signal,
  );
  const resumed = { ...entry, port: served() };
  thread.postMessage({ kind: ThreadMessageKind.Bindings, entries: [resumed] }, [
    resumed.port,
  ]);
  await until(
    registrations,
    (candidate) => candidate.items.length === SINGLE_INSTANCE,
    t.signal,
  );
  const exited = once(thread, "exit", {
    signal: AbortSignal.timeout(THREAD_EXIT_LIMIT_MS),
  });
  thread.postMessage({ kind: ThreadMessageKind.Stop });
  await exited;
});

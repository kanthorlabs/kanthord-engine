import assert from "node:assert/strict";
import { test } from "node:test";
import pino from "pino";
import { background } from "../kernel/context.ts";
import {
  CleanupRule,
  FootprintKind,
  RUNTIME_STORE_DEVICE,
} from "../footprint/contract.ts";
import {
  ContainerRuntime,
  type PoolInstance,
  PoolPlacement,
  type RuntimeImageUsage,
} from "./contract.ts";
import {
  repositoryOf,
  WorkerFootprint,
  WorkerFootprintErrorCode,
} from "./footprint.ts";
import { FakePoolHost } from "./test-support.ts";

const REPOSITORY = "localhost/kanthord-dev-node";
const CONFIGURED = `${REPOSITORY}:2.0.0`;
const OLD = `${REPOSITORY}:1.0.0`;
const IN_USE = `${REPOSITORY}:1.5.0`;
const NOW = Date.parse("2026-11-05T00:00:00Z");
const DAY = 86400000;
const REQUESTER = { kind: "human", account: "ulrich", name: "Ulrich" } as const;
const GRAPH_ROOT = "/var/lib/containers/storage";
const DOCKER_ROOT = "/var/lib/docker";
const DEVICE = 42;
const PORT_REPOSITORY = "localhost:5000/a/b";
const SLOT_IMAGE_COUNT = 3;
const SLOT_IMAGE_BYTES = 600;
const NO_READS = 0;
const ONE_READ = 1;
const PODMAN_TOTAL = 1000;
const PODMAN_USED = 600;
const PODMAN_FREE = 400;
const STATFS_TOTAL = 1000;
const STATFS_FREE = 250;
const DOCKER_IMAGE_BYTES = 7;
const STATE_DEVICE = "7";
const EXECUTION_OLD = "execution_01JABCDEFGHJKMNPQRSTVWXYZ0";
const EXECUTION_NEW = "execution_01JABCDEFGHJKMNPQRSTVWXYZ1";
const SERVER_INSTANCE: PoolInstance = {
  id: "worker_instance_01JABCDEFGHJKMNPQRSTVWXYZ0",
  name: "coder-1",
  placement: PoolPlacement.Server,
  created_at: NOW - 50 * DAY,
};
const CONTAINER_INSTANCE: PoolInstance = {
  id: "worker_instance_01JABCDEFGHJKMNPQRSTVWXYZ1",
  name: "coder-2",
  placement: PoolPlacement.Container,
  created_at: NOW - 50 * DAY,
};

function image(
  hex: string,
  references: string[],
  bytes: number,
  containers = 0,
): RuntimeImageUsage {
  return {
    id: `sha256:${hex.repeat(64)}`,
    references,
    created_at: NOW - 40 * DAY,
    unique_bytes: bytes,
    containers,
  };
}

function harness(
  options: {
    platform?: NodeJS.Platform;
    containers?: string[];
    statable?: boolean;
    servers?: PoolInstance[];
  } = {},
) {
  const host = new FakePoolHost();
  host.usage = {
    runtime: ContainerRuntime.Podman,
    images: [
      image("1", [CONFIGURED], 100),
      image("2", [OLD], 200),
      image("3", [IN_USE], 300, 1),
      image("4", ["localhost/other:1"], 400),
    ],
    volumes: [],
  };
  const statfsCalls: string[] = [];
  const footprint = new WorkerFootprint({
    host: () => host,
    configuredImage: CONFIGURED,
    containerInstances: () => options.containers ?? [],
    serverInstances: () => options.servers ?? [],
    stateDevice: async () => STATE_DEVICE,
    platform: options.platform ?? "linux",
    logger: pino({ level: "silent" }),
    device: {
      stat: async (path) => {
        if (options.statable === false) throw new Error(`absent ${path}`);
        return { dev: DEVICE };
      },
      statfs: async (path) => {
        statfsCalls.push(path);
        return { blocks: 100, bsize: 10, bavail: 25 };
      },
    },
    now: () => NOW,
  });
  return { host, footprint, statfsCalls };
}

function query(rule: { name: CleanupRule } | null) {
  return {
    kind: FootprintKind.SlotImage,
    instance_name: null,
    rule: rule as never,
    offset: 0,
    limit: 100,
    now: NOW,
    signal: background.signal,
  };
}

test("repositoryOf keeps a registry port and drops the tag", () => {
  assert.equal(repositoryOf(`${PORT_REPOSITORY}:1`), PORT_REPOSITORY);
  assert.equal(repositoryOf(PORT_REPOSITORY), PORT_REPOSITORY);
});

test("slot_image measures the images of the configured repository on the runtime store", async () => {
  const { footprint } = harness();
  const [slot] = await footprint.measure(background.signal);
  assert.equal(slot?.kind, FootprintKind.SlotImage);
  assert.equal(slot?.count, SLOT_IMAGE_COUNT);
  assert.equal(slot?.bytes, SLOT_IMAGE_BYTES);
  assert.equal(slot?.device, RUNTIME_STORE_DEVICE);
});

test("superseded keeps the configured image of the running version and an image that a live container uses", async () => {
  const { footprint } = harness();
  const page = await footprint.candidates(
    query({ name: CleanupRule.Superseded }),
  );
  assert.deepEqual(
    page.items.map((item) => item.key),
    [OLD],
  );
  const all = await footprint.candidates(query(null));
  assert.deepEqual(
    all.items.map((item) => [item.key, item.refusal]),
    [
      [OLD, null],
      [IN_USE, "live"],
      [CONFIGURED, "live"],
    ],
  );
});

test("slot_image delete refuses the configured image and an image in use with live", async () => {
  const { footprint, host } = harness();
  const answer = await footprint.deleteSlotImages(
    [CONFIGURED, IN_USE, OLD, `${REPOSITORY}:0.1.0`],
    REQUESTER,
    background.signal,
  );
  assert.deepEqual(answer, {
    removed: 1,
    absent: 1,
    refused: [
      { key: CONFIGURED, reason: "live" },
      { key: IN_USE, reason: "live" },
    ],
  });
  assert.deepEqual(host.removedImages, [OLD]);
});

test("no runtime store read runs with no container placement instance", async () => {
  const { footprint, host } = harness();
  const measures = await footprint.measure(background.signal);
  assert.equal(host.storeReads, NO_READS);
  assert.equal(
    measures.some((measure) => measure.kind === FootprintKind.Disk),
    false,
  );
});

test("the Podman store answers total GraphRootAllocated and free GraphRootAllocated less GraphRootUsed with the device of the graph root", async () => {
  const { footprint, host } = harness({ containers: ["box-2", "box-1"] });
  host.store = {
    runtime: ContainerRuntime.Podman,
    graph_root: GRAPH_ROOT,
    graph_root_allocated: PODMAN_TOTAL,
    graph_root_used: PODMAN_USED,
    docker_root_dir: null,
    operating_system: null,
  };
  const disk = (await footprint.measure(background.signal)).find(
    (measure) => measure.kind === FootprintKind.Disk,
  );
  assert.equal(disk?.item_key, String(DEVICE));
  assert.equal(disk?.total_bytes, PODMAN_TOTAL);
  assert.equal(disk?.free_bytes, PODMAN_FREE);
  assert.equal(disk?.runtime_store, true);
  assert.deepEqual(disk?.instance_names, ["box-1", "box-2"]);
});

test("a graph root that is not on the server host takes the fixed device key", async () => {
  const { footprint, host } = harness({ containers: ["box"], statable: false });
  host.store = {
    runtime: ContainerRuntime.Podman,
    graph_root: GRAPH_ROOT,
    graph_root_allocated: 10,
    graph_root_used: 5,
    docker_root_dir: null,
    operating_system: null,
  };
  const disk = (await footprint.measure(background.signal)).find(
    (measure) => measure.kind === FootprintKind.Disk,
  );
  assert.equal(disk?.item_key, RUNTIME_STORE_DEVICE);
});

test("a Linux Docker Engine reads statfs of DockerRootDir with the device rule", async () => {
  const { footprint, host, statfsCalls } = harness({ containers: ["box"] });
  host.store = {
    runtime: ContainerRuntime.Docker,
    graph_root: null,
    graph_root_allocated: null,
    graph_root_used: null,
    docker_root_dir: DOCKER_ROOT,
    operating_system: "Ubuntu 24.04 LTS",
  };
  const disk = (await footprint.measure(background.signal)).find(
    (measure) => measure.kind === FootprintKind.Disk,
  );
  assert.deepEqual(statfsCalls, [DOCKER_ROOT]);
  assert.equal(disk?.item_key, String(DEVICE));
  assert.equal(disk?.total_bytes, STATFS_TOTAL);
  assert.equal(disk?.free_bytes, STATFS_FREE);
});

for (const [platform, system] of [
  ["darwin", "Docker Desktop"],
  ["linux", "Docker Desktop"],
  ["darwin", "Ubuntu 24.04 LTS"],
] as const)
  test(`Docker on ${platform} with ${system} answers runtime_store_unmeasured`, async () => {
    const { footprint, host, statfsCalls } = harness({
      platform,
      containers: ["box"],
    });
    host.store = {
      runtime: ContainerRuntime.Docker,
      graph_root: null,
      graph_root_allocated: null,
      graph_root_used: null,
      docker_root_dir: DOCKER_ROOT,
      operating_system: system,
    };
    const disk = (await footprint.measure(background.signal)).find(
      (measure) => measure.kind === FootprintKind.Disk,
    );
    assert.equal(
      disk?.measure_error?.code,
      WorkerFootprintErrorCode.RuntimeStoreUnmeasured,
    );
    assert.deepEqual(statfsCalls, []);
  });

test("slot_image reads the Docker usage answer of the pool host", async () => {
  const { footprint, host } = harness();
  host.usage = {
    runtime: ContainerRuntime.Docker,
    images: [image("5", [OLD], DOCKER_IMAGE_BYTES)],
    volumes: [],
  };
  const [slot] = await footprint.measure(background.signal);
  assert.equal(host.usageReads, ONE_READ);
  assert.equal(slot?.bytes, DOCKER_IMAGE_BYTES);
});

test("session at server and container measures the server-side session walk of each instance, oldest first, on the state device", async () => {
  const { host, footprint } = harness({
    servers: [SERVER_INSTANCE, CONTAINER_INSTANCE],
  });
  host.sessions.set(SERVER_INSTANCE.name, [
    { key: EXECUTION_NEW, bytes: 20, modified_at: NOW - DAY },
    { key: EXECUTION_OLD, bytes: 10, modified_at: NOW - 40 * DAY },
  ]);
  const sessions = (await footprint.measure(background.signal)).filter(
    (measure) => measure.kind === FootprintKind.Session,
  );
  assert.deepEqual(
    sessions.map((measure) => [
      measure.instance_name,
      measure.device,
      measure.count,
      measure.bytes,
      measure.oldest_at,
      measure.recent_count,
      measure.items?.map((item) => item.key),
    ]),
    [
      [
        SERVER_INSTANCE.name,
        STATE_DEVICE,
        2,
        30,
        NOW - 40 * DAY,
        1,
        [EXECUTION_OLD, EXECUTION_NEW],
      ],
      [CONTAINER_INSTANCE.name, STATE_DEVICE, 0, 0, null, 0, []],
    ],
  );
});

test("a failed server-side session walk answers a measure error for that instance only", async () => {
  const { host, footprint } = harness({ servers: [SERVER_INSTANCE] });
  host.sessionItems = async () => {
    throw new Error("The execution session root is not a directory.");
  };
  const [session] = (await footprint.measure(background.signal)).filter(
    (measure) => measure.kind === FootprintKind.Session,
  );
  assert.equal(session?.instance_name, SERVER_INSTANCE.name);
  assert.equal(
    session?.measure_error?.code,
    WorkerFootprintErrorCode.SessionUnmeasured,
  );
});

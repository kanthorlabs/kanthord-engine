import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { MessageChannel } from "node:worker_threads";
import { stopAfter, temporaryDirectory } from "../../kernel/test-support.ts";
import {
  BindingEntryState,
  ContainerRuntime,
  PoolPlacement,
} from "../../worker/contract.ts";
import { SlotControl } from "../worker/thread-data.ts";
import {
  CACHE_OWNER_RECORD_SUFFIX,
  ContainerDriver,
  type ContainerDriverOptions,
  SESSION_VOLUME_MARKER,
} from "./container-driver.ts";
import {
  cacheVolumeName,
  containerOwner,
  ID_MAP_LABEL,
  type RuntimeAnswer,
  type RuntimeHost,
  SUCCESS_CODE,
  UNSHARE_MIGRATION_SCRIPT,
} from "./container-runtime.ts";
import type { SlotEntry, SlotLaunch } from "./slot-driver.ts";

const MASTER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const CLIENT_ID = "client_identity_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RESOURCE = "worker:kanthord:general";
const GROUP = "repository:github:acme/app";
const IMAGE = "kanthord:test";
const SERVER_UID = 1000;
const ROOT_UID = 0;
const FAILED_CODE = 1;
const CREATED_AT = "2026-11-04T00:00:00Z";
const NEWER_CREATED_AT = "2026-11-05T00:00:00Z";
const MOUNT_POINT = "/volumes/kanthord_slot/_data";
const AUTO_OPTION = "--userns=auto:uidmapping=10001:0:1,gidmapping=10001:0:1";
const KEEP_ID_OPTION = "--userns=keep-id:uid=10001,gid=10001";
const PULL_NEVER = "--pull=never";
const SETTLE_MS = 50;
const POLL_MS = 20;
const POLL_ROUNDS = 500;
const PRIVATE_DIRECTORY = 0o700;
const PRIVATE_FILE = 0o600;
const PERMISSION_BITS = 0o777;
const ONE_RUN = 1;
const NO_RUNS = 0;
const MOST_FULL_MAPS = 1;
const Verb = {
  Unshare: "unshare",
  Run: "run",
  Info: "info",
  Volume: "volume",
  Kill: "kill",
  Ps: "ps",
} as const;
const VolumeAction = { Inspect: "inspect", Create: "create" } as const;
const MIGRATE_COPY = "kanthord_migrate_coder-1";
const STALE_REMOVAL = `rm --force ${MIGRATE_COPY}`;
const PORT_FRAME = JSON.stringify({
  kind: "port",
  client_id: "client_identity_other",
  message: {},
});

interface Scenario {
  readonly runtime?: ContainerRuntime;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly rootless?: boolean;
  readonly remote?: boolean;
  readonly labeled?: boolean;
  readonly createdAt?: string;
  readonly hold?: (args: readonly string[]) => Promise<RuntimeAnswer> | null;
}

const ok = (stdout = ""): RuntimeAnswer => ({
  code: SUCCESS_CODE,
  stdout,
  stderr: "",
});

function infoOf(scenario: Scenario): RuntimeAnswer {
  if (scenario.runtime === ContainerRuntime.Docker)
    return ok(
      JSON.stringify({
        ServerVersion: "27.3.1",
        OperatingSystem: "Ubuntu 24.04.1 LTS",
        SecurityOptions: ["name=seccomp,profile=builtin"],
        ClientInfo: { Version: "27.3.1" },
      }),
    );
  return ok(
    JSON.stringify({
      host: {
        os: "linux",
        security: {
          rootless: scenario.rootless ?? true,
          selinuxEnabled: false,
        },
        serviceIsRemote: scenario.remote ?? false,
        idMappings: {
          uidmap: [
            { container_id: 0, host_id: SERVER_UID, size: 1 },
            { container_id: 1, host_id: 100000, size: 65536 },
          ],
        },
      },
      version: { Version: "6.0.2" },
    }),
  );
}

function isMigration(args: readonly string[]): boolean {
  return (
    args[0] === Verb.Unshare ||
    (args[0] === Verb.Run &&
      args.some((arg) => arg.startsWith("kanthord_migrate_")))
  );
}

function isCacheOwner(args: readonly string[]): boolean {
  return args[0] === Verb.Run && !isMigration(args);
}

function isFullMap(args: readonly string[]): boolean {
  return args.includes(KEEP_ID_OPTION);
}

let slotBin: string | null = null;

function fakeSlotBin(): string {
  if (slotBin !== null) return slotBin;
  const root = temporaryDirectory();
  const bin = join(root, "bin");
  mkdirSync(bin);
  const script = `#!/bin/sh
printf '%s\\n' "$@" > "$KANTHORD_TEST_ARGUMENTS.partial"
mv "$KANTHORD_TEST_ARGUMENTS.partial" "$KANTHORD_TEST_ARGUMENTS"
n=0; while [ ! -e "$KANTHORD_TEST_FRAME" ] && [ ! -e "$KANTHORD_TEST_RELEASE" ] && [ $n -lt 500 ]; do sleep 0.02; n=$((n+1)); done
[ -e "$KANTHORD_TEST_FRAME" ] && printf '%s\\n' '${PORT_FRAME}'
n=0; while [ ! -e "$KANTHORD_TEST_RELEASE" ] && [ $n -lt 500 ]; do sleep 0.02; n=$((n+1)); done
`;
  for (const runtime of Object.values(ContainerRuntime))
    writeFileSync(join(bin, runtime), script, { mode: 0o755 });
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  slotBin = bin;
  return bin;
}

async function until(condition: () => boolean, message: string) {
  for (let round = 0; round < POLL_ROUNDS; round++) {
    if (condition()) return;
    await delay(POLL_MS);
  }
  assert.fail(message);
}

function rig(t: TestContext, scenario: Scenario = {}) {
  const state = temporaryDirectory();
  const stops: Array<() => Promise<unknown>> = [];
  stopAfter(t, async () => {
    for (const stop of stops) await stop();
    rmSync(state, { recursive: true, force: true });
  });
  const calls: string[][] = [];
  const running = new Set<string>();
  let fullMapPeak = 0;
  let sharedDuringFullMap = false;
  const volumes = new Map<string, { labeled: boolean; createdAt: string }>();
  const volumeOf = (name: string) =>
    volumes.get(name) ?? {
      labeled: scenario.labeled ?? true,
      createdAt: scenario.createdAt ?? CREATED_AT,
    };
  const fullMaps = () =>
    [...running].filter((key) => key.startsWith("full:")).length;
  const host: RuntimeHost = {
    platform: scenario.platform ?? "linux",
    uid: scenario.uid ?? SERVER_UID,
    user: "kanthord",
    environment: {},
    exists: () => false,
    resolves: (runtime) =>
      runtime === (scenario.runtime ?? ContainerRuntime.Podman),
    run: async (_runtime, args) => {
      calls.push([...args]);
      if (args[0] === Verb.Info) return infoOf(scenario);
      if (args[0] === Verb.Volume && args[1] === VolumeAction.Inspect) {
        const name = args.at(-1)!;
        const volume = volumeOf(name);
        return ok(
          JSON.stringify([
            {
              Name: name,
              CreatedAt: volume.createdAt,
              Mountpoint: MOUNT_POINT,
              Labels: volume.labeled
                ? { [ID_MAP_LABEL.split("=")[0]!]: "auto" }
                : {},
            },
          ]),
        );
      }
      const held = scenario.hold?.(args) ?? null;
      if (held === null) return ok();
      const key = `${isFullMap(args) ? "full" : "shared"}:${calls.length}`;
      running.add(key);
      if (isFullMap(args)) fullMapPeak = Math.max(fullMapPeak, fullMaps());
      else if (fullMaps()) sharedDuringFullMap = true;
      try {
        return await held;
      } finally {
        running.delete(key);
      }
    },
  };
  const bin = fakeSlotBin();
  const driverOf = (options: Partial<ContainerDriverOptions> = {}) =>
    new ContainerDriver({
      masterKey: MASTER_KEY,
      image: IMAGE,
      host,
      stateDirectory: state,
      ...options,
    });
  const driver = driverOf();
  const launch = (
    name: string,
    options: { driver?: ContainerDriver; entries?: SlotEntry[] } = {},
  ) => {
    const root = join(state, "workers", name);
    mkdirSync(root, { recursive: true, mode: PRIVATE_DIRECTORY });
    const signals = join(state, `signals-${name}-${calls.length}`);
    mkdirSync(signals);
    const files = {
      arguments: join(signals, "arguments"),
      frame: join(signals, "frame"),
      release: join(signals, "release"),
    };
    const slotLaunch: SlotLaunch = {
      instance: {
        id: "worker_instance_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        name,
        placement: PoolPlacement.Container,
        created_at: 1,
      },
      entries: options.entries ?? [],
      root,
      output: new Writable({ write: (_chunk, _encoding, done) => done() }),
      environment: {
        PATH: `${bin}:${process.env.PATH}`,
        KANTHORD_TEST_ARGUMENTS: files.arguments,
        KANTHORD_TEST_FRAME: files.frame,
        KANTHORD_TEST_RELEASE: files.release,
      },
    };
    const instance = (options.driver ?? driver).launch(slotLaunch);
    stops.push(async () => {
      writeFileSync(files.release, "");
      instance.terminate();
      await instance.exited;
    });
    return {
      instance,
      root,
      spawned: () => existsSync(files.arguments),
      slotArguments: () => readFileSync(files.arguments, "utf8").split("\n"),
      frame: () => writeFileSync(files.frame, ""),
      release: () => writeFileSync(files.release, ""),
    };
  };
  const migrations = () => calls.filter(isMigration);
  return {
    state,
    calls,
    driver,
    driverOf,
    launch,
    volumes,
    migrations,
    cacheOwners: () => calls.filter(isCacheOwner),
    fullMapPeak: () => fullMapPeak,
    sharedDuringFullMap: () => sharedDuringFullMap,
  };
}

function markerOf(root: string): string {
  return readFileSync(join(root, SESSION_VOLUME_MARKER), "utf8");
}

test("rootless Podman on Linux moves an earlier volume with podman unshare once and starts no migration container", async (t) => {
  const f = rig(t, { labeled: false });
  const first = f.launch("coder-1");
  await until(first.spawned, "The slot container did not start.");
  assert.deepEqual(f.migrations(), [
    [
      "unshare",
      "/bin/sh",
      "-c",
      UNSHARE_MIGRATION_SCRIPT,
      "sh",
      MOUNT_POINT,
      join(first.root, "sessions.partial"),
    ],
  ]);
  assert.equal(markerOf(first.root), CREATED_AT);
  assert.equal(existsSync(join(first.root, "sessions")), true);
  assert.equal(existsSync(join(first.root, "sessions.partial")), false);
  first.release();
  await first.instance.exited;
  const again = f.launch("coder-1");
  await until(again.spawned, "The second slot container did not start.");
  assert.equal(f.migrations().length, ONE_RUN);
});

test("rootless Podman runs the auto migration container for a new labeled volume and no full-map carrier", async (t) => {
  const f = rig(t);
  const slot = f.launch("coder-1");
  await until(slot.spawned, "The slot container did not start.");
  const [migration] = f.migrations();
  assert.equal(migration![0], Verb.Run);
  assert.ok(migration!.includes(AUTO_OPTION));
  assert.ok(!migration!.includes(KEEP_ID_OPTION));
  assert.ok(!f.calls.some((call) => call[0] === Verb.Unshare));
  assert.ok(slot.slotArguments().includes(AUTO_OPTION));
});

test("a remote Podman client on Linux takes the one-shot keep-id migration for an earlier volume", async (t) => {
  const f = rig(t, { labeled: false, remote: true });
  const slot = f.launch("coder-1");
  await until(slot.spawned, "The slot container did not start.");
  const [migration] = f.migrations();
  assert.equal(migration![0], Verb.Run);
  assert.ok(migration!.includes(KEEP_ID_OPTION));
  assert.ok(!f.calls.some((call) => call[0] === Verb.Unshare));
});

test("rootless Podman on macOS starts no container while a full-map keep-id container runs, and runs one full map at a time", async (t) => {
  const gates = new Map<string, PromiseWithResolvers<RuntimeAnswer>>();
  const gateOf = (name: string) => {
    let gate = gates.get(name);
    if (!gate) {
      gate = Promise.withResolvers<RuntimeAnswer>();
      gates.set(name, gate);
    }
    return gate;
  };
  const f = rig(t, {
    platform: "darwin",
    remote: true,
    hold: (args) =>
      isMigration(args)
        ? gateOf(args[args.indexOf("--name") + 1]!).promise
        : null,
  });
  f.volumes.set("kanthord_slot_old-1", {
    labeled: false,
    createdAt: CREATED_AT,
  });
  f.volumes.set("kanthord_slot_old-2", {
    labeled: false,
    createdAt: CREATED_AT,
  });
  const old = f.launch("old-1");
  await until(
    () => gates.has("kanthord_migrate_old-1"),
    "No full map started.",
  );
  const second = f.launch("old-2");
  const fresh = f.launch("new-1");
  await delay(SETTLE_MS);
  assert.equal(gates.has("kanthord_migrate_old-2"), false);
  assert.equal(gates.has("kanthord_migrate_new-1"), false);
  assert.equal(fresh.spawned(), false);
  gateOf("kanthord_migrate_old-1").resolve(ok());
  for (const name of ["kanthord_migrate_old-2", "kanthord_migrate_new-1"]) {
    await until(() => gates.has(name), `${name} did not start.`);
    gateOf(name).resolve(ok());
  }
  await until(old.spawned, "The slot after the full map did not start.");
  await until(second.spawned, "The second slot did not start.");
  await until(fresh.spawned, "The new slot did not start.");
  assert.ok(f.fullMapPeak() <= MOST_FULL_MAPS);
  assert.equal(f.sharedDuringFullMap(), false);
});

test("rootless Podman on macOS runs no keep-id container for a new labeled volume, and no start waits", async (t) => {
  const f = rig(t, { platform: "darwin", remote: true });
  const slot = f.launch("coder-1");
  await until(slot.spawned, "The slot container did not start.");
  assert.ok(!f.calls.some(isFullMap));
  assert.ok(f.migrations()[0]!.includes(AUTO_OPTION));
});

test("a full-map keep-id container waits until a starting slot container sends its first frame", async (t) => {
  const f = rig(t, { platform: "darwin", remote: true });
  f.volumes.set("kanthord_slot_old-1", {
    labeled: false,
    createdAt: CREATED_AT,
  });
  const fresh = f.launch("new-1");
  await until(fresh.spawned, "The new slot did not start.");
  f.launch("old-1");
  await delay(SETTLE_MS);
  assert.ok(!f.calls.some(isFullMap));
  fresh.frame();
  await until(() => f.calls.some(isFullMap), "The full map did not start.");
});

test("a full-map keep-id container waits until a starting slot container exits", async (t) => {
  const f = rig(t, { platform: "darwin", remote: true });
  f.volumes.set("kanthord_slot_old-1", {
    labeled: false,
    createdAt: CREATED_AT,
  });
  const fresh = f.launch("new-1");
  await until(fresh.spawned, "The new slot did not start.");
  f.launch("old-1");
  await delay(SETTLE_MS);
  assert.ok(!f.calls.some(isFullMap));
  fresh.release();
  await until(() => f.calls.some(isFullMap), "The full map did not start.");
});

test("a launch runs the migration only when sessions is absent or the marker is absent or differs", async (t) => {
  const f = rig(t);
  const first = f.launch("coder-1");
  await until(first.spawned, "The first slot did not start.");
  first.release();
  await first.instance.exited;
  assert.equal(f.migrations().length, ONE_RUN);
  const same = f.launch("coder-1");
  await until(same.spawned, "The second slot did not start.");
  same.release();
  await same.instance.exited;
  assert.equal(f.migrations().length, ONE_RUN);
  rmSync(join(first.root, SESSION_VOLUME_MARKER));
  const unmarked = f.launch("coder-1");
  await until(unmarked.spawned, "The third slot did not start.");
  unmarked.release();
  await unmarked.instance.exited;
  assert.equal(f.migrations().length, ONE_RUN + 1);
  f.volumes.set("kanthord_slot_coder-1", {
    labeled: true,
    createdAt: NEWER_CREATED_AT,
  });
  const renewed = f.launch("coder-1");
  await until(renewed.spawned, "The fourth slot did not start.");
  const last = f.migrations().at(-1)!;
  assert.ok(last.includes(`${join(first.root, "sessions")}:/migrate`));
  assert.equal(markerOf(first.root), NEWER_CREATED_AT);
});

test("a stop before the migration leaves no marker, and the next launch runs the migration", async (t) => {
  const image = Promise.withResolvers<string>();
  const f = rig(t);
  const waiting = f.driverOf({ imageFor: () => image.promise });
  const stopped = f.launch("coder-1", { driver: waiting });
  await until(
    () =>
      f.calls.some(
        (call) => call[0] === Verb.Volume && call[1] === VolumeAction.Create,
      ),
    "The volume was not created.",
  );
  stopped.instance.control(SlotControl.Stop);
  assert.deepEqual(await stopped.instance.exited, {
    code: SUCCESS_CODE,
    error: null,
  });
  assert.equal(f.migrations().length, NO_RUNS);
  assert.equal(existsSync(join(stopped.root, SESSION_VOLUME_MARKER)), false);
  const next = f.launch("coder-1");
  await until(next.spawned, "The next slot did not start.");
  assert.equal(f.migrations().length, ONE_RUN);
});

test("a Docker volume that exists with a marker equal to its CreatedAt runs no migration", async (t) => {
  const f = rig(t, { runtime: ContainerRuntime.Docker, uid: ROOT_UID });
  const root = join(f.state, "workers", "coder-1");
  mkdirSync(join(root, "sessions"), { recursive: true });
  writeFileSync(join(root, SESSION_VOLUME_MARKER), CREATED_AT, {
    mode: PRIVATE_FILE,
  });
  const slot = f.launch("coder-1");
  await until(slot.spawned, "The slot did not start.");
  assert.equal(f.migrations().length, NO_RUNS);
});

test("a terminate during the migration kills the migration container and spawns no slot container", async (t) => {
  const held = Promise.withResolvers<RuntimeAnswer>();
  const f = rig(t, {
    hold: (args) => (isMigration(args) ? held.promise : null),
  });
  const slot = f.launch("coder-1");
  await until(() => f.migrations().length === ONE_RUN, "No migration ran.");
  slot.instance.terminate();
  await until(
    () =>
      f.calls.some(
        (call) => call[0] === Verb.Kill && call.at(-1) === MIGRATE_COPY,
      ),
    "The migration container was not killed.",
  );
  held.resolve({ code: FAILED_CODE, stdout: "", stderr: "killed" });
  const exit = await slot.instance.exited;
  assert.equal(exit.code, FAILED_CODE);
  await delay(SETTLE_MS);
  assert.equal(slot.spawned(), false);
  assert.equal(existsSync(join(slot.root, SESSION_VOLUME_MARKER)), false);
});

test("the migration runs after the image wait and before the spawn", async (t) => {
  const image = Promise.withResolvers<string>();
  const f = rig(t);
  const waiting = f.driverOf({ imageFor: () => image.promise });
  const slot = f.launch("coder-1", { driver: waiting });
  await delay(SETTLE_MS);
  assert.equal(f.migrations().length, NO_RUNS);
  image.resolve("localhost/kanthord-env/app:ready");
  await until(slot.spawned, "The slot did not start.");
  const [migration] = f.migrations();
  assert.ok(migration!.includes("localhost/kanthord-env/app:ready"));
  assert.ok(migration!.includes(PULL_NEVER));
});

test("a rootful runtime on macOS creates sessions.partial with mode 0700 and no owner change on the host", async (t) => {
  const held = Promise.withResolvers<RuntimeAnswer>();
  const f = rig(t, {
    platform: "darwin",
    rootless: false,
    hold: (args) => (isMigration(args) ? held.promise : null),
  });
  const slot = f.launch("coder-1");
  await until(() => f.migrations().length === ONE_RUN, "No migration ran.");
  const partial = statSync(join(slot.root, "sessions.partial"));
  assert.equal(partial.mode & PERMISSION_BITS, PRIVATE_DIRECTORY);
  assert.equal(partial.uid, process.getuid?.());
  const [migration] = f.migrations();
  assert.ok(!migration!.some((arg) => arg.startsWith("--userns")));
  assert.ok(!migration!.at(-1)!.includes("/var/lib/kanthord /migrate"));
  held.resolve(ok());
  await until(slot.spawned, "The slot did not start.");
});

test("check answers the status only and facts answers null when the status is not available", async (t) => {
  const f = rig(t);
  const status = await f.driver.check();
  assert.deepEqual(Object.keys(status).sort(), [
    "available",
    "container_runtime",
    "detail",
    "placement",
    "reason",
  ]);
  assert.deepEqual(await f.driver.facts(), {
    rootless: true,
    selinux: false,
    platform: "linux",
    dockerDesktop: false,
    remote: false,
  });
  const rootful = rig(t, { rootless: false });
  assert.equal((await rootful.driver.check()).available, false);
  assert.equal(await rootful.driver.facts(), null);
});

test("a failed migration exits 1, keeps sessions.partial and runs again at the next launch", async (t) => {
  let failures = ONE_RUN;
  const f = rig(t, {
    hold: (args) =>
      isMigration(args) && failures-- > NO_RUNS
        ? Promise.resolve({
            code: FAILED_CODE,
            stdout: "",
            stderr: "copy failed",
          })
        : null,
  });
  const failed = f.launch("coder-1");
  const exit = await failed.instance.exited;
  assert.equal(exit.code, FAILED_CODE);
  assert.match(
    exit.error?.message ?? "",
    /session migration failed: copy failed/,
  );
  assert.equal(existsSync(join(failed.root, "sessions.partial")), true);
  assert.equal(existsSync(join(failed.root, SESSION_VOLUME_MARKER)), false);
  assert.equal(failed.spawned(), false);
  const next = f.launch("coder-1");
  await until(next.spawned, "The next slot did not start.");
  assert.equal(f.migrations().length, ONE_RUN + 1);
  assert.equal(existsSync(join(failed.root, "sessions")), true);
});

function cachedEntry(): SlotEntry {
  return {
    project_id: PROJECT_ID,
    resource_identity: RESOURCE,
    client_id: CLIENT_ID,
    state: BindingEntryState.Serving,
    client_secret: "unused",
    channel: new MessageChannel().port2,
  };
}

const CACHE_VOLUME = cacheVolumeName(
  containerOwner(MASTER_KEY),
  PROJECT_ID,
  GROUP,
);

function cacheRig(t: TestContext, scenario: Scenario = {}) {
  const f = rig(t, scenario);
  const driver = f.driverOf({
    imageFor: () => Promise.resolve(IMAGE),
    cacheGroupOf: () => GROUP,
  });
  const record = join(
    f.state,
    "volumes",
    `${CACHE_VOLUME}${CACHE_OWNER_RECORD_SUFFIX}`,
  );
  return { ...f, cachedDriver: driver, record };
}

test("the cache volume step of a labeled volume runs an auto container once after the image wait with --pull=never", async (t) => {
  const f = cacheRig(t);
  const slot = f.launch("coder-1", {
    driver: f.cachedDriver,
    entries: [cachedEntry()],
  });
  await until(slot.spawned, "The slot did not start.");
  const [owner] = f.cacheOwners();
  assert.ok(owner!.includes(AUTO_OPTION));
  assert.ok(owner!.includes(PULL_NEVER));
  assert.ok(owner!.includes(IMAGE));
  assert.ok(
    owner!.at(-1)!.includes("[ -e /var/lib/kanthord/.cache/.kanthord_owner ]"),
  );
  assert.equal(readFileSync(f.record, "utf8"), CREATED_AT);
  assert.ok(
    slot.slotArguments().includes(`${CACHE_VOLUME}:/var/lib/kanthord/.cache`),
  );
  slot.release();
  await slot.instance.exited;
  const second = f.launch("coder-1", {
    driver: f.cachedDriver,
    entries: [cachedEntry()],
  });
  await until(second.spawned, "The second slot did not start.");
  assert.equal(f.cacheOwners().length, ONE_RUN);
});

test("a cache volume without the label runs the full-map carrier once, writes the host record and then runs no owner step", async (t) => {
  const f = cacheRig(t);
  f.volumes.set(CACHE_VOLUME, { labeled: false, createdAt: CREATED_AT });
  const first = f.launch("coder-1", {
    driver: f.cachedDriver,
    entries: [cachedEntry()],
  });
  await until(first.spawned, "The first slot did not start.");
  assert.deepEqual(
    f.calls.filter((call) => call[0] === Verb.Unshare).slice(-2),
    [
      ["unshare", "chown", "-R", "0:0", MOUNT_POINT],
      ["unshare", "touch", join(MOUNT_POINT, ".kanthord_owner")],
    ],
  );
  assert.equal(f.cacheOwners().length, NO_RUNS);
  assert.equal(readFileSync(f.record, "utf8"), CREATED_AT);
  assert.equal(statSync(f.record).mode & PERMISSION_BITS, PRIVATE_FILE);
  assert.equal(
    statSync(join(f.state, "volumes")).mode & PERMISSION_BITS,
    PRIVATE_DIRECTORY,
  );
  first.release();
  await first.instance.exited;
  const unshares = f.calls.filter((call) => call[0] === Verb.Unshare).length;
  const second = f.launch("coder-1", {
    driver: f.cachedDriver,
    entries: [cachedEntry()],
  });
  await until(second.spawned, "The second slot did not start.");
  assert.equal(
    f.calls.filter((call) => call[0] === Verb.Unshare).length,
    unshares,
  );
  assert.equal(f.cacheOwners().length, NO_RUNS);
});

test("a cache volume without the label on macOS runs a keep-id one-shot container in exclusive", async (t) => {
  const f = cacheRig(t, { platform: "darwin", remote: true });
  f.volumes.set(CACHE_VOLUME, { labeled: false, createdAt: CREATED_AT });
  const slot = f.launch("coder-1", {
    driver: f.cachedDriver,
    entries: [cachedEntry()],
  });
  await until(slot.spawned, "The slot did not start.");
  const [owner] = f.cacheOwners();
  assert.ok(owner!.includes(KEEP_ID_OPTION));
  assert.equal(readFileSync(f.record, "utf8"), CREATED_AT);
});

test("prepare removes a stale migration container of the owner", async (t) => {
  const f = rig(t, {
    hold: (args) =>
      args[0] === Verb.Ps
        ? Promise.resolve(ok("kanthord_migrate_coder-1\n"))
        : null,
  });
  await f.driver.prepare();
  assert.ok(f.calls.some((call) => call.join(" ") === STALE_REMOVAL));
});

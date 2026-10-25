import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Writable } from "node:stream";
import { MessageChannel } from "node:worker_threads";
import { temporary, temporaryDirectory } from "../../kernel/test-support.ts";
import { ContainerRuntime, PoolPlacement } from "../../worker/contract.ts";
import { SlotControl } from "../worker/thread-data.ts";
import {
  ContainerDriver,
  type ContainerDriverOptions,
} from "./container-driver.ts";
import {
  cacheVolumeName,
  containerOwner,
  SUCCESS_CODE,
  type RuntimeAnswer,
  type RuntimeHost,
} from "./container-runtime.ts";
import type { SlotLaunch } from "./slot-driver.ts";

const Verb = {
  Info: "info",
  Ps: "ps",
  Rm: "rm",
  Volume: "volume",
  Run: "run",
  Container: "container",
} as const;
const REMOVE_REFUSED = 125;
const NETAVARK_ERROR =
  'Error: netavark (exit code 1): nftables error: "nft" did not return successfully while applying ruleset';
const SERVER_UID = 1000;
const FAILED_CODE = 1;
const MASTER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const CLIENT_ID = "client_identity_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PRIOR_NAMES = "kanthord_slot_one\nkanthord_slot_two\n";
const PRIOR_COUNT = 2;
const ONE_CALL = 1;
const NO_CALLS = 0;
const INFO_ANSWER: RuntimeAnswer = {
  code: SUCCESS_CODE,
  stdout: JSON.stringify({
    host: {
      os: "linux",
      security: { rootless: true },
      idMappings: {
        uidmap: [
          { container_id: 0, host_id: SERVER_UID, size: 1 },
          { container_id: 1, host_id: 100000, size: 65536 },
        ],
      },
    },
    version: { Version: "5.4.2" },
  }),
  stderr: "",
};

interface Call {
  readonly verb: string;
  readonly args: readonly string[];
}

function hostWith(
  installed: boolean,
  answerOf: (call: Call) => Promise<RuntimeAnswer>,
  imageFor?: ContainerDriverOptions["imageFor"],
  cacheGroupOf?: ContainerDriverOptions["cacheGroupOf"],
) {
  const calls: Call[] = [];
  const host: RuntimeHost = {
    platform: "linux",
    uid: SERVER_UID,
    user: "kanthord",
    environment: {},
    exists: () => false,
    resolves: (runtime) => installed && runtime === ContainerRuntime.Podman,
    run: (_runtime, args) => {
      const call = { verb: args[0] ?? "", args };
      calls.push(call);
      return call.verb === Verb.Info
        ? Promise.resolve(INFO_ANSWER)
        : answerOf(call);
    },
  };
  const driver = new ContainerDriver({
    masterKey: MASTER_KEY,
    image: "kanthord:test",
    host,
    imageFor,
    cacheGroupOf,
  });
  const verbs = (verb: string) => calls.filter((call) => call.verb === verb);
  return { driver, calls, verbs };
}

function launchOf(environment: NodeJS.ProcessEnv = {}): SlotLaunch {
  const { port2 } = new MessageChannel();
  return {
    slot: {
      project_id: "project_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      resource_identity: "worker:kanthord:general",
      generation: 1,
      placement: PoolPlacement.Container,
      slot: 0,
      client_id: CLIENT_ID,
      draining: false,
    },
    channel: port2,
    client_secret: "unused",
    root: "unused",
    output: new Writable({ write: (_chunk, _encoding, done) => done() }),
    environment,
  };
}

const ok = (stdout = ""): Promise<RuntimeAnswer> =>
  Promise.resolve({ code: SUCCESS_CODE, stdout, stderr: "" });
const refused = (): Promise<RuntimeAnswer> =>
  Promise.resolve({ code: FAILED_CODE, stdout: "", stderr: "ps refused" });

test("prepare with no runtime does nothing, logs nothing and counts as not done", async (t) => {
  const writes: string[] = [];
  for (const stream of [process.stdout, process.stderr])
    t.mock.method(stream, "write", (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
  const absent = hostWith(false, () => ok());
  await absent.driver.prepare();
  assert.deepEqual(absent.calls, []);
  assert.deepEqual(writes, []);
  const present = hostWith(true, () => ok());
  await present.driver.prepare();
  assert.equal(present.verbs(Verb.Ps).length, ONE_CALL);
});

test("prepare removes each container of the owner once and a second call reuses the success", async () => {
  const f = hostWith(true, (call) =>
    call.verb === Verb.Ps ? ok(PRIOR_NAMES) : ok(),
  );
  await f.driver.prepare();
  await f.driver.prepare();
  assert.equal(f.verbs(Verb.Ps).length, ONE_CALL);
  assert.equal(f.verbs(Verb.Rm).length, PRIOR_COUNT);
});

test("prepare accepts a refused removal that leaves no container", async () => {
  const f = hostWith(true, (call) => {
    if (call.verb === Verb.Ps) return ok(PRIOR_NAMES);
    if (call.verb === Verb.Rm)
      return Promise.resolve({
        code: REMOVE_REFUSED,
        stdout: "",
        stderr: NETAVARK_ERROR,
      });
    if (call.verb === Verb.Container)
      return Promise.resolve({
        code: REMOVE_REFUSED,
        stdout: "",
        stderr: `Error: no such container "${call.args.at(-1)}"`,
      });
    return ok();
  });
  await f.driver.prepare();
  assert.equal(f.verbs(Verb.Container).length, PRIOR_COUNT);
});

test("prepare rejects with the runtime message when a refused removal leaves the container", async () => {
  const f = hostWith(true, (call) => {
    if (call.verb === Verb.Ps) return ok(PRIOR_NAMES);
    if (call.verb === Verb.Rm)
      return Promise.resolve({
        code: REMOVE_REFUSED,
        stdout: "",
        stderr: NETAVARK_ERROR,
      });
    return ok("abc\n");
  });
  await assert.rejects(
    f.driver.prepare(),
    /rm kanthord_slot_one failed: .*nftables error/,
  );
});

test("a failed prepare runs again at the next prepare", async () => {
  let refusals = ONE_CALL;
  const f = hostWith(true, (call) => {
    if (call.verb === Verb.Ps && refusals-- > NO_CALLS) return refused();
    return ok();
  });
  await assert.rejects(f.driver.prepare(), /ps failed: ps refused/);
  await f.driver.prepare();
  assert.equal(f.verbs(Verb.Ps).length, PRIOR_COUNT);
});

test("a launch after a failed prepare runs prepare again and starts no container", async () => {
  const f = hostWith(true, (call) =>
    call.verb === Verb.Ps ? refused() : ok(),
  );
  await assert.rejects(f.driver.prepare());
  const instance = f.driver.launch(launchOf());
  const exit = await instance.exited;
  assert.equal(exit.code, FAILED_CODE);
  assert.match(exit.error?.message ?? "", /ps failed/);
  assert.equal(f.verbs(Verb.Ps).length, PRIOR_COUNT);
  assert.equal(f.verbs(Verb.Rm).length, NO_CALLS);
  assert.equal(f.verbs(Verb.Volume).length, NO_CALLS);
  assert.equal(f.verbs(Verb.Run).length, NO_CALLS);
});

test("a launch waits for the running prepare before it removes or creates anything", async () => {
  const release = Promise.withResolvers<RuntimeAnswer>();
  const f = hostWith(true, (call) =>
    call.verb === Verb.Ps ? release.promise : ok(),
  );
  const pending = f.driver.prepare();
  const instance = f.driver.launch(launchOf());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.verbs(Verb.Ps).length, ONE_CALL);
  assert.equal(f.verbs(Verb.Rm).length, NO_CALLS);
  assert.equal(f.verbs(Verb.Volume).length, NO_CALLS);
  release.resolve({ code: FAILED_CODE, stdout: "", stderr: "late refusal" });
  await assert.rejects(pending);
  const exit = await instance.exited;
  assert.equal(exit.code, FAILED_CODE);
  assert.equal(f.verbs(Verb.Volume).length, NO_CALLS);
});

test("a launch whose environment image fails starts no container and exits with the image failure", async () => {
  const slots: string[] = [];
  const f = hostWith(
    true,
    () => ok(),
    (_runtime, slot) => {
      slots.push(slot.project_id);
      return Promise.reject(new Error("environment image refused"));
    },
  );
  const instance = f.driver.launch(launchOf());
  const exit = await instance.exited;
  assert.equal(exit.code, FAILED_CODE);
  assert.match(exit.error?.message ?? "", /environment image refused/);
  assert.deepEqual(slots, [launchOf().slot.project_id]);
  assert.equal(f.verbs(Verb.Run).length, NO_CALLS);
});

const SETTLE_MS = 50;
const POLL_MS = 20;
const POLL_ROUNDS = 1000;
const READY_TAG = "localhost/kanthord-env/repository_app:ready";

function imageGate() {
  const answer = Promise.withResolvers<string>();
  const asked = Promise.withResolvers<AbortSignal>();
  const imageFor: NonNullable<ContainerDriverOptions["imageFor"]> = (
    _runtime,
    _slot,
    signal,
  ) => {
    asked.resolve(signal);
    return answer.promise;
  };
  return { answer, asked: asked.promise, imageFor };
}

let sharedBin: string | null = null;

function recordingBin(): string {
  if (sharedBin !== null) return sharedBin;
  const root = temporaryDirectory();
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, ContainerRuntime.Podman),
    `#!/bin/sh
printf '%s\\n' "$@" > "$KANTHORD_TEST_ARGUMENTS.partial"
mv "$KANTHORD_TEST_ARGUMENTS.partial" "$KANTHORD_TEST_ARGUMENTS"
n=0; while [ ! -e "$KANTHORD_TEST_RELEASE" ] && [ $n -lt 500 ]; do sleep 0.02; n=$((n+1)); done
`,
    { mode: 0o755 },
  );
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  sharedBin = bin;
  return bin;
}

function recordingRuntime(t: TestContext) {
  const directory = temporary(t);
  const argumentsFile = join(directory, "arguments");
  const releaseFile = join(directory, "release");
  const bin = recordingBin();
  const recorded = async (): Promise<string[]> => {
    for (let round = 0; round < POLL_ROUNDS; round++) {
      if (existsSync(argumentsFile))
        return readFileSync(argumentsFile, "utf8").split("\n");
      await delay(POLL_MS);
    }
    assert.fail("The runtime did not receive the run command.");
  };
  return {
    environment: {
      PATH: `${bin}:${process.env.PATH}`,
      KANTHORD_TEST_ARGUMENTS: argumentsFile,
      KANTHORD_TEST_RELEASE: releaseFile,
    },
    spawned: () => existsSync(argumentsFile),
    recorded,
    release: () => writeFileSync(releaseFile, ""),
  };
}

test("an instance spawns no container while the image answer is pending", async (t) => {
  const runtime = recordingRuntime(t);
  const gate = imageGate();
  const f = hostWith(true, () => ok(), gate.imageFor);
  const instance = f.driver.launch(launchOf(runtime.environment));
  t.after(() => instance.terminate());
  await gate.asked;
  await delay(SETTLE_MS);
  assert.equal(runtime.spawned(), false);
  assert.equal(f.driver.imageOf(CLIENT_ID), null);
  assert.equal(
    await Promise.race([instance.exited, delay(SETTLE_MS, null)]),
    null,
  );
});

test("a stop during the image wait aborts the signal, spawns no container and ends the instance", async (t) => {
  const runtime = recordingRuntime(t);
  const gate = imageGate();
  const f = hostWith(true, () => ok(), gate.imageFor);
  const instance = f.driver.launch(launchOf(runtime.environment));
  const signal = await gate.asked;
  assert.equal(signal.aborted, false);
  instance.control(SlotControl.Stop);
  assert.equal(signal.aborted, true);
  const exit = await instance.exited;
  assert.equal(exit.code, SUCCESS_CODE);
  assert.equal(exit.error, null);
  assert.equal(runtime.spawned(), false);
  assert.equal(f.driver.imageOf(CLIENT_ID), null);
});

test("a drain during the image wait aborts the signal and ends the instance with no error", async () => {
  const gate = imageGate();
  const f = hostWith(true, () => ok(), gate.imageFor);
  const instance = f.driver.launch(launchOf());
  const signal = await gate.asked;
  instance.control(SlotControl.Drain);
  assert.equal(signal.aborted, true);
  const exit = await instance.exited;
  assert.deepEqual(exit, { code: SUCCESS_CODE, error: null });
});

test("a stop during the cache volume command spawns no container and ends the instance", async (t) => {
  const group = "repository:github:acme/app";
  const cache = cacheVolumeName(
    containerOwner(MASTER_KEY),
    "project_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    group,
  );
  const runtime = recordingRuntime(t);
  const asked = Promise.withResolvers<void>();
  const held = Promise.withResolvers<RuntimeAnswer>();
  const f = hostWith(
    true,
    (call) => {
      if (!call.args.includes(cache)) return ok();
      asked.resolve();
      return held.promise;
    },
    () => Promise.resolve(READY_TAG),
    () => group,
  );
  const instance = f.driver.launch(launchOf(runtime.environment));
  t.after(() => instance.terminate());
  await asked.promise;
  instance.control(SlotControl.Stop);
  runtime.release();
  held.resolve(await ok());
  const exit = await instance.exited;
  assert.deepEqual(exit, { code: SUCCESS_CODE, error: null });
  assert.equal(runtime.spawned(), false);
});

test("a resolved image answer starts the container on that image and imageOf answers it until the exit", async (t) => {
  const runtime = recordingRuntime(t);
  const gate = imageGate();
  const f = hostWith(true, () => ok(), gate.imageFor);
  const instance = f.driver.launch(launchOf(runtime.environment));
  await gate.asked;
  gate.answer.resolve(READY_TAG);
  const lines = await runtime.recorded();
  assert.ok(lines.includes(READY_TAG));
  assert.equal(f.driver.imageOf(CLIENT_ID), READY_TAG);
  runtime.release();
  await instance.exited;
  assert.equal(f.driver.imageOf(CLIENT_ID), null);
});

test("the image wait logs no line", async (t) => {
  const writes: string[] = [];
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream) as (
      ...args: unknown[]
    ) => boolean;
    t.mock.method(stream, "write", (chunk: unknown, ...rest: unknown[]) => {
      if (chunk instanceof Buffer) return original(chunk, ...rest);
      writes.push(String(chunk));
      return true;
    });
  }
  const gate = imageGate();
  const f = hostWith(true, () => ok(), gate.imageFor);
  const instance = f.driver.launch(launchOf());
  await gate.asked;
  await delay(SETTLE_MS);
  instance.control(SlotControl.Stop);
  await instance.exited;
  assert.deepEqual(writes, []);
});

test("a slot on the image of its group creates the cache volume and mounts it, and a slot on another image mounts none", async (t) => {
  const group = "repository:github:acme/app";
  const cache = cacheVolumeName(
    containerOwner(MASTER_KEY),
    "project_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    group,
  );
  const mounts = async (image: string) => {
    const runtime = recordingRuntime(t);
    const f = hostWith(
      true,
      () => ok(),
      () => Promise.resolve(image),
      (_slot, answered) => (answered === READY_TAG ? group : null),
    );
    const instance = f.driver.launch(launchOf(runtime.environment));
    const lines = await runtime.recorded();
    runtime.release();
    await instance.exited;
    return { lines, creates: f.verbs("volume") };
  };
  const grouped = await mounts(READY_TAG);
  assert.ok(grouped.lines.includes(`${cache}:/var/lib/kanthord/.cache`));
  assert.ok(grouped.creates.some((call) => call.args.includes(cache)));
  const plain = await mounts("kanthord:test");
  assert.equal(
    plain.lines.filter((line) => line === VOLUME_OPTION).length,
    ONE_CALL,
  );
  assert.ok(!plain.creates.some((call) => call.args.includes(cache)));
});

const VOLUME_OPTION = "--volume";
const VolumeAction = { List: "ls", Remove: "rm" } as const;
const VOLUME_PREFIX = "kanthord_slot_";
const LIVE_ID = "client_identity_live";
const ORPHAN_ID = "client_identity_orphan";
const OTHER_VOLUME = "unrelated_volume";

function volumeCalls(f: ReturnType<typeof hostWith>, action: string) {
  return f.verbs(Verb.Volume).filter((call) => call.args[1] === action);
}

test("removeVolume removes the volume of the slot and tolerates an absent volume", async () => {
  const f = hostWith(true, () =>
    Promise.resolve({
      code: FAILED_CODE,
      stdout: "",
      stderr: "Error: no such volume kanthord_slot_x",
    }),
  );
  await f.driver.removeVolume(LIVE_ID);
  assert.deepEqual(volumeCalls(f, VolumeAction.Remove)[0]?.args, [
    "volume",
    "rm",
    `${VOLUME_PREFIX}${LIVE_ID}`,
  ]);
});

test("removeVolume rejects when the runtime refuses the removal", async () => {
  const f = hostWith(true, () => refused());
  await assert.rejects(f.driver.removeVolume(LIVE_ID), /volume rm/);
});

test("removeVolume and sweepVolumes with no runtime do nothing and log nothing", async (t) => {
  const writes: string[] = [];
  for (const stream of [process.stdout, process.stderr])
    t.mock.method(stream, "write", (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
  const f = hostWith(false, () => ok());
  await f.driver.removeVolume(LIVE_ID);
  await f.driver.sweepVolumes(new Set());
  assert.deepEqual(f.calls, []);
  assert.deepEqual(writes, []);
});

test("sweepVolumes removes each owner volume of no live identity and only that volume", async () => {
  const names = [
    `${VOLUME_PREFIX}${LIVE_ID}`,
    `${VOLUME_PREFIX}${ORPHAN_ID}`,
    OTHER_VOLUME,
  ].join("\n");
  const f = hostWith(true, (call) =>
    call.args[1] === VolumeAction.List ? ok(names) : ok(),
  );
  await f.driver.sweepVolumes(new Set([LIVE_ID]));
  assert.equal(volumeCalls(f, VolumeAction.List).length, ONE_CALL);
  assert.ok(
    volumeCalls(f, VolumeAction.List)[0]?.args.some((arg) =>
      arg.startsWith("label=io.kanthord.owner="),
    ),
  );
  assert.deepEqual(
    volumeCalls(f, VolumeAction.Remove).map((call) => call.args[2]),
    [`${VOLUME_PREFIX}${ORPHAN_ID}`],
  );
});

test("sweepVolumes keeps a cache volume", async () => {
  const cache = cacheVolumeName("OWNER", "project", "resource");
  const names = [`${VOLUME_PREFIX}${ORPHAN_ID}`, cache].join("\n");
  const f = hostWith(true, (call) =>
    call.args[1] === VolumeAction.List ? ok(names) : ok(),
  );
  await f.driver.sweepVolumes(new Set());
  assert.deepEqual(
    volumeCalls(f, VolumeAction.Remove).map((call) => call.args[2]),
    [`${VOLUME_PREFIX}${ORPHAN_ID}`],
  );
});

test("sweepVolumes rejects when the listing fails", async () => {
  const f = hostWith(true, () => refused());
  await assert.rejects(f.driver.sweepVolumes(new Set()), /volume ls/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";
import { MessageChannel } from "node:worker_threads";
import { ContainerRuntime, PoolPlacement } from "../../worker/contract.ts";
import { ContainerDriver } from "./container-driver.ts";
import {
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
} as const;
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
  });
  const verbs = (verb: string) => calls.filter((call) => call.verb === verb);
  return { driver, calls, verbs };
}

function launchOf(): SlotLaunch {
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
    environment: {},
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

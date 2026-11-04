import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { httpClient } from "../../gateway/client.ts";
import { CancellationContext } from "../../kernel/context.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { stopAfter, temporary } from "../../kernel/test-support.ts";
import { SESSION_ENTRY_FULL_MAX_BYTES } from "../../tracking/contract.ts";
import {
  InstancePlacement,
  type SessionRead,
  SessionReadOutcome,
  workerOperations,
} from "../../worker/contract.ts";
import { sessionRootOf } from "../../worker/unit/index.ts";
import { Worker } from "../worker/index.ts";
import { directories } from "../../kernel/xdg.ts";
import { completed } from "./cli-test-support.ts";
import { gatewayFixture } from "./test-support.ts";

const INSTANCE = "laptop";
const WORKERS_DIRECTORY = "workers";
const SESSION_ID = "0123456789abcdef";
const ENTRY_ID = "a1b2c3d4";
const LARGE_ENTRY_ID = "b1b2c3d4";
const ABOVE_ENTRY_ID = "c1b2c3d4";
const ENTRY_TYPE = "message";
const FAST_HEARTBEAT_MS = 50;
const SLOW_INTERVAL_MS = 3600000;
const POLL_MS = 20;
const READ_TIMEOUT_MS = 20000;
const ONE_BYTE = 1;
const ONE_RAISE = 1;
const ENTRY_TEXT = "the full entry text";

function sizedEntry(id: string, bytes: number): Record<string, unknown> {
  const empty = JSON.stringify({ type: ENTRY_TYPE, id, pad: "" });
  return {
    type: ENTRY_TYPE,
    id,
    pad: "x".repeat(bytes - Buffer.byteLength(empty, "utf8")),
  };
}

async function liveInstance(t: TestContext) {
  const f = await gatewayFixture(t);
  const worker = httpClient(workerOperations, f.endpoint, f.token);
  const created = completed(
    await worker["instance.create"]({
      params: {},
      query: {},
      body: {
        name: INSTANCE,
        worker: "coder@1",
        placement: InstancePlacement.Worker,
        endpoint: f.endpoint,
      },
    }),
  );
  assert.ok(created.instance_configuration);
  const root = temporary(t);
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
    KANTHORD_WORKER_CONFIG: created.instance_configuration,
  };
  const executionId = createIdentity("execution");
  const directory = join(
    sessionRootOf(join(directories(env).data, WORKERS_DIRECTORY, INSTANCE)),
    "execution",
    executionId,
  );
  mkdirSync(directory, { recursive: true });
  const sessionFile = join(
    directory,
    `2026-11-04T00-00-00-000Z_${SESSION_ID}.jsonl`,
  );
  const records: string[] = [];
  const instance = new Worker({
    env,
    connectionName: "host-a",
    heartbeatIntervalMs: FAST_HEARTBEAT_MS,
    renewalIntervalMs: SLOW_INTERVAL_MS,
    log: (line) => records.push(line),
  });
  const context = new CancellationContext();
  const running = instance.run(context);
  stopAfter(t, async () => {
    context.cancel();
    await running;
  });
  while (!f.worker.instanceConnected(INSTANCE))
    await delay(POLL_MS, undefined, { signal: t.signal });
  const runtime = createIdentity("worker_registration");
  f.store.transaction((tx) =>
    tx.database
      .prepare(
        "INSERT INTO worker_registration (id, project_id, resource_identity, client_id, client_name, instance_id, registered_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(
        runtime,
        createIdentity("project"),
        "worker:kanthord:coder",
        createIdentity("client_identity"),
        "coder-1",
        created.id,
        Date.now(),
      ),
  );
  const read = (entryId: string): Promise<unknown> => {
    const sessionRead: SessionRead = {
      execution_id: executionId,
      session_id: SESSION_ID,
      entry_id: entryId,
      entry_type: ENTRY_TYPE,
    };
    return f.worker.readSessionEntry(
      runtime,
      sessionRead,
      AbortSignal.timeout(READ_TIMEOUT_MS),
    );
  };
  return { f, sessionFile, read, records };
}

test("a worker instance serves a session read through the heartbeat, the work read and the report", async (t) => {
  const { f, sessionFile, read, records } = await liveInstance(t);
  const entry = {
    type: ENTRY_TYPE,
    id: ENTRY_ID,
    parentId: null,
    message: {
      role: "assistant",
      content: [{ type: "text", text: ENTRY_TEXT }],
    },
  };
  writeFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
  const target = { instance: INSTANCE, placement: InstancePlacement.Worker };
  const version = f.worker.instances.workVersionOf(INSTANCE);
  assert.deepEqual(await read(ENTRY_ID), {
    result: { outcome: SessionReadOutcome.Resolved, entry },
    ...target,
  });
  assert.equal(f.worker.instances.workVersionOf(INSTANCE), version + ONE_RAISE);
  assert.deepEqual(await read("d1b2c3d4"), {
    result: { outcome: SessionReadOutcome.EntryAbsent },
    ...target,
  });
  const text = JSON.stringify([records, f.logs]);
  assert.ok(!text.includes(ENTRY_TEXT));
});

test("an entry of exactly the full entry bound resolves through the report body and one byte more answers too_large", async (t) => {
  const { sessionFile, read } = await liveInstance(t);
  const atBound = sizedEntry(LARGE_ENTRY_ID, SESSION_ENTRY_FULL_MAX_BYTES);
  const aboveBound = sizedEntry(
    ABOVE_ENTRY_ID,
    SESSION_ENTRY_FULL_MAX_BYTES + ONE_BYTE,
  );
  const atLine = JSON.stringify(atBound);
  const aboveLine = JSON.stringify(aboveBound);
  assert.equal(Buffer.byteLength(atLine, "utf8"), SESSION_ENTRY_FULL_MAX_BYTES);
  writeFileSync(sessionFile, `${atLine}\n${aboveLine}\n`);
  const resolved = (await read(LARGE_ENTRY_ID)) as {
    result: { outcome: string; entry: Record<string, unknown> };
  };
  assert.equal(resolved.result.outcome, SessionReadOutcome.Resolved);
  assert.equal(
    Buffer.byteLength(JSON.stringify(resolved.result.entry), "utf8"),
    SESSION_ENTRY_FULL_MAX_BYTES,
  );
  assert.deepEqual(
    ((await read(ABOVE_ENTRY_ID)) as { result: unknown }).result,
    {
      outcome: SessionReadOutcome.TooLarge,
      bytes: SESSION_ENTRY_FULL_MAX_BYTES + ONE_BYTE,
    },
  );
});

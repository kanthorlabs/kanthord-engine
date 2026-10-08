import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import pino, { type Logger } from "pino";
import { IdentityKind, type ServiceIdentity } from "../kernel/caller.ts";
import { background } from "../kernel/context.ts";
import { canonicalJSON } from "../kernel/json.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { temporary } from "../kernel/test-support.ts";
import {
  Consumer,
  ERROR_ARRAY_MAX_BYTES,
  INTAKE_SERVICE_NAME,
  InboundEventState,
  InboundKind,
  InboundPlatform,
  type ErrorItem,
  type IntakeConsumers,
} from "./contract.ts";
import { Dispatcher, nextCandidate, reserve } from "./dispatcher.ts";
import {
  eventRecord,
  insertEvent,
  readEventProjection,
} from "./event-store.ts";
import { allocateInboundId, insertInbound } from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";
import type { ConsumerCall } from "./test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RESOURCE = "owner/gated";
const CREATED_AT = 1000;
const CONTENT = '{"action":"closed","number":1}';
const METADATA = { event: "pull_request" };
const IDENTITY: ServiceIdentity = {
  kind: IdentityKind.Service,
  service: INTAKE_SERVICE_NAME,
};
const SECRET = "ghp_fakeCredentialMaterialValue";
const INDETERMINATE = "indeterminate";
const DEFECT = "system.operation.unknown";
const TIMEOUT = "gateway.invocation.timeout";
const CLAIM_LIVE = "mission.node.claim_live";
const MATCH_CHANGED = "mission.delivery.match_changed";
const REQUEST_ID = "request_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CONFLICT = 409;
const GATEWAY_TIMEOUT = 504;
const OK = 200;
const NO_CALLS = 0;
const ONE_CALL = 1;
const TWO_CALLS = 2;
const THREE_EVENTS = 3;
const FILL_MESSAGE_LENGTH = 100;
const WAKE_OFFSETS = 12;
const EVENT_ENCODING = "base64";

type Answer = () => Promise<OperationResult<unknown>>;

interface Harness {
  store: Store;
  dispatcher: Dispatcher;
  calls: ConsumerCall[];
  lines: string[];
  answers: Answer[];
  inboundId: string;
}

function migrate(store: Store): void {
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
}

function addInbound(store: Store): string {
  const id = allocateInboundId();
  store.transaction((tx) =>
    insertInbound(tx, id, {
      project_id: PROJECT_ID,
      kind: InboundKind.Webhook,
      platform: InboundPlatform.GitHub,
      consumer: Consumer.MissionDeliveryAdmit,
      credential: null,
      configuration: { resource: RESOURCE },
      checkpoint: null,
      created_at: CREATED_AT,
    }),
  );
  return id;
}

function addEvent(store: Store, inboundId: string, eventId: string): string {
  return store.transaction((tx) =>
    insertEvent(tx, {
      inbound_id: inboundId,
      event_id: eventId,
      event: Buffer.from(CONTENT),
      metadata: METADATA,
      created_at: CREATED_AT,
    }),
  );
}

function completed(data: unknown): Answer {
  return () =>
    Promise.resolve({ type: OperationResultType.Completed, status: OK, data });
}

function failure(status: number, code: string, message: string): Answer {
  return () =>
    Promise.resolve({
      type: OperationResultType.Failure,
      status,
      error: {
        error: { code, message, details: null },
        request_id: REQUEST_ID,
      },
    });
}

function indeterminate(): Answer {
  return () => Promise.resolve({ type: OperationResultType.Indeterminate });
}

function consumersOf(
  calls: ConsumerCall[],
  answers: Answer[],
): IntakeConsumers {
  return {
    [Consumer.MissionDeliveryAdmit]: (input, options) => {
      calls.push({ consumer: Consumer.MissionDeliveryAdmit, input, options });
      const answer = answers.shift();
      assert.ok(answer !== undefined, "Each call has a scripted answer.");
      return answer();
    },
  };
}

function dispatcherOver(
  store: Store,
  logger: Logger,
  consumers: IntakeConsumers,
): Dispatcher {
  return new Dispatcher({
    store,
    logger,
    identity: IDENTITY,
    consumers,
    context: background,
  });
}

function memoryStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  migrate(store);
  return store;
}

function harness(t: TestContext): Harness {
  const store = memoryStore(t);
  const lines: string[] = [];
  const logger = pino(
    { level: "trace" },
    { write: (line) => lines.push(line) },
  );
  const calls: ConsumerCall[] = [];
  const answers: Answer[] = [];
  const dispatcher = dispatcherOver(store, logger, consumersOf(calls, answers));
  return {
    store,
    dispatcher,
    calls,
    lines,
    answers,
    inboundId: addInbound(store),
  };
}

function recordOf(store: Store, id: string) {
  return store.transaction((tx) => eventRecord(readEventProjection(tx, id)!));
}

function retry(store: Store, id: string): void {
  store.database
    .prepare(
      "UPDATE intake_inbound_event SET state = ? WHERE id = ? AND state = ?",
    )
    .run(InboundEventState.Pending, id, InboundEventState.Failed);
}

async function handOver(h: Harness): Promise<void> {
  h.dispatcher.wake();
  await h.dispatcher.join();
}

test("A reservation adds the oldest pending candidate, and the next candidate skips it", (t) => {
  const store = memoryStore(t);
  const inboundId = addInbound(store);
  const [first, second] = ["d-1", "d-2"]
    .map((d) => addEvent(store, inboundId, d))
    .sort();
  const inFlight = new Set<string>();
  const candidate = store.transaction((tx) => nextCandidate(tx, inFlight));
  assert.equal(candidate, first);
  assert.ok(store.transaction((tx) => reserve(tx, inFlight, first!)));
  assert.deepEqual([...inFlight], [first]);
  assert.equal(
    store.transaction((tx) => nextCandidate(tx, inFlight)),
    second,
  );
});

test("A discard that wins before the reservation starts no handoff", async (t) => {
  const h = harness(t);
  const id = addEvent(h.store, h.inboundId, "d-1");
  const inFlight = new Set<string>();
  const candidate = h.store.transaction((tx) => nextCandidate(tx, inFlight));
  assert.equal(candidate, id);
  h.store.database
    .prepare("UPDATE intake_inbound_event SET state = ? WHERE id = ?")
    .run(InboundEventState.Discarded, id);
  assert.equal(
    h.store.transaction((tx) => reserve(tx, inFlight, id)),
    false,
  );
  assert.equal(inFlight.size, NO_CALLS);
  await handOver(h);
  assert.equal(h.calls.length, NO_CALLS);
  assert.equal(recordOf(h.store, id).state, InboundEventState.Discarded);
});

test("Pending events at a start reach the consumer in the order of id, each once", async (t) => {
  const h = harness(t);
  const ids = ["d-1", "d-2", "d-3"].map((d) =>
    addEvent(h.store, h.inboundId, d),
  );
  for (let index = 0; index < THREE_EVENTS; index++)
    h.answers.push(completed({ disposition: "refused", reason: "unmatched" }));
  await handOver(h);
  assert.deepEqual(
    h.calls.map((call) => call.input.inbound_event_id),
    [...ids].sort(),
  );
  for (const id of ids)
    assert.equal(recordOf(h.store, id).state, InboundEventState.Succeeded);
});

test("The handoff input holds the event row and its inbound, under the service identity", async (t) => {
  const h = harness(t);
  const id = addEvent(h.store, h.inboundId, "d-1");
  h.answers.push(completed({ disposition: "duplicate", reason: null }));
  await handOver(h);
  assert.deepEqual(h.calls[0]?.input, {
    inbound_event_id: id,
    project_id: PROJECT_ID,
    platform: InboundPlatform.GitHub,
    resource: RESOURCE,
    event: Buffer.from(CONTENT).toString(EVENT_ENCODING),
    metadata: METADATA,
  });
  assert.deepEqual(h.calls[0]?.options.identity, IDENTITY);
  assert.equal(h.calls[0]?.options.context, background);
  assert.ok(h.calls[0]?.options.idempotencyKey);
  assert.equal(recordOf(h.store, id).error, null);
});

test("Repeated wakes during a handoff start no second handoff of the event", async (t) => {
  const h = harness(t);
  const id = addEvent(h.store, h.inboundId, "d-1");
  const answer = Promise.withResolvers<OperationResult<unknown>>();
  h.answers.push(() => answer.promise);
  h.dispatcher.wake();
  await tick();
  h.dispatcher.wake();
  h.dispatcher.wake();
  await tick();
  assert.equal(h.calls.length, ONE_CALL);
  assert.ok(h.dispatcher.inFlight(id));
  answer.resolve({ type: OperationResultType.Completed, status: OK, data: {} });
  await h.dispatcher.join();
  assert.equal(h.calls.length, ONE_CALL);
  assert.ok(!h.dispatcher.inFlight(id));
  assert.equal(recordOf(h.store, id).state, InboundEventState.Succeeded);
});

test("A wake at any microtask of an ending drain hands the new event over", async (t) => {
  const h = harness(t);
  for (let offset = 0; offset < WAKE_OFFSETS; offset++) {
    h.dispatcher.wake();
    for (let step = 0; step < offset; step++) await Promise.resolve();
    const id = addEvent(h.store, h.inboundId, `d-${offset}`);
    h.answers.push(completed({ disposition: "duplicate", reason: null }));
    h.dispatcher.wake();
    await h.dispatcher.join();
    assert.equal(recordOf(h.store, id).state, InboundEventState.Succeeded);
  }
  assert.equal(h.calls.length, WAKE_OFFSETS);
});

test("A 409 claim_live or match_changed answer sets failed with that code", async (t) => {
  const h = harness(t);
  for (const code of [CLAIM_LIVE, MATCH_CHANGED]) {
    const id = addEvent(h.store, h.inboundId, code);
    h.answers.push(failure(CONFLICT, code, "The admission refused."));
    await handOver(h);
    const record = recordOf(h.store, id);
    assert.equal(record.state, InboundEventState.Failed);
    assert.deepEqual(
      record.error?.map((item) => item.code),
      [code],
    );
  }
});

test("Two failures and one retry leave two error items; a failed event stays untouched without a retry", async (t) => {
  const h = harness(t);
  const id = addEvent(h.store, h.inboundId, "d-1");
  h.answers.push(failure(CONFLICT, CLAIM_LIVE, "A claim is live."));
  await handOver(h);
  await handOver(h);
  assert.equal(h.calls.length, ONE_CALL);
  assert.equal(recordOf(h.store, id).error?.length, ONE_CALL);
  retry(h.store, id);
  h.answers.push(failure(CONFLICT, MATCH_CHANGED, "The match changed."));
  await handOver(h);
  const record = recordOf(h.store, id);
  assert.equal(record.state, InboundEventState.Failed);
  assert.deepEqual(
    record.error?.map((item) => item.code),
    [CLAIM_LIVE, MATCH_CHANGED],
  );
});

test("An append to a full error array drops the oldest item and sets failed", async (t) => {
  const h = harness(t);
  const id = addEvent(h.store, h.inboundId, "d-1");
  const items = fullErrorArray();
  h.store.database
    .prepare("UPDATE intake_inbound_event SET error = ? WHERE id = ?")
    .run(canonicalJSON(items), id);
  h.answers.push(indeterminate());
  await handOver(h);
  const record = recordOf(h.store, id);
  assert.equal(record.state, InboundEventState.Failed);
  assert.deepEqual(record.error?.[0], items[1]);
  assert.equal(record.error?.at(-1)?.code, INDETERMINATE);
});

function fullErrorArray(): ErrorItem[] {
  const items: ErrorItem[] = [];
  for (let index = 0; index < ERROR_ARRAY_MAX_BYTES; index++) {
    const next = {
      code: `old_${index}`,
      message: "x".repeat(FILL_MESSAGE_LENGTH),
      created_at: index,
    };
    if (canonicalJSON([...items, next]).length > ERROR_ARRAY_MAX_BYTES) break;
    items.push(next);
  }
  return items;
}

test("An indeterminate answer sets failed with the code indeterminate", async (t) => {
  const h = harness(t);
  const id = addEvent(h.store, h.inboundId, "d-1");
  h.answers.push(indeterminate());
  await handOver(h);
  const record = recordOf(h.store, id);
  assert.equal(record.state, InboundEventState.Failed);
  assert.deepEqual(
    record.error?.map((item) => item.code),
    [INDETERMINATE],
  );
});

test("A first handoff and one after a retry carry two keys and one event identity and content", async (t) => {
  const h = harness(t);
  const id = addEvent(h.store, h.inboundId, "d-1");
  h.answers.push(indeterminate());
  await handOver(h);
  retry(h.store, id);
  h.answers.push(completed({ disposition: "duplicate", reason: null }));
  await handOver(h);
  assert.equal(h.calls.length, TWO_CALLS);
  const [first, second] = h.calls;
  assert.deepEqual(first?.input, second?.input);
  assert.equal(first?.input.inbound_event_id, id);
  assert.ok(first?.options.idempotencyKey);
  assert.notEqual(
    first?.options.idempotencyKey,
    second?.options.idempotencyKey,
  );
});

test("A timeout or an indeterminate answer sets failed, and the retry answers duplicate", async (t) => {
  const h = harness(t);
  const cases: [string, Answer][] = [
    [TIMEOUT, failure(GATEWAY_TIMEOUT, TIMEOUT, "Request timed out.")],
    [INDETERMINATE, indeterminate()],
  ];
  for (const [code, answer] of cases) {
    const id = addEvent(h.store, h.inboundId, code);
    h.answers.push(answer);
    await handOver(h);
    assert.equal(recordOf(h.store, id).state, InboundEventState.Failed);
    retry(h.store, id);
    h.answers.push(completed({ disposition: "duplicate", reason: null }));
    await handOver(h);
    const record = recordOf(h.store, id);
    assert.equal(record.state, InboundEventState.Succeeded);
    assert.deepEqual(
      record.error?.map((item) => item.code),
      [code],
    );
  }
});

test("A thrown consumer call writes failed with system.operation.unknown and no credential material", async (t) => {
  const h = harness(t);
  const id = addEvent(h.store, h.inboundId, "d-1");
  h.answers.push(() => Promise.reject(new Error(`token ${SECRET} leaked`)));
  await handOver(h);
  assert.ok(!h.dispatcher.inFlight(id));
  const record = recordOf(h.store, id);
  assert.equal(record.state, InboundEventState.Failed);
  assert.deepEqual(
    record.error?.map((item) => item.code),
    [DEFECT],
  );
  assert.ok(!canonicalJSON(record.error).includes(SECRET));
  assert.ok(!h.lines.join("").includes(SECRET));
  await handOver(h);
  assert.equal(h.calls.length, ONE_CALL);
});

test("A start hands an event over again after a kill of the process during its handoff", async (t) => {
  const path = join(temporary(t), "kanthord.db");
  const seed = new Store(path);
  migrate(seed);
  const id = addEvent(seed, addInbound(seed), "d-1");
  seed.close();
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", childScript(path)],
    { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const first = await firstLine(child.stdout);
  const report = JSON.parse(first) as {
    input: ConsumerCall["input"];
    key: string;
    state: string;
  };
  assert.equal(report.state, InboundEventState.Pending);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  const store = new Store(path);
  t.after(() => store.close());
  const calls: ConsumerCall[] = [];
  const dispatcher = dispatcherOver(
    store,
    pino({ enabled: false }),
    consumersOf(calls, [completed({ disposition: "duplicate", reason: null })]),
  );
  dispatcher.wake();
  await dispatcher.join();
  assert.equal(calls.length, ONE_CALL);
  assert.deepEqual(calls[0]?.input, report.input);
  assert.equal(calls[0]?.input.inbound_event_id, id);
  assert.notEqual(calls[0]?.options.idempotencyKey, report.key);
  assert.equal(recordOf(store, id).state, InboundEventState.Succeeded);
});

function childScript(path: string): string {
  const url = (file: string) =>
    pathToFileURL(join(import.meta.dirname, file)).href;
  return `
const { Store } = await import(${JSON.stringify(url("../kernel/store.ts"))});
const { background } = await import(${JSON.stringify(url("../kernel/context.ts"))});
const { Dispatcher } = await import(${JSON.stringify(url("./dispatcher.ts"))});
const { default: pino } = await import("pino");
const store = new Store(${JSON.stringify(path)});
setInterval(() => {}, 1000);
const dispatcher = new Dispatcher({
  store,
  logger: pino({ enabled: false }),
  identity: ${JSON.stringify(IDENTITY)},
  context: background,
  consumers: {
    ${JSON.stringify(Consumer.MissionDeliveryAdmit)}: (input, options) => {
      const { state } = store.database
        .prepare("SELECT state FROM intake_inbound_event WHERE id = ?")
        .get(input.inbound_event_id);
      process.stdout.write(JSON.stringify({ input, key: options.idempotencyKey, state }) + "\\n");
      return new Promise(() => {});
    },
  },
});
dispatcher.wake();
`;
}

async function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += String(chunk);
    const end = text.indexOf("\n");
    if (end >= NO_CALLS) return text.slice(0, end);
  }
  throw new Error("The child ended before it reported a handoff.");
}

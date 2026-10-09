import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { IdentityKind } from "../kernel/caller.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  Consumer,
  INTAKE_SERVICE_NAME,
  InboundEventState,
  InboundKind,
  InboundPlatform,
  IntakeErrorCode,
  intakeOperations,
  type InboundKindValue,
} from "./contract.ts";
import { IntakeService } from "./index.ts";
import { allocateInboundId, insertInbound } from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";
import { unusedActionDependencies } from "./test-support.ts";
import { webhookSecret } from "./webhook-secret.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UNKNOWN_INBOUND_ID = "inbound_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREATED_AT = 100;
const PENDING_EVENT_LIMIT = 2;
const PUSH = '{"ref":"refs/heads/main","repository":{"full_name":"acme/app"}}';
const PING = "{}";
const VALIDATION_FAILED = "gateway.request.validation_failed";
const ZERO_DIGEST = "0".repeat(64);
const SHORT_DIGEST = "a".repeat(62);
const NON_HEX_DIGEST = "z".repeat(64);
const UNSTORED_ROW_COUNT = 0;
const WAKES_PER_DELIVERY = 1;
const ROWS_PER_DELIVERY = 1;
const WAKES_AFTER_REFUSAL = 0;
const ACKNOWLEDGEMENT_BODY = "";
const FIRST_DELIVERY = "d-1";

interface Outcome {
  status: number;
  code: string | null;
}

interface EventRow {
  event_id: string;
  event: Uint8Array;
  metadata: string;
  state: string;
}

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function harness(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  const logs: string[] = [];
  const dependencies = unusedActionDependencies();
  const intake = new IntakeService({
    store,
    logger: pino({ level: "trace" }, { write: (line) => logs.push(line) }),
    health: new HealthRegistry(),
    identity: { kind: IdentityKind.Service, service: INTAKE_SERVICE_NAME },
    ...dependencies,
    pendingEventLimit: PENDING_EVENT_LIMIT,
  });
  let wakes = 0;
  intake.wake = () => {
    wakes += 1;
  };
  let failCommit = false;
  const registry = new OperationRegistry();
  intake.declare(registry);
  const addInbound = (kind: InboundKindValue = InboundKind.Webhook) => {
    const id = allocateInboundId();
    store.transaction((tx) =>
      insertInbound(tx, id, {
        project_id: PROJECT_ID,
        kind,
        platform: InboundPlatform.GitHub,
        consumer: Consumer.MissionDeliveryAdmit,
        credential: kind === InboundKind.Poll ? "github-token" : null,
        configuration: { resource: "acme/app" },
        checkpoint: null,
        created_at: CREATED_AT,
      }),
    );
    return { id, secret: webhookSecret(dependencies.masterKey, id) };
  };
  const receive = async (
    inboundId: string,
    headers: Headers,
    body: string | Uint8Array,
  ): Promise<Outcome> => {
    const caller: CallerContext = {
      context: background,
      requestId: createIdentity("request"),
      delivery: { bytes: Uint8Array.from(Buffer.from(body)).buffer, headers },
      commit: (write) => {
        if (failCommit) throw new Error("commit refused");
        return store.transaction(write);
      },
    };
    const operation = intakeOperations["inbound.event.receive"];
    try {
      const answer = await registry
        .get(operation.id)
        .handler(
          { params: { inbound_id: inboundId }, query: {}, body: null },
          caller,
        );
      assert.ok(answer instanceof Response);
      assert.equal(await answer.text(), ACKNOWLEDGEMENT_BODY);
      return { status: answer.status, code: null };
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      return { status: error.status, code: error.code };
    }
  };
  const remove = async (inboundId: string): Promise<Outcome> => {
    const operation = intakeOperations["inbound.delete"];
    const caller: CallerContext = {
      context: background,
      requestId: createIdentity("request"),
      commit: (write) => store.transaction(write),
    };
    try {
      await registry
        .get(operation.id)
        .handler(
          { params: { inbound_id: inboundId }, query: {}, body: null },
          caller,
        );
      return { status: HttpStatus.NoContent, code: null };
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      return { status: error.status, code: error.code };
    }
  };
  const github = (event: string, delivery: string, signature?: string) => {
    const headers = new Headers({
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
    });
    if (signature !== undefined) headers.set("x-hub-signature-256", signature);
    return headers;
  };
  const rows = (inboundId: string) =>
    store.transaction(
      (tx) =>
        tx.database
          .prepare(
            "SELECT event_id, event, metadata, state FROM intake_inbound_event WHERE inbound_id = ? ORDER BY id",
          )
          .all(inboundId) as unknown as EventRow[],
    );
  return {
    addInbound,
    receive,
    remove,
    github,
    rows,
    logs,
    wakes: () => wakes,
    failCommits: () => {
      failCommit = true;
    },
  };
}

const SIGNATURE_INVALID = {
  status: HttpStatus.Unauthorized,
  code: IntakeErrorCode.InboundEventSignatureInvalid,
};

test("a missing, duplicate, malformed, wrong-length or wrong signature answers 401 and stores nothing", async (t) => {
  const h = harness(t);
  const { id, secret } = h.addInbound();
  const valid = sign(secret, PUSH);
  const duplicate = h.github("push", "d-1", valid);
  duplicate.append("x-hub-signature-256", valid);
  const refusals = [
    h.github("push", "d-1"),
    duplicate,
    h.github("push", "d-1", valid.slice("sha256=".length)),
    h.github("push", "d-1", `sha1=${valid.slice("sha256=".length)}`),
    h.github("push", "d-1", `sha256=${NON_HEX_DIGEST}`),
    h.github("push", "d-1", `sha256=${SHORT_DIGEST}`),
    h.github("push", "d-1", `${valid}00`),
    h.github("push", "d-1", `sha256=${ZERO_DIGEST}`),
  ];
  for (const headers of refusals)
    assert.deepEqual(await h.receive(id, headers, PUSH), SIGNATURE_INVALID);
  assert.deepEqual(
    await h.receive(id, h.github("push", "d-1", valid), `${PUSH} `),
    SIGNATURE_INVALID,
  );
  assert.equal(h.rows(id).length, UNSTORED_ROW_COUNT);
  assert.equal(h.wakes(), WAKES_AFTER_REFUSAL);
});

test("a valid signature over the exact bytes stores one pending row and wakes after the commit", async (t) => {
  const h = harness(t);
  const { id, secret } = h.addInbound();
  const body = '{ "b" : 1,\r\n"a":2.0 }\n';
  assert.deepEqual(
    await h.receive(id, h.github("push", "d-1", sign(secret, body)), body),
    { status: HttpStatus.Accepted, code: null },
  );
  const stored = h.rows(id);
  assert.equal(stored.length, ROWS_PER_DELIVERY);
  assert.equal(stored[0]!.event_id, FIRST_DELIVERY);
  assert.equal(Buffer.from(stored[0]!.event).toString(), body);
  assert.deepEqual(JSON.parse(stored[0]!.metadata), { event: "push" });
  assert.equal(stored[0]!.state, InboundEventState.Pending);
  assert.equal(h.wakes(), WAKES_PER_DELIVERY);
  assert.ok(h.logs.every((line) => !line.includes(secret)));
});

test("a redelivery answers 202 and keeps one unchanged row, also at the bound", async (t) => {
  const h = harness(t);
  const { id, secret } = h.addInbound();
  const accepted = { status: HttpStatus.Accepted, code: null };
  const deliver = (delivery: string, body: string) =>
    h.receive(id, h.github("push", delivery, sign(secret, body)), body);
  assert.deepEqual(await deliver("d-1", PUSH), accepted);
  assert.deepEqual(await deliver("d-1", `${PUSH}\n`), accepted);
  assert.equal(h.rows(id).length, ROWS_PER_DELIVERY);
  assert.deepEqual(await deliver("d-2", PUSH), accepted);
  assert.deepEqual(await deliver("d-1", `${PUSH}\n\n`), accepted);
  const stored = h.rows(id);
  assert.equal(stored.length, PENDING_EVENT_LIMIT);
  assert.equal(Buffer.from(stored[0]!.event).toString(), PUSH);
  assert.deepEqual(await deliver("d-3", PUSH), {
    status: HttpStatus.ServiceUnavailable,
    code: IntakeErrorCode.InboundEventCapacityExceeded,
  });
  assert.equal(h.rows(id).length, PENDING_EVENT_LIMIT);
});

test("a signed ping answers 204 below and at the bound with no row; an unsigned ping answers 401", async (t) => {
  const h = harness(t);
  const { id, secret } = h.addInbound();
  const handshake = { status: HttpStatus.NoContent, code: null };
  const ping = () =>
    h.receive(id, h.github("ping", "p-1", sign(secret, PING)), PING);
  assert.deepEqual(await ping(), handshake);
  assert.equal(h.rows(id).length, UNSTORED_ROW_COUNT);
  for (const delivery of ["d-1", "d-2"])
    await h.receive(id, h.github("push", delivery, sign(secret, PUSH)), PUSH);
  assert.deepEqual(await ping(), handshake);
  assert.equal(h.rows(id).length, PENDING_EVENT_LIMIT);
  assert.deepEqual(
    await h.receive(id, h.github("ping", "p-1"), PING),
    SIGNATURE_INVALID,
  );
  assert.equal(h.wakes(), PENDING_EVENT_LIMIT);
});

test("at the bound a new delivery answers 503 while a redelivery and a ping pass, and a pending event refuses the delete of the inbound", async (t) => {
  const h = harness(t);
  const { id, secret } = h.addInbound();
  const accepted = { status: HttpStatus.Accepted, code: null };
  const send = (event: string, delivery: string, body: string) =>
    h.receive(id, h.github(event, delivery, sign(secret, body)), body);
  assert.deepEqual(await send("push", "d-1", PUSH), accepted);
  assert.deepEqual(await send("push", "d-4", PUSH), accepted);
  assert.deepEqual(await send("push", "d-5", PUSH), {
    status: HttpStatus.ServiceUnavailable,
    code: IntakeErrorCode.InboundEventCapacityExceeded,
  });
  assert.deepEqual(await send("push", "d-1", PUSH), accepted);
  assert.deepEqual(await send("ping", "d-6", PING), {
    status: HttpStatus.NoContent,
    code: null,
  });
  assert.deepEqual(
    h
      .rows(id)
      .map((row) => [row.event_id, row.state])
      .sort(),
    [
      ["d-1", InboundEventState.Pending],
      ["d-4", InboundEventState.Pending],
    ],
  );
  assert.deepEqual(await h.remove(id), {
    status: HttpStatus.Conflict,
    code: IntakeErrorCode.InboundEventsPending,
  });
  assert.equal(h.rows(id).length, PENDING_EVENT_LIMIT);
});

test("a poll inbound, an unknown identity and an invalid identity answer 404", async (t) => {
  const h = harness(t);
  const poll = h.addInbound(InboundKind.Poll);
  const notFound = {
    status: HttpStatus.NotFound,
    code: IntakeErrorCode.InboundNotFound,
  };
  for (const id of [poll.id, UNKNOWN_INBOUND_ID, "inbound_bad"])
    assert.deepEqual(
      await h.receive(
        id,
        h.github("push", "d-1", sign(poll.secret, PUSH)),
        PUSH,
      ),
      notFound,
    );
  assert.equal(h.rows(poll.id).length, UNSTORED_ROW_COUNT);
});

test("a signed delivery without a delivery identity answers 400 and stores nothing", async (t) => {
  const h = harness(t);
  const { id, secret } = h.addInbound();
  const headers = h.github("push", "", sign(secret, PUSH));
  headers.delete("x-github-delivery");
  assert.deepEqual(await h.receive(id, headers, PUSH), {
    status: HttpStatus.BadRequest,
    code: VALIDATION_FAILED,
  });
  assert.equal(h.rows(id).length, UNSTORED_ROW_COUNT);
});

test("a commit failure answers no acknowledgement and stores nothing", async (t) => {
  const h = harness(t);
  const { id, secret } = h.addInbound();
  h.failCommits();
  await assert.rejects(
    h.receive(id, h.github("push", "d-1", sign(secret, PUSH)), PUSH),
    /commit refused/,
  );
  assert.equal(h.rows(id).length, UNSTORED_ROW_COUNT);
  assert.equal(h.wakes(), WAKES_AFTER_REFUSAL);
});

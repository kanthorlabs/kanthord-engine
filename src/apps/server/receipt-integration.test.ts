import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { test, type TestContext } from "node:test";
import { ulid } from "ulid";
import {
  IntakeErrorCode,
  intakeOperations,
  webhookInboundSchema,
} from "../../intake/contract.ts";
import { errorSchema } from "../../kernel/errors.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { projectOperations } from "../../project/contract.ts";
import { deliver, gatewayFixture } from "./test-support.ts";

const PUSH = '{ "ref" : "refs/heads/main",\r\n"after":"a" }\n';
const PING = "{}";
const FIRST_DELIVERY = "d-1";
const PENDING_EVENT_LIMIT = 1;
const NO_ROWS = 0;
const ONE_ROW = 1;
const INVOCATION_UNKNOWN = "gateway.invocation.unknown";

type Fixture = Awaited<ReturnType<typeof gatewayFixture>>;

async function webhookInbound(fixture: Fixture) {
  const authorization = `Bearer ${fixture.token}`;
  const mutation = (path: string, body: unknown) =>
    fixture.request(path, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        "Idempotency-Key": ulid(),
      },
      body: JSON.stringify(body),
    });
  const project = projectOperations.create.output.parse(
    await (
      await mutation(projectOperations.create.path, { name: "receipts" })
    ).json(),
  );
  const created = intakeOperations["inbound.create"].output.parse(
    await (
      await mutation(intakeOperations["inbound.create"].path, {
        project_id: project.id,
        kind: "webhook",
        platform: "github",
        consumer: "mission.delivery.admit",
        configuration: { resource: "owner/repo" },
      })
    ).json(),
  );
  const answer = await fixture.request(`/api/intake/inbound/${created.id}`, {
    headers: { Authorization: authorization },
  });
  assert.equal(answer.status, HttpStatus.OK);
  return webhookInboundSchema.parse(await answer.json());
}

function storedEvents(fixture: Fixture, inboundId: string) {
  return fixture.store.transaction(
    (tx) =>
      tx.database
        .prepare(
          "SELECT event_id, event, metadata FROM intake_inbound_event WHERE inbound_id = ? ORDER BY id",
        )
        .all(inboundId) as unknown as {
        event_id: string;
        event: Uint8Array;
        metadata: string;
      }[],
  );
}

function postWithTwoSignatureLines(
  fixture: Fixture,
  inboundId: string,
  signature: string,
): Promise<{ status: number; body: unknown }> {
  const { hostname, port } = new URL(fixture.endpoint);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname,
        port,
        method: "POST",
        path: `/hooks/${inboundId}`,
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "push",
          "X-GitHub-Delivery": "d-dup",
          "X-Hub-Signature-256": [signature, signature],
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("error", reject);
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode!,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(PUSH);
  });
}

function codeOf(body: unknown): string {
  return errorSchema.parse(body).error.code;
}

test("the receipt over HTTP verifies the exact bytes, stores once, keeps the bound and logs no secret", async (t: TestContext) => {
  const fixture = await gatewayFixture(t, {
    intake: { pendingEventLimit: PENDING_EVENT_LIMIT },
  });
  const inbound = await webhookInbound(fixture);
  const delivery = {
    inboundId: inbound.id,
    secret: inbound.secret,
    event: "push",
    deliveryId: FIRST_DELIVERY,
    body: PUSH,
  };
  const duplicate = await postWithTwoSignatureLines(
    fixture,
    inbound.id,
    `sha256=${createHmac("sha256", inbound.secret).update(PUSH).digest("hex")}`,
  );
  assert.equal(duplicate.status, HttpStatus.Unauthorized);
  assert.equal(
    codeOf(duplicate.body),
    IntakeErrorCode.InboundEventSignatureInvalid,
  );
  const unsigned = await deliver(fixture, { ...delivery, signature: null });
  assert.equal(unsigned.status, HttpStatus.Unauthorized);
  assert.equal(storedEvents(fixture, inbound.id).length, NO_ROWS);
  assert.deepEqual(await deliver(fixture, delivery), {
    status: HttpStatus.Accepted,
    body: null,
  });
  const stored = storedEvents(fixture, inbound.id);
  assert.equal(stored.length, ONE_ROW);
  assert.equal(stored[0]!.event_id, FIRST_DELIVERY);
  assert.equal(Buffer.from(stored[0]!.event).toString(), PUSH);
  assert.deepEqual(JSON.parse(stored[0]!.metadata), { event: "push" });
  assert.deepEqual(await deliver(fixture, delivery), {
    status: HttpStatus.Accepted,
    body: null,
  });
  const beyond = await deliver(fixture, { ...delivery, deliveryId: "d-2" });
  assert.equal(beyond.status, HttpStatus.ServiceUnavailable);
  assert.equal(
    codeOf(beyond.body),
    IntakeErrorCode.InboundEventCapacityExceeded,
  );
  assert.deepEqual(
    await deliver(fixture, {
      ...delivery,
      event: "ping",
      deliveryId: "p-1",
      body: PING,
    }),
    { status: HttpStatus.NoContent, body: null },
  );
  assert.equal(storedEvents(fixture, inbound.id).length, ONE_ROW);
  for (const line of fixture.logs)
    assert.equal(line.includes(inbound.secret), false);
});

test("a commit failure over HTTP answers 500 and stores nothing", async (t: TestContext) => {
  const fixture = await gatewayFixture(t);
  const inbound = await webhookInbound(fixture);
  fixture.store.transaction((tx) =>
    tx.database.exec(
      "CREATE TEMP TRIGGER refuse_event BEFORE INSERT ON intake_inbound_event BEGIN SELECT RAISE(ABORT, 'refused'); END",
    ),
  );
  const refused = await deliver(fixture, {
    inboundId: inbound.id,
    secret: inbound.secret,
    event: "push",
    deliveryId: FIRST_DELIVERY,
    body: PUSH,
  });
  assert.equal(refused.status, HttpStatus.InternalServerError);
  assert.equal(codeOf(refused.body), INVOCATION_UNKNOWN);
  assert.equal(storedEvents(fixture, inbound.id).length, NO_ROWS);
});

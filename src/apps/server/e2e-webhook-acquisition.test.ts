import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import {
  Consumer,
  InboundEventState,
  InboundKind,
  InboundPlatform,
  IntakeErrorCode,
  WEBHOOK_ADDRESS_PREFIX,
} from "../../intake/contract.ts";
import { errorSchema } from "../../kernel/errors.ts";
import { writePrivate } from "../../kernel/files.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { ulidSchema } from "../../kernel/identity.ts";
import { isString } from "../../kernel/values.ts";
import { temporary } from "../../kernel/test-support.ts";
import { environment, kanthord, until } from "./cli-support.ts";
import { deliver, gatewayFixture } from "./test-support.ts";

const ExitCode = { Success: 0, Failure: 1 } as const;
const EMPTY_OUTPUT = "";
const TIMEOUT = 180000;
const EVENTS_PER_DELIVERY = 1;
const RESOURCE = "owner/repo";
const PUSH_EVENT = "push";
const PING_EVENT = "ping";
const PUSH = `{"ref":"refs/heads/main","after":"${"a".repeat(40)}","repository":{"full_name":"owner/repo"}}`;
const PING = "{}";
const FIRST_DELIVERY = "d-1";
const ZERO_SIGNATURE = `sha256=${"0".repeat(64)}`;
const UNKNOWN_INBOUND = "inbound_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOT_FOUND = `${IntakeErrorCode.InboundNotFound}:`;
type Result = { code: number; stdout: string; stderr: string };
type Inbound = {
  id: string;
  credential: string | null;
  address?: string;
  secret?: string;
};
type Event = {
  id: string;
  event_id: string;
  metadata: Record<string, unknown>;
  state: string;
  error: unknown;
};

function succeeded<T>(result: Result): T {
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(result.stderr, EMPTY_OUTPUT);
  return JSON.parse(result.stdout) as T;
}

function refused(result: Result, prefix: string): void {
  assert.equal(result.code, ExitCode.Failure, result.stderr);
  assert.ok(result.stderr.startsWith(prefix), result.stderr);
  assert.equal(result.stdout, EMPTY_OUTPUT);
}

function codeOf(body: unknown): string {
  return errorSchema.parse(body).error.code;
}

test("E06 webhook acquisition journey", { timeout: TIMEOUT }, async (t) => {
  const fixture = await gatewayFixture(t);
  const directory = temporary(t);
  const H = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  const project = succeeded<{ id: string }>(
    await kanthord(["project", "create", "--name", "hooks"], H),
  );
  const hook = join(directory, "hook.json");
  writePrivate(
    hook,
    JSON.stringify({
      project_id: project.id,
      kind: InboundKind.Webhook,
      platform: InboundPlatform.GitHub,
      consumer: Consumer.MissionDeliveryAdmit,
      configuration: { resource: RESOURCE },
    }),
  );
  const inbound = (args: string[]) =>
    kanthord(["intake", "inbound", ...args], H);
  const inboundEvent = (args: string[]) =>
    kanthord(["intake", "event", ...args], H);
  let W = "";
  let S = "";
  const send = (
    event: string,
    deliveryId: string,
    body: string,
    signature?: string | null,
  ) =>
    deliver(fixture, {
      inboundId: W,
      secret: S,
      event,
      deliveryId,
      body,
      signature,
    });
  const events = async () =>
    succeeded<{ items: Event[] }>(await inboundEvent(["list", "--inbound", W]))
      .items;

  await t.test("E06.1 a webhook create answers the address", async () => {
    const created = succeeded<Inbound>(
      await inbound(["create", "--file", hook]),
    );
    assert.equal(created.credential, null);
    W = created.id;
    const one = succeeded<Inbound>(await inbound(["get", W]));
    assert.equal(one.address, `${WEBHOOK_ADDRESS_PREFIX}${W}`);
    assert.ok(isString(one.secret) && one.secret.length);
    S = one.secret;
  });

  await t.test(
    "E06.2 a signed push stores one event that the handoff settles",
    async () => {
      const delivered = await send(PUSH_EVENT, FIRST_DELIVERY, PUSH);
      assert.equal(delivered.status, HttpStatus.Accepted);
      const items = await until(
        events,
        (list) =>
          list.length === EVENTS_PER_DELIVERY &&
          list.every((item) => item.state === InboundEventState.Succeeded),
      );
      const [first] = items;
      assert.ok(first);
      assert.equal(first.event_id, FIRST_DELIVERY);
      assert.deepEqual(first.metadata, { event: PUSH_EVENT });
      assert.equal(first.error, null);
    },
  );

  await t.test("E06.3 a redelivery stores nothing", async () => {
    const delivered = await send(PUSH_EVENT, FIRST_DELIVERY, PUSH);
    assert.equal(delivered.status, HttpStatus.Accepted);
    assert.equal((await events()).length, EVENTS_PER_DELIVERY);
  });

  await t.test("E06.4 three bad signatures refuse", async () => {
    const pushSignature = `sha256=${createHmac("sha256", S).update(PUSH).digest("hex")}`;
    const attempts = [
      await send(PUSH_EVENT, FIRST_DELIVERY, PUSH, ZERO_SIGNATURE),
      await send(PUSH_EVENT, FIRST_DELIVERY, PUSH, null),
      await send(PUSH_EVENT, FIRST_DELIVERY, `${PUSH} `, pushSignature),
    ];
    for (const attempt of attempts) {
      assert.equal(attempt.status, HttpStatus.Unauthorized);
      assert.equal(
        codeOf(attempt.body),
        IntakeErrorCode.InboundEventSignatureInvalid,
      );
    }
    assert.equal((await events()).length, EVENTS_PER_DELIVERY);
  });

  await t.test("E06.5 a signed ping answers the handshake", async () => {
    assert.equal(
      (await send(PING_EVENT, "d-2", PING)).status,
      HttpStatus.NoContent,
    );
    assert.equal(
      (await send(PING_EVENT, "d-2", PING, null)).status,
      HttpStatus.Unauthorized,
    );
    assert.equal((await events()).length, EVENTS_PER_DELIVERY);
  });

  await t.test("E06.6 an unknown inbound answers 404", async () => {
    const delivered = await deliver(fixture, {
      inboundId: UNKNOWN_INBOUND,
      secret: S,
      event: PUSH_EVENT,
      deliveryId: "d-3",
      body: PUSH,
    });
    assert.equal(delivered.status, HttpStatus.NotFound);
    assert.equal(codeOf(delivered.body), IntakeErrorCode.InboundNotFound);
  });

  let W2 = "";

  await t.test("E06.10 a second create answers a new identity", async () => {
    const created = succeeded<Inbound>(
      await inbound(["create", "--file", hook]),
    );
    assert.equal(created.credential, null);
    assert.notEqual(created.id, W);
    W2 = created.id;
  });

  await t.test("E06.11 a delete without events removes W2", async () => {
    const deleted = succeeded<{ idempotency_key: string }>(
      await inbound(["delete", W2]),
    );
    assert.ok(ulidSchema.safeParse(deleted.idempotency_key).success);
    refused(await inbound(["get", W2]), NOT_FOUND);
  });
});

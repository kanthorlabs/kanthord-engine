import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  Consumer,
  InboundKind,
  InboundPlatform,
  WEBHOOK_ADDRESS_PREFIX,
} from "../../intake/contract.ts";
import { writePrivate } from "../../kernel/files.ts";
import { ulidSchema } from "../../kernel/identity.ts";
import { isString } from "../../kernel/values.ts";
import { temporary } from "../../kernel/test-support.ts";
import { environment, kanthord } from "./cli-support.ts";
import { gatewayFixture } from "./test-support.ts";

const ExitCode = { Success: 0, Failure: 1 } as const;
const EMPTY_OUTPUT = "";
const TIMEOUT = 180000;
const INBOUND = ["intake", "inbound"];
const UNKNOWN_PROJECT = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RESOURCE = "owner/repo";
const PROJECT_NOT_FOUND = "intake.inbound.project_not_found:";
const NOT_FOUND = "intake.inbound.not_found:";
const VALIDATION_FAILED = "gateway.request.validation_failed:";
const INVALID_ID = "cli.intake.inbound.get.invalid_inbound_id:";
const SCHEMA_INVALID = "cli.file.schema_invalid:";
const INBOUND_ID_PATTERN = /^inbound_/;
type Result = { code: number; stdout: string; stderr: string };
type Inbound = {
  id: string;
  kind: string;
  credential: string | null;
  checkpoint: unknown;
  configuration: Record<string, unknown>;
  address?: string;
  secret?: string;
  idempotency_key?: string;
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

test("E05 inbound store CLI journey", { timeout: TIMEOUT }, async (t) => {
  const fixture = await gatewayFixture(t);
  const directory = temporary(t);
  const H = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  const file = (name: string, body: unknown) => {
    const path = join(directory, name);
    writePrivate(path, JSON.stringify(body));
    return path;
  };
  const run = (args: string[]) => kanthord([...INBOUND, ...args], H);
  const project = succeeded<{ id: string }>(
    await kanthord(["project", "create", "--name", "inbounds"], H),
  );
  const webhook = {
    project_id: project.id,
    kind: InboundKind.Webhook,
    platform: InboundPlatform.GitHub,
    consumer: Consumer.MissionDeliveryAdmit,
    configuration: { resource: RESOURCE },
  };
  const webhookFile = file("webhook.json", webhook);
  let W = "";
  let W2 = "";

  await t.test("E05.1 a webhook create answers the inbound", async () => {
    const created = succeeded<Inbound>(
      await run(["create", "--file", webhookFile]),
    );
    assert.match(created.id, INBOUND_ID_PATTERN);
    assert.equal(created.kind, InboundKind.Webhook);
    assert.equal(created.credential, null);
    assert.equal(created.checkpoint, null);
    assert.deepEqual(created.configuration, { resource: RESOURCE });
    assert.ok(ulidSchema.safeParse(created.idempotency_key).success);
    W = created.id;
  });

  await t.test("E05.2 a second create answers a new identity", async () => {
    const created = succeeded<Inbound>(
      await run(["create", "--file", webhookFile]),
    );
    assert.match(created.id, INBOUND_ID_PATTERN);
    assert.notEqual(created.id, W);
    W2 = created.id;
  });

  await t.test("E05.3 get shows the secret and list hides it", async () => {
    const one = succeeded<Inbound>(await run(["get", W]));
    assert.equal(one.address, `${WEBHOOK_ADDRESS_PREFIX}${W}`);
    assert.ok(isString(one.secret) && one.secret.length);
    const page = succeeded<{ items: Inbound[] }>(
      await run(["list", "--project", project.id]),
    );
    assert.deepEqual(
      page.items.map((item) => item.id),
      [W2, W],
    );
    for (const item of page.items) assert.ok(!("secret" in item));
  });

  await t.test("E05.4 three bad creates refuse", async () => {
    refused(
      await run([
        "create",
        "--file",
        file("unknown-project.json", {
          ...webhook,
          project_id: UNKNOWN_PROJECT,
        }),
      ]),
      PROJECT_NOT_FOUND,
    );
    refused(
      await run([
        "create",
        "--file",
        file("bad-consumer.json", {
          ...webhook,
          consumer: "mission.node.check",
        }),
      ]),
      SCHEMA_INVALID,
    );
    refused(
      await run([
        "create",
        "--file",
        file("extra-field.json", {
          ...webhook,
          configuration: { resource: RESOURCE, events: ["push"] },
        }),
      ]),
      VALIDATION_FAILED,
    );
  });

  await t.test("E05.5 delete removes W2 once", async () => {
    const deleted = succeeded<{ idempotency_key: string }>(
      await run(["delete", W2]),
    );
    assert.ok(ulidSchema.safeParse(deleted.idempotency_key).success);
    refused(await run(["get", W2]), NOT_FOUND);
    refused(await run(["delete", W2]), NOT_FOUND);
  });

  await t.test("E05.6 a malformed identity refuses", async () => {
    refused(await run(["get", "bad"]), INVALID_ID);
  });

  await t.test("E05.7 an unknown kind filter refuses", async () => {
    refused(await run(["list", "--kind", "push"]), VALIDATION_FAILED);
  });
});

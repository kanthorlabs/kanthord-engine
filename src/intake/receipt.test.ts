import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test, type TestContext } from "node:test";
import pino from "pino";
import type { InboundOperation } from "../custody/contract.ts";
import {
  GrantKind,
  type GrantOf,
  type GrantRequest,
  type Material,
} from "../custody/contract.ts";
import { IdentityKind } from "../kernel/caller.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { type CallerContext, OperationRegistry } from "../kernel/operation.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import {
  Consumer,
  InboundEventState,
  InboundKind,
  type InboundKindValue,
  InboundPlatform,
  INTAKE_SERVICE_NAME,
  IntakeErrorCode,
  intakeOperations,
  ResourceKind,
} from "./contract.ts";
import type { IntakeCustody } from "./action-check.ts";
import { IntakeService } from "./index.ts";
import { allocateInboundId, insertInbound } from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";
import { JIRA_RESOURCE, jiraWebhookComment } from "./jira-test-support.ts";
import {
  SLACK_MESSAGE_EVENT,
  SLACK_OTHER_TEAM_ID,
  SLACK_REPLY_DELIVERY_TEXT,
  SLACK_SIGNATURE_HEADER_NAME,
  SLACK_SIGNING_SECRET,
  SLACK_TEAM_ID,
  SLACK_TIMESTAMP_HEADER_NAME,
  slackEventCallback,
  slackMessage,
  slackSignature,
  slackTimestamp,
} from "./slack-test-support.ts";
import { unusedActionDependencies } from "./test-support.ts";
import { webhookSecret } from "./webhook-secret.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UNKNOWN_INBOUND_ID = "inbound_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREATED_AT = 100;
const PENDING_EVENT_LIMIT = 2;
const PUSH = '{"ref":"refs/heads/main","repository":{"full_name":"acme/app"}}';
const ISSUE_COMMENT =
  '{"action":"created","issue":{"number":117},"comment":{"id":7001}}';
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

const SIGNING_CREDENTIAL = "slack-signing";
const SIGNING_CREDENTIAL_ID = "credential_1";

interface SlackRelease {
  operation: InboundOperation;
  credential: string;
  platform: string;
  resource: string;
}

function signingCustody(base: IntakeCustody) {
  const releases: SlackRelease[] = [];
  let drops = 0;
  const custody: IntakeCustody = {
    ...base,
    authorizeOperation<R extends GrantRequest>(
      _tx: Transaction,
      request: R,
    ): GrantOf<R["kind"]> {
      const inbound: GrantRequest = request;
      assert.ok(inbound.kind === GrantKind.Inbound);
      assert.equal(inbound.identity.service, INTAKE_SERVICE_NAME);
      releases.push({
        operation: inbound.operation,
        credential: inbound.inbound.credential,
        platform: inbound.inbound.platform,
        resource: inbound.inbound.resource,
      });
      const grant: GrantOf<typeof GrantKind.Inbound> = {
        kind: GrantKind.Inbound,
        credential: inbound.inbound.credential,
        platform: inbound.inbound.platform,
        project_id: inbound.inbound.projectId,
        execution: null,
        facts: {
          inbound_id: inbound.inbound.inboundId,
          resource: inbound.inbound.resource,
        },
      };
      return grant as GrantOf<R["kind"]>;
    },
    release(_tx, grant): Material {
      return {
        credential_id: SIGNING_CREDENTIAL_ID,
        platform: grant.platform,
        value: () => ({ key: SLACK_SIGNING_SECRET }),
        drop: () => {
          drops += 1;
        },
      };
    },
  };
  return { custody, releases, drops: () => drops };
}

function harness(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  const logs: string[] = [];
  const dependencies = unusedActionDependencies();
  const signing = signingCustody(dependencies.custody);
  const intake = new IntakeService({
    store,
    logger: pino({ level: "trace" }, { write: (line) => logs.push(line) }),
    health: new HealthRegistry(),
    identity: { kind: IdentityKind.Service, service: INTAKE_SERVICE_NAME },
    ...dependencies,
    custody: signing.custody,
    pendingEventLimit: PENDING_EVENT_LIMIT,
  });
  let wakes = 0;
  intake.wake = () => {
    wakes += 1;
  };
  let failCommit = false;
  const registry = new OperationRegistry();
  intake.declare(registry);
  const addInbound = (
    kind: InboundKindValue = InboundKind.Webhook,
    resourceKind: ResourceKind = ResourceKind.Repository,
  ) => {
    const id = allocateInboundId();
    store.transaction((tx) =>
      insertInbound(tx, id, {
        project_id: PROJECT_ID,
        kind,
        platform: InboundPlatform.GitHub,
        consumer: Consumer.MissionDeliveryAdmit,
        credential: kind === InboundKind.Poll ? "github-token" : null,
        configuration: { resource_kind: resourceKind, resource: "acme/app" },
        checkpoint: null,
        created_at: CREATED_AT,
      }),
    );
    return { id, secret: webhookSecret(dependencies.masterKey, id) };
  };
  const addJiraInbound = () => {
    const id = allocateInboundId();
    store.transaction((tx) =>
      insertInbound(tx, id, {
        project_id: PROJECT_ID,
        kind: InboundKind.Webhook,
        platform: InboundPlatform.Jira,
        consumer: Consumer.MissionDeliveryAdmit,
        credential: null,
        configuration: {
          resource_kind: ResourceKind.Conversation,
          resource: JIRA_RESOURCE,
        },
        checkpoint: null,
        created_at: CREATED_AT,
      }),
    );
    return { id, secret: webhookSecret(dependencies.masterKey, id) };
  };
  const addSlackInbound = () => {
    const id = allocateInboundId();
    store.transaction((tx) =>
      insertInbound(tx, id, {
        project_id: PROJECT_ID,
        kind: InboundKind.Webhook,
        platform: InboundPlatform.Slack,
        consumer: Consumer.MissionDeliveryAdmit,
        credential: SIGNING_CREDENTIAL,
        configuration: {
          resource_kind: ResourceKind.Conversation,
          resource: SLACK_TEAM_ID,
        },
        checkpoint: null,
        created_at: CREATED_AT,
      }),
    );
    return { id };
  };
  const deliver = async (
    inboundId: string,
    headers: Headers,
    body: string | Uint8Array,
  ): Promise<Outcome & { text: string }> => {
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
      return { status: answer.status, code: null, text: await answer.text() };
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      return { status: error.status, code: error.code, text: "" };
    }
  };
  const receive = async (
    inboundId: string,
    headers: Headers,
    body: string | Uint8Array,
  ): Promise<Outcome> => {
    const { text, ...outcome } = await deliver(inboundId, headers, body);
    assert.equal(text, ACKNOWLEDGEMENT_BODY);
    return outcome;
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
  const jira = (identifier: string, signature?: string) => {
    const headers = new Headers({
      "content-type": "application/json",
      "x-atlassian-webhook-identifier": identifier,
    });
    if (signature !== undefined) headers.set("x-hub-signature", signature);
    return headers;
  };
  const slack = (
    body: string,
    overrides: { secret?: string; timestamp?: string; signature?: string } = {},
  ) => {
    const timestamp = overrides.timestamp ?? slackTimestamp();
    return new Headers({
      "content-type": "application/json",
      [SLACK_TIMESTAMP_HEADER_NAME]: timestamp,
      [SLACK_SIGNATURE_HEADER_NAME]:
        overrides.signature ??
        slackSignature(
          overrides.secret ?? SLACK_SIGNING_SECRET,
          timestamp,
          body,
        ),
    });
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
    addJiraInbound,
    addSlackInbound,
    jira,
    slack,
    signing,
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

test("a conversation webhook inbound stores an issue_comment delivery under the receipt", async (t) => {
  const h = harness(t);
  const { id, secret } = h.addInbound(
    InboundKind.Webhook,
    ResourceKind.Conversation,
  );
  assert.deepEqual(
    await h.receive(
      id,
      h.github("issue_comment", FIRST_DELIVERY, sign(secret, ISSUE_COMMENT)),
      ISSUE_COMMENT,
    ),
    { status: HttpStatus.Accepted, code: null },
  );
  const stored = h.rows(id);
  assert.equal(stored.length, ROWS_PER_DELIVERY);
  assert.equal(stored[0]!.event_id, FIRST_DELIVERY);
  assert.deepEqual(JSON.parse(stored[0]!.metadata), {
    event: "issue_comment",
  });
  assert.equal(stored[0]!.state, InboundEventState.Pending);
  assert.equal(h.wakes(), WAKES_PER_DELIVERY);
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

const JIRA_COMMENT = JSON.stringify(jiraWebhookComment());
const JIRA_IDENTIFIER = "jira-hook-1";

test("a missing, duplicate, malformed, wrong-length or wrong Jira signature answers 401 and stores nothing", async (t) => {
  const h = harness(t);
  const { id, secret } = h.addJiraInbound();
  const valid = sign(secret, JIRA_COMMENT);
  const duplicate = h.jira(JIRA_IDENTIFIER, valid);
  duplicate.append("x-hub-signature", valid);
  const refusals = [
    h.jira(JIRA_IDENTIFIER),
    duplicate,
    h.jira(JIRA_IDENTIFIER, valid.slice("sha256=".length)),
    h.jira(JIRA_IDENTIFIER, `sha1=${valid.slice("sha256=".length)}`),
    h.jira(JIRA_IDENTIFIER, `sha256=${NON_HEX_DIGEST}`),
    h.jira(JIRA_IDENTIFIER, `sha256=${SHORT_DIGEST}`),
    h.jira(JIRA_IDENTIFIER, `${valid}00`),
    h.jira(JIRA_IDENTIFIER, `sha256=${ZERO_DIGEST}`),
  ];
  for (const headers of refusals)
    assert.deepEqual(
      await h.receive(id, headers, JIRA_COMMENT),
      SIGNATURE_INVALID,
    );
  assert.deepEqual(
    await h.receive(id, h.jira(JIRA_IDENTIFIER, valid), `${JIRA_COMMENT} `),
    SIGNATURE_INVALID,
  );
  const gitHubForm = h.jira(JIRA_IDENTIFIER);
  gitHubForm.set("x-hub-signature-256", valid);
  assert.deepEqual(
    await h.receive(id, gitHubForm, JIRA_COMMENT),
    SIGNATURE_INVALID,
  );
  assert.equal(h.rows(id).length, UNSTORED_ROW_COUNT);
  assert.equal(h.wakes(), WAKES_AFTER_REFUSAL);
});

const STALE_SECONDS = 301;
const WRONG_SECRET = "test_private-wrong-signing-secret";
const SLACK_ATTEMPT_COUNT_ONE = 1;
const OTHER_TEAM_DELIVERY_TEXT = JSON.stringify(
  slackEventCallback(slackMessage(), { team_id: SLACK_OTHER_TEAM_ID }),
);
const SLACK_ACCEPTED = { status: HttpStatus.Accepted, code: null };

test("a stale or future timestamp, a missing or duplicate header, a malformed and a wrong signature answer 401 and store nothing", async (t) => {
  const h = harness(t);
  const { id } = h.addSlackInbound();
  const body = SLACK_REPLY_DELIVERY_TEXT;
  const valid = h.slack(body);
  const validSignature = valid.get(SLACK_SIGNATURE_HEADER_NAME)!;
  const digest = validSignature.slice("v0=".length);
  const withoutSignature = h.slack(body);
  withoutSignature.delete(SLACK_SIGNATURE_HEADER_NAME);
  const withoutTimestamp = h.slack(body);
  withoutTimestamp.delete(SLACK_TIMESTAMP_HEADER_NAME);
  const duplicateSignature = h.slack(body);
  duplicateSignature.append(SLACK_SIGNATURE_HEADER_NAME, validSignature);
  const duplicateTimestamp = h.slack(body);
  duplicateTimestamp.append(
    SLACK_TIMESTAMP_HEADER_NAME,
    valid.get(SLACK_TIMESTAMP_HEADER_NAME)!,
  );
  const refusals = [
    h.slack(body, { timestamp: slackTimestamp(-STALE_SECONDS) }),
    h.slack(body, { timestamp: slackTimestamp(STALE_SECONDS) }),
    withoutSignature,
    withoutTimestamp,
    duplicateSignature,
    duplicateTimestamp,
    h.slack(body, { signature: digest }),
    h.slack(body, { signature: `sha256=${digest}` }),
    h.slack(body, { signature: `v0=${NON_HEX_DIGEST}` }),
    h.slack(body, { signature: `v0=${SHORT_DIGEST}` }),
    h.slack(body, { signature: `${validSignature}00` }),
    h.slack(body, { signature: `v0=${ZERO_DIGEST}` }),
    h.slack(body, { secret: WRONG_SECRET }),
    h.slack(body, { timestamp: "1e9" }),
    h.slack(body, { timestamp: `-${slackTimestamp()}` }),
  ];
  for (const headers of refusals)
    assert.deepEqual(await h.receive(id, headers, body), SIGNATURE_INVALID);
  assert.deepEqual(await h.receive(id, valid, `${body} `), SIGNATURE_INVALID);
  assert.equal(h.rows(id).length, UNSTORED_ROW_COUNT);
  assert.equal(h.wakes(), WAKES_AFTER_REFUSAL);
  assert.equal(
    h.signing.releases.length,
    refusals.length + SLACK_ATTEMPT_COUNT_ONE,
  );
  assert.equal(h.signing.drops(), h.signing.releases.length);
});

test("a repeated event_id stores one row and a body of another team is stored", async (t) => {
  const h = harness(t);
  const { id } = h.addSlackInbound();
  const deliver = (body: string) => h.receive(id, h.slack(body), body);
  assert.deepEqual(await deliver(SLACK_REPLY_DELIVERY_TEXT), SLACK_ACCEPTED);
  assert.deepEqual(
    await deliver(`${SLACK_REPLY_DELIVERY_TEXT}\n`),
    SLACK_ACCEPTED,
  );
  const stored = h.rows(id);
  assert.equal(stored.length, ROWS_PER_DELIVERY);
  assert.equal(
    Buffer.from(stored[0]!.event).toString(),
    SLACK_REPLY_DELIVERY_TEXT,
  );
  const other = h.addSlackInbound();
  assert.deepEqual(
    await h.receive(
      other.id,
      h.slack(OTHER_TEAM_DELIVERY_TEXT),
      OTHER_TEAM_DELIVERY_TEXT,
    ),
    SLACK_ACCEPTED,
  );
  assert.equal(h.rows(other.id).length, ROWS_PER_DELIVERY);
});

test("a signed delivery of another shape answers 400 and stores nothing", async (t) => {
  const h = harness(t);
  const { id } = h.addSlackInbound();
  const noEventId = JSON.stringify({
    type: "event_callback",
    event: { type: SLACK_MESSAGE_EVENT },
  });
  const noChallenge = JSON.stringify({ type: "url_verification" });
  const rateLimited = JSON.stringify({ type: "app_rate_limited" });
  for (const body of [
    "{}",
    "not json",
    "[]",
    noEventId,
    noChallenge,
    rateLimited,
  ])
    assert.deepEqual(await h.receive(id, h.slack(body), body), {
      status: HttpStatus.BadRequest,
      code: VALIDATION_FAILED,
    });
  assert.equal(h.rows(id).length, UNSTORED_ROW_COUNT);
  assert.equal(h.signing.drops(), h.signing.releases.length);
});

test("a commit failure after a verified delivery stores nothing and still drops the material", async (t) => {
  const h = harness(t);
  const { id } = h.addSlackInbound();
  h.failCommits();
  await assert.rejects(
    h.receive(
      id,
      h.slack(SLACK_REPLY_DELIVERY_TEXT),
      SLACK_REPLY_DELIVERY_TEXT,
    ),
    { message: "commit refused" },
  );
  assert.equal(h.rows(id).length, UNSTORED_ROW_COUNT);
  assert.equal(h.signing.releases.length, SLACK_ATTEMPT_COUNT_ONE);
  assert.equal(h.signing.drops(), SLACK_ATTEMPT_COUNT_ONE);
});

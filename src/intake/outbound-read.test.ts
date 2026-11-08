import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { IdentityKind } from "../kernel/caller.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import {
  type ExternalLink,
  ExternalLinkKind,
} from "../kernel/external-link.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { testServiceIdentity } from "../kernel/test-identity.ts";
import { MISSION_SERVICE_NAME } from "../mission/contract.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { type CallerContext, OperationRegistry } from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  INTAKE_SERVICE_NAME,
  intakeOperations,
  OutboundOperation,
  type OutboundOperationValue,
  OutboundRequestState,
  type OutboundRequestStateValue,
  replyRequestKey,
} from "./contract.ts";
import { IntakeService } from "./index.ts";
import { intakeMigrations } from "./migrations.ts";
import {
  discard,
  insertPending,
  recordResult,
  succeed,
} from "./outbound-store.ts";
import { unusedActionDependencies } from "./test-support.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const CREATED_AT = 100;
const NOT_FOUND = "intake.outbound.request.not_found";
const CURSOR_INVALID = "system.pagination.cursor_invalid";
const PAGE_SIZE = 2;
const FIRST_ROW = 0;
const SECOND_ROW = 1;

function harness(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  const intake = new IntakeService({
    store,
    logger: pino({ enabled: false }),
    health: new HealthRegistry(),
    identity: { kind: IdentityKind.Service, service: INTAKE_SERVICE_NAME },
    ...unusedActionDependencies(),
  });
  const registry = new OperationRegistry();
  intake.declare(registry);
  const caller: CallerContext = {
    context: background,
    requestId: createIdentity("request"),
    commit: (write) => store.transaction(write),
  };
  const list = async (query: Record<string, unknown> = {}) => {
    const operation = intakeOperations["outbound.request.list"];
    return operation.output.parse(
      await registry
        .get(operation.id)
        .handler(
          operation.input.parse({ params: {}, query, body: null }),
          caller,
        ),
    );
  };
  const get = async (id: string) => {
    const operation = intakeOperations["outbound.request.get"];
    return operation.output.parse(
      await registry.get(operation.id).handler(
        operation.input.parse({
          params: { outbound_request_id: id },
          query: {},
          body: null,
        }),
        caller,
      ),
    );
  };
  const insert = (
    key: string,
    options: {
      project_id?: string;
      operation?: OutboundOperationValue;
      state?: OutboundRequestStateValue;
    } = {},
  ) =>
    store.transaction((tx) => {
      const id = insertPending(tx, {
        project_id: options.project_id ?? PROJECT_ID,
        operation: options.operation ?? OutboundOperation.GitHubPullRequest,
        request_key: key,
        credential: null,
        created_at: CREATED_AT,
      });
      if (options.state === OutboundRequestState.Discarded) discard(tx, id);
      return id;
    });
  const missionCaller: CallerContext = {
    ...caller,
    identity: testServiceIdentity(MISSION_SERVICE_NAME),
  };
  const match = async (
    update_key: string,
    external_link: ExternalLink = LINK,
    from: CallerContext = missionCaller,
  ) => {
    const operation = intakeOperations["outbound.reply.match"];
    return operation.output.parse(
      await registry.get(operation.id).handler(
        operation.input.parse({
          params: {},
          query: {},
          body: { update_key, external_link },
        }),
        from,
      ),
    );
  };
  const reply = (
    link: ExternalLink,
    options: {
      project_id?: string;
      attempt: number;
      result?: unknown;
      succeeded?: boolean;
    },
  ) =>
    store.transaction((tx) => {
      const id = insertPending(tx, {
        project_id: options.project_id ?? PROJECT_ID,
        operation: OutboundOperation.GitHubIssueComment,
        request_key: replyRequestKey(NODE_ID, options.attempt, link),
        credential: null,
        created_at: CREATED_AT + options.attempt,
      });
      if (options.succeeded === true)
        assert.ok(
          succeed(tx, id, options.result, [OutboundRequestState.Pending]),
        );
      else if (options.result !== undefined)
        assert.ok(recordResult(tx, id, options.result));
      return id;
    });
  return { list, get, insert, match, reply, caller };
}

async function refusal(promise: Promise<unknown>): Promise<OperationError> {
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof OperationError);
  return error;
}

test("an empty list answers no items and no cursor", async (t) => {
  const h = harness(t);
  assert.deepEqual(await h.list(), { items: [], next_cursor: null });
});

test("the list combines the project, state and operation filters with AND", async (t) => {
  const h = harness(t);
  const target = h.insert("k1", {
    project_id: OTHER_PROJECT_ID,
    operation: OutboundOperation.S3DeleteObject,
    state: OutboundRequestState.Discarded,
  });
  h.insert("k2");
  h.insert("k3", { project_id: OTHER_PROJECT_ID });
  h.insert("k4", { operation: OutboundOperation.S3DeleteObject });
  const ids = async (query: Record<string, unknown>) =>
    (await h.list(query)).items.map((item) => item.id);
  assert.equal((await ids({ project_id: OTHER_PROJECT_ID })).length, PAGE_SIZE);
  assert.deepEqual(await ids({ state: OutboundRequestState.Discarded }), [
    target,
  ]);
  assert.equal(
    (await ids({ operation: OutboundOperation.S3DeleteObject })).length,
    PAGE_SIZE,
  );
  assert.deepEqual(
    await ids({
      project_id: OTHER_PROJECT_ID,
      state: OutboundRequestState.Discarded,
      operation: OutboundOperation.S3DeleteObject,
    }),
    [target],
  );
  assert.deepEqual(
    await ids({
      project_id: PROJECT_ID,
      state: OutboundRequestState.Discarded,
    }),
    [],
  );
});

test("a page of two answers the newest first with a cursor to the rest", async (t) => {
  const h = harness(t);
  const ids = ["k1", "k2", "k3"].map((key) => h.insert(key));
  const first = await h.list({ limit: PAGE_SIZE });
  assert.equal(first.items.length, PAGE_SIZE);
  assert.ok(first.items[FIRST_ROW]!.id > first.items[SECOND_ROW]!.id);
  assert.ok(first.next_cursor);
  const second = await h.list({ limit: PAGE_SIZE, cursor: first.next_cursor });
  assert.equal(second.items.length, SECOND_ROW);
  assert.equal(second.next_cursor, null);
  assert.deepEqual(
    [...first.items, ...second.items].map((item) => item.id),
    [...ids].sort().reverse(),
  );
});

test("a malformed cursor answers 400 cursor_invalid", async (t) => {
  const h = harness(t);
  for (const cursor of ["!!", Buffer.from("junk").toString("base64url")]) {
    const error = await refusal(h.list({ cursor }));
    assert.equal(error.status, HttpStatus.BadRequest);
    assert.equal(error.code, CURSOR_INVALID);
  }
});

test("a get answers the projection and 404 for an unknown identity", async (t) => {
  const h = harness(t);
  const id = h.insert("k1");
  const record = await h.get(id);
  assert.equal(record.id, id);
  assert.equal(record.state, OutboundRequestState.Pending);
  assert.equal(record.result, null);
  assert.deepEqual(Object.keys(record).sort(), [
    "created_at",
    "error",
    "id",
    "operation",
    "project_id",
    "request_key",
    "result",
    "state",
  ]);
  const error = await refusal(h.get(createIdentity("outbound_request")));
  assert.equal(error.status, HttpStatus.NotFound);
  assert.equal(error.code, NOT_FOUND);
});

const NODE_ID = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LINK: ExternalLink = {
  kind: ExternalLinkKind.GitHubIssue,
  resource_identity: "conversation:github:acme/app",
  number: 7,
};
const OTHER_LINK: ExternalLink = { ...LINK, number: 8 };
const REPLY_UPDATE_KEY = "issue_comment:5001";
const OTHER_UPDATE_KEY = "issue_comment:5002";
const REPLY_ACCOUNT = "4242";
const NEWER_ACCOUNT = "4343";
const PENDING_ACCOUNT = "4444";
const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const THIRD_ATTEMPT = 3;

function posted(updateKey: string, actorId: string | null) {
  return { update_key: updateKey, actor_id: actorId };
}

test("reply match answers succeeded for the update key of a succeeded reply of any project", async (t) => {
  const h = harness(t);
  h.reply(LINK, {
    project_id: OTHER_PROJECT_ID,
    attempt: FIRST_ATTEMPT,
    succeeded: true,
    result: posted(REPLY_UPDATE_KEY, REPLY_ACCOUNT),
  });
  assert.deepEqual(await h.match(REPLY_UPDATE_KEY), {
    succeeded: true,
    pending_actor_ids: [],
  });
  assert.deepEqual(await h.match(REPLY_UPDATE_KEY, OTHER_LINK), {
    succeeded: true,
    pending_actor_ids: [],
  });
  assert.deepEqual(await h.match(OTHER_UPDATE_KEY), {
    succeeded: false,
    pending_actor_ids: [],
  });
});

test("reply match answers the recorded account of a pending reply on the same link", async (t) => {
  const h = harness(t);
  h.reply(LINK, {
    attempt: FIRST_ATTEMPT,
    result: { actor_id: PENDING_ACCOUNT },
  });
  h.reply(OTHER_LINK, {
    attempt: SECOND_ATTEMPT,
    result: { actor_id: REPLY_ACCOUNT },
  });
  assert.deepEqual(await h.match(OTHER_UPDATE_KEY), {
    succeeded: false,
    pending_actor_ids: [PENDING_ACCOUNT],
  });
  assert.deepEqual(await h.match(OTHER_UPDATE_KEY, OTHER_LINK), {
    succeeded: false,
    pending_actor_ids: [REPLY_ACCOUNT],
  });
});

test("reply match prefers the account of the last succeeded reply of the link and sees a pending reply of another project", async (t) => {
  const h = harness(t);
  h.reply(LINK, {
    attempt: FIRST_ATTEMPT,
    succeeded: true,
    result: posted(REPLY_UPDATE_KEY, REPLY_ACCOUNT),
  });
  h.reply(LINK, {
    project_id: OTHER_PROJECT_ID,
    attempt: SECOND_ATTEMPT,
    succeeded: true,
    result: posted(OTHER_UPDATE_KEY, NEWER_ACCOUNT),
  });
  assert.deepEqual((await h.match("issue_comment:1")).pending_actor_ids, []);
  h.reply(LINK, {
    project_id: OTHER_PROJECT_ID,
    attempt: THIRD_ATTEMPT,
    result: { actor_id: PENDING_ACCOUNT },
  });
  assert.deepEqual(await h.match("issue_comment:1"), {
    succeeded: false,
    pending_actor_ids: [NEWER_ACCOUNT],
  });
});

test("reply match names no account for a pending reply that recorded none and for a failed reply", async (t) => {
  const h = harness(t);
  h.reply(LINK, { attempt: FIRST_ATTEMPT });
  assert.deepEqual(await h.match(REPLY_UPDATE_KEY), {
    succeeded: false,
    pending_actor_ids: [],
  });
});

test("reply match refuses a caller that is not the Mission Service", async (t) => {
  const h = harness(t);
  await assert.rejects(async () => h.match(REPLY_UPDATE_KEY, LINK, h.caller));
});

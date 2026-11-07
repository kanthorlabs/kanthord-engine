import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ulid } from "ulid";
import {
  GrantKind,
  type GrantOf,
  type GrantRequest,
  InboundOperation,
  type Material,
} from "../custody/contract.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { CallerContext } from "../kernel/operation.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { testServiceIdentity } from "../kernel/test-identity.ts";
import {
  type ExternalLink,
  ExternalLinkKind,
  MISSION_SERVICE_NAME,
} from "../mission/contract.ts";
import type { ConversationBinding } from "../project/contract.ts";
import type {
  GitHubAnswer,
  GitHubCall,
  GitHubEvent,
  GitHubTarget,
} from "../repository/github.ts";
import { GitHubTargetKind } from "../repository/github.ts";
import {
  Consumer,
  InboundKind,
  InboundPlatform,
  INTAKE_SERVICE_NAME,
  IntakeErrorCode,
  ResourceKind,
  ResultClass,
} from "./contract.ts";
import { insertInbound } from "./inbound-store.ts";
import { type LinkReadDependencies, readLink } from "./link-read.ts";
import { intakeMigrations } from "./migrations.ts";

const PROJECT_ID = createIdentity("project");
const BINDING_ID = createIdentity("binding");
const CREDENTIAL = "github-conversation";
const REPOSITORY = "acme/app";
const RESOURCE_IDENTITY = "conversation:github:acme/app";
const OTHER_RESOURCE_IDENTITY = "conversation:github:acme/other";
const ISSUE_NUMBER = 7;
const OLDER_INBOUND_TIME = 1700000000000;
const FIRST_COMMENT_ID = 5001;
const SECOND_COMMENT_ID = 5002;
const TOKEN = "ghp_poll-token";
const LISTED_EVENT = "issue_comment_listed";
const GITHUB_STATUS = 500;
const BAD_GATEWAY_STATUS = 502;
const NO_ROWS = 0;
const NO_CALLS = 0;
const SINGLE_CALL = 1;
const TWO_ITEMS = 2;
const SECOND_INDEX = 1;
const FIRST_INDEX = 0;
const IDENTITY = testServiceIdentity(MISSION_SERVICE_NAME);
const LINK: ExternalLink = {
  kind: ExternalLinkKind.GitHubIssue,
  resource_identity: RESOURCE_IDENTITY,
  number: ISSUE_NUMBER,
};
const BINDING: ConversationBinding = {
  binding_id: BINDING_ID,
  project_id: PROJECT_ID,
  resource_identity: RESOURCE_IDENTITY,
  platform: InboundPlatform.GitHub,
  repository: REPOSITORY,
  credential: CREDENTIAL,
};

function comment(id: number): GitHubEvent {
  return {
    id: `issue_comment:${id}`,
    type: LISTED_EVENT,
    body: new Uint8Array(Buffer.from(JSON.stringify({ id }))),
  };
}

function harness(
  t: TestContext,
  binding: ConversationBinding | null = BINDING,
) {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  const grants: GrantRequest[] = [];
  const drops: string[] = [];
  const held: string[][] = [];
  const reads: { call: GitHubCall; target: GitHubTarget; number: number }[] =
    [];
  const script = {
    answer: {
      ok: true,
      value: [comment(FIRST_COMMENT_ID), comment(SECOND_COMMENT_ID)],
    } as GitHubAnswer<GitHubEvent[]>,
  };
  const dependencies: LinkReadDependencies = {
    store,
    identity: testServiceIdentity(INTAKE_SERVICE_NAME),
    custody: {
      authorizeOperation<R extends GrantRequest>(
        _tx: unknown,
        request: R,
      ): GrantOf<R["kind"]> {
        const inbound: GrantRequest = request;
        assert.ok(inbound.kind === GrantKind.Inbound);
        grants.push(inbound);
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
        const credential = grant.credential;
        assert.ok(credential !== null);
        return {
          credential_id: createIdentity("credential"),
          platform: grant.platform,
          value: () => ({ key: TOKEN }),
          drop: () => drops.push(credential),
        };
      },
    },
    github: {
      listIssueCommentsOf: async (call, target, number) => {
        reads.push({ call, target, number });
        return script.answer;
      },
    },
    linkBindings: { conversationBindingOf: () => binding },
    holdEvents: (ids) => held.push([...ids]),
  };
  const caller: CallerContext = {
    identity: IDENTITY,
    context: background,
    requestId: createIdentity("request"),
    commit: (write) => store.transaction(write),
  };
  const addInbound = (id: string, resource = REPOSITORY) =>
    store.transaction((tx) =>
      insertInbound(tx, id, {
        project_id: PROJECT_ID,
        kind: InboundKind.Poll,
        platform: InboundPlatform.GitHub,
        consumer: Consumer.MissionDeliveryAdmit,
        credential: CREDENTIAL,
        configuration: {
          resource_kind: ResourceKind.Conversation,
          resource,
        },
        checkpoint: null,
        created_at: 1,
      }),
    );
  const read = (input: Partial<Parameters<typeof readLink>[2]> = {}) =>
    readLink(dependencies, caller, {
      project_id: PROJECT_ID,
      external_link: LINK,
      binding_id: BINDING_ID,
      ...input,
    });
  const events = () =>
    store.database
      .prepare(
        "SELECT id, inbound_id, event_id, metadata, state FROM intake_inbound_event ORDER BY rowid",
      )
      .all()
      .map((row) => ({ ...row }));
  const outbound = () =>
    store.database
      .prepare("SELECT COUNT(*) AS total FROM intake_outbound_request")
      .get() as { total: number };
  return {
    store,
    grants,
    drops,
    held,
    reads,
    script,
    addInbound,
    read,
    events,
    outbound,
  };
}

function olderInboundId(): string {
  return `inbound_${ulid(OLDER_INBOUND_TIME)}`;
}

test("a link read stores two items under the newest of two inbounds of the resource", async (t) => {
  const h = harness(t);
  h.addInbound(olderInboundId());
  const newest = createIdentity("inbound");
  h.addInbound(newest);
  const answer = await h.read();
  const rows = h.events();
  assert.equal(rows.length, TWO_ITEMS);
  assert.deepEqual(
    rows.map((row) => row.inbound_id),
    [newest, newest],
  );
  assert.deepEqual(
    rows.map((row) => row.event_id),
    [`issue_comment:${FIRST_COMMENT_ID}`, `issue_comment:${SECOND_COMMENT_ID}`],
  );
  assert.deepEqual(
    rows.map((row) => JSON.parse(String(row.metadata))),
    [{ event: LISTED_EVENT }, { event: LISTED_EVENT }],
  );
  assert.deepEqual(answer, {
    items: [
      { inbound_event_id: rows[FIRST_INDEX]!.id },
      { inbound_event_id: rows[SECOND_INDEX]!.id },
    ],
  });
  assert.equal(h.reads[FIRST_INDEX]!.number, ISSUE_NUMBER);
  assert.deepEqual(h.reads[FIRST_INDEX]!.target, {
    kind: GitHubTargetKind.Inbound,
    resource: REPOSITORY,
  });
  assert.equal(h.reads[FIRST_INDEX]!.call.token, TOKEN);
});

test("a second read stores no second row and answers the stored identities", async (t) => {
  const h = harness(t);
  h.addInbound(createIdentity("inbound"));
  const first = await h.read();
  const second = await h.read();
  assert.equal(h.events().length, TWO_ITEMS);
  assert.deepEqual(second, first);
});

test("an inbound of another resource is no inbound of the link", async (t) => {
  const h = harness(t);
  h.addInbound(createIdentity("inbound"), "acme/other");
  await assert.rejects(
    h.read(),
    (error) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Conflict &&
      error.code === IntakeErrorCode.LinkInboundMissing,
  );
});

test("a link with no inbound answers 409 and takes no release and no read", async (t) => {
  const h = harness(t);
  await assert.rejects(
    h.read(),
    (error) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Conflict &&
      error.code === IntakeErrorCode.LinkInboundMissing &&
      JSON.stringify(error.details) === JSON.stringify({ external_link: LINK }),
  );
  assert.equal(h.grants.length, NO_CALLS);
  assert.equal(h.reads.length, NO_CALLS);
  assert.equal(h.events().length, NO_ROWS);
});

test("a read takes one release of the credential of the binding and records no outbound request", async (t) => {
  const h = harness(t);
  const inbound = createIdentity("inbound");
  h.addInbound(inbound);
  await h.read();
  assert.equal(h.grants.length, SINGLE_CALL);
  const grant = h.grants[FIRST_INDEX]!;
  assert.ok(grant.kind === GrantKind.Inbound);
  assert.equal(grant.inbound.credential, CREDENTIAL);
  assert.equal(grant.inbound.inboundId, inbound);
  assert.equal(grant.inbound.resource, REPOSITORY);
  assert.equal(grant.operation, InboundOperation.LinkRead);
  assert.deepEqual(h.drops, [CREDENTIAL]);
  assert.equal(h.outbound().total, NO_ROWS);
});

test("a read holds the identities of its items in the commit of the rows", async (t) => {
  const h = harness(t);
  h.addInbound(createIdentity("inbound"));
  const { items } = await h.read();
  assert.deepEqual(h.held, [items.map((item) => item.inbound_event_id)]);
});

test("a binding of another resource refuses the read before any release", async (t) => {
  const h = harness(t, {
    ...BINDING,
    resource_identity: OTHER_RESOURCE_IDENTITY,
  });
  h.addInbound(createIdentity("inbound"));
  await assert.rejects(
    h.read(),
    (error) =>
      error instanceof OperationError && error.status === HttpStatus.BadRequest,
  );
  assert.equal(h.grants.length, NO_CALLS);
});

test("a failed platform call answers 502, stores no row and drops the material", async (t) => {
  const h = harness(t);
  h.addInbound(createIdentity("inbound"));
  h.script.answer = {
    ok: false,
    class: ResultClass.RetryableRefusal,
    code: `repository.platform.github.${ResultClass.RetryableRefusal}`,
    status: GITHUB_STATUS,
    message: "refused",
  };
  await assert.rejects(
    h.read(),
    (error) =>
      error instanceof OperationError &&
      error.status === BAD_GATEWAY_STATUS &&
      error.code ===
        `repository.platform.github.${ResultClass.RetryableRefusal}`,
  );
  assert.equal(h.events().length, NO_ROWS);
  assert.deepEqual(h.drops, [CREDENTIAL]);
});

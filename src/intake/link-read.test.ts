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
import {
  JIRA_BASIC_AUTHORIZATION,
  JIRA_ISSUE_KEY,
  JIRA_LIST_URL,
  JIRA_LISTED_EVENT,
  JIRA_METADATA,
  JIRA_RESOURCE,
  JIRA_RESOURCE_IDENTITY,
  JIRA_SECOND_COMMENT_ID,
  JIRA_SITE,
  JIRA_TOKEN,
  JIRA_UPDATE_KEY,
  jiraListedComment,
  jiraListedPage,
  jsonResponse,
  mockJiraFetch,
  okResponse,
} from "./jira-test-support.ts";
import { type LinkReadDependencies, readLink } from "./link-read.ts";
import { intakeMigrations } from "./migrations.ts";
import { decodeSlackLinkUpdate } from "./slack.ts";
import {
  mockSlackFetch,
  SLACK_CHANNEL,
  SLACK_REPLIES_URL,
  SLACK_REPLY_LISTED_EVENT,
  SLACK_RESOURCE_IDENTITY,
  SLACK_SECOND_REPLY_TS,
  SLACK_SECOND_UPDATE_KEY,
  SLACK_TEAM_ID,
  SLACK_THREAD_TS,
  SLACK_UPDATE_KEY,
  SLACK_USER_TOKEN,
  slackErrorResponse,
  slackListedMessage,
  slackOkResponse,
  slackParentMessage,
  slackRepliesPage,
  slackResponse,
} from "./slack-test-support.ts";

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
const SLACK_SIGNING_CREDENTIAL = "slack-signing";
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
  metadata: Record<string, unknown> = JIRA_METADATA,
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
      credentialMetadata: () => ({
        id: createIdentity("credential"),
        name: CREDENTIAL,
        platform: InboundPlatform.Jira,
        metadata,
      }),
      release(_tx, grant): Material {
        const credential = grant.credential;
        assert.ok(credential !== null);
        return {
          credential_id: createIdentity("credential"),
          platform: grant.platform,
          value: () => ({
            key:
              grant.platform === InboundPlatform.Jira
                ? JIRA_TOKEN
                : grant.platform === InboundPlatform.Slack
                  ? SLACK_USER_TOKEN
                  : TOKEN,
          }),
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
  const addJiraInbound = (id: string) =>
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
        created_at: 1,
      }),
    );
  const addSlackInbound = (id: string) =>
    store.transaction((tx) =>
      insertInbound(tx, id, {
        project_id: PROJECT_ID,
        kind: InboundKind.Webhook,
        platform: InboundPlatform.Slack,
        consumer: Consumer.MissionDeliveryAdmit,
        credential: SLACK_SIGNING_CREDENTIAL,
        configuration: {
          resource_kind: ResourceKind.Conversation,
          resource: SLACK_TEAM_ID,
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
    addJiraInbound,
    addSlackInbound,
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

test("a read holds the identities of its items after the commit of the rows", async (t) => {
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

const JIRA_LINK: ExternalLink = {
  kind: ExternalLinkKind.JiraIssue,
  resource_identity: JIRA_RESOURCE_IDENTITY,
  key: JIRA_ISSUE_KEY,
};
const JIRA_BINDING: ConversationBinding = {
  binding_id: BINDING_ID,
  project_id: PROJECT_ID,
  resource_identity: JIRA_RESOURCE_IDENTITY,
  platform: InboundPlatform.Jira,
  repository: JIRA_RESOURCE,
  credential: CREDENTIAL,
};
const JIRA_UNAUTHORIZED = 401;
const SECOND_JIRA_UPDATE_KEY = `jira_comment:${JIRA_SITE}:${JIRA_SECOND_COMMENT_ID}`;

function jiraList(t: TestContext) {
  return mockJiraFetch(t, () =>
    okResponse(
      jiraListedPage(
        jiraListedComment(),
        jiraListedComment({ id: JIRA_SECOND_COMMENT_ID }),
      ),
    ),
  );
}

test("a Jira link read stores each comment as jira_comment under the newest jira inbound of the resource", async (t) => {
  const h = harness(t, JIRA_BINDING);
  const fetched = jiraList(t);
  h.addJiraInbound(olderInboundId());
  const newest = createIdentity("inbound");
  h.addJiraInbound(newest);
  const answer = await h.read({ external_link: JIRA_LINK });
  const rows = h.events();
  assert.deepEqual(
    rows.map((row) => [row.inbound_id, row.event_id]),
    [
      [newest, JIRA_UPDATE_KEY],
      [newest, SECOND_JIRA_UPDATE_KEY],
    ],
  );
  assert.deepEqual(
    rows.map((row) => JSON.parse(String(row.metadata))),
    [{ event: JIRA_LISTED_EVENT }, { event: JIRA_LISTED_EVENT }],
  );
  assert.deepEqual(answer, {
    items: [
      { inbound_event_id: rows[FIRST_INDEX]!.id },
      { inbound_event_id: rows[SECOND_INDEX]!.id },
    ],
  });
  assert.deepEqual(fetched.requests, [
    {
      method: "GET",
      url: JIRA_LIST_URL,
      authorization: JIRA_BASIC_AUTHORIZATION,
      body: undefined,
    },
  ]);
  assert.equal(h.reads.length, NO_CALLS);
  assert.deepEqual(h.held, [answer.items.map((item) => item.inbound_event_id)]);
  assert.deepEqual(h.drops, [CREDENTIAL]);
  assert.equal(h.outbound().total, NO_ROWS);
});

test("a Jira link read takes one release of the binding credential for the resource of the binding", async (t) => {
  const h = harness(t, JIRA_BINDING);
  jiraList(t);
  const inbound = createIdentity("inbound");
  h.addJiraInbound(inbound);
  await h.read({ external_link: JIRA_LINK });
  assert.equal(h.grants.length, SINGLE_CALL);
  const grant = h.grants[FIRST_INDEX]!;
  assert.ok(grant.kind === GrantKind.Inbound);
  assert.equal(grant.inbound.credential, CREDENTIAL);
  assert.equal(grant.inbound.platform, InboundPlatform.Jira);
  assert.equal(grant.inbound.inboundId, inbound);
  assert.equal(grant.inbound.resource, JIRA_RESOURCE);
  assert.equal(grant.operation, InboundOperation.LinkRead);
});

test("a second Jira read stores no second row and answers the stored identities", async (t) => {
  const h = harness(t, JIRA_BINDING);
  jiraList(t);
  h.addJiraInbound(createIdentity("inbound"));
  const first = await h.read({ external_link: JIRA_LINK });
  const second = await h.read({ external_link: JIRA_LINK });
  assert.equal(h.events().length, TWO_ITEMS);
  assert.deepEqual(second, first);
});

test("a Jira link with no inbound answers 409 and calls no platform", async (t) => {
  const h = harness(t, JIRA_BINDING);
  const fetched = jiraList(t);
  await assert.rejects(
    h.read({ external_link: JIRA_LINK }),
    (error) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Conflict &&
      error.code === IntakeErrorCode.LinkInboundMissing,
  );
  assert.equal(fetched.requests.length, NO_CALLS);
});

test("a Jira 401 answers 502 with the Jira result class, stores no row and drops the material", async (t) => {
  const h = harness(t, JIRA_BINDING);
  mockJiraFetch(t, () => jsonResponse(JIRA_UNAUTHORIZED, {}));
  h.addJiraInbound(createIdentity("inbound"));
  await assert.rejects(h.read({ external_link: JIRA_LINK }), (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, BAD_GATEWAY_STATUS);
    assert.equal(
      error.code,
      `intake.platform.jira.${ResultClass.FinalRefusal}`,
    );
    assert.deepEqual(error.details, { status: JIRA_UNAUTHORIZED });
    return true;
  });
  assert.equal(h.events().length, NO_ROWS);
  assert.deepEqual(h.drops, [CREDENTIAL]);
});

const SLACK_LINK: ExternalLink = {
  kind: ExternalLinkKind.SlackThread,
  resource_identity: SLACK_RESOURCE_IDENTITY,
  channel: SLACK_CHANNEL,
  thread_ts: SLACK_THREAD_TS,
};
const SLACK_BINDING: ConversationBinding = {
  binding_id: BINDING_ID,
  project_id: PROJECT_ID,
  resource_identity: SLACK_RESOURCE_IDENTITY,
  platform: InboundPlatform.Slack,
  repository: SLACK_TEAM_ID,
  credential: CREDENTIAL,
};
const SLACK_RATE_LIMITED_STATUS = 429;

function slackList(t: TestContext) {
  return mockSlackFetch(t, () =>
    slackOkResponse(
      slackRepliesPage(
        slackParentMessage(),
        slackListedMessage(),
        slackListedMessage({ ts: SLACK_SECOND_REPLY_TS }),
      ),
    ),
  );
}

test("a Slack link read stores each reply other than the parent as slack_message under the newest slack inbound of the resource", async (t) => {
  const h = harness(t, SLACK_BINDING);
  const fetched = slackList(t);
  h.addSlackInbound(olderInboundId());
  const newest = createIdentity("inbound");
  h.addSlackInbound(newest);
  const answer = await h.read({ external_link: SLACK_LINK });
  const rows = h.events();
  assert.deepEqual(
    rows.map((row) => [row.inbound_id, row.event_id]),
    [
      [newest, SLACK_UPDATE_KEY],
      [newest, SLACK_SECOND_UPDATE_KEY],
    ],
  );
  assert.deepEqual(
    rows.map((row) => JSON.parse(String(row.metadata))),
    [{ event: SLACK_REPLY_LISTED_EVENT }, { event: SLACK_REPLY_LISTED_EVENT }],
  );
  assert.deepEqual(answer, {
    items: [
      { inbound_event_id: rows[FIRST_INDEX]!.id },
      { inbound_event_id: rows[SECOND_INDEX]!.id },
    ],
  });
  assert.deepEqual(
    fetched.requests.map(({ method, url, authorization }) => [
      method,
      url,
      authorization,
    ]),
    [["GET", SLACK_REPLIES_URL, `Bearer ${SLACK_USER_TOKEN}`]],
  );
  assert.equal(h.reads.length, NO_CALLS);
  assert.deepEqual(h.held, [answer.items.map((item) => item.inbound_event_id)]);
  assert.deepEqual(h.drops, [CREDENTIAL]);
  assert.equal(h.outbound().total, NO_ROWS);
});

test("a stored Slack reply decodes to the link update of its thread", async (t) => {
  const h = harness(t, SLACK_BINDING);
  slackList(t);
  h.addSlackInbound(createIdentity("inbound"));
  await h.read({ external_link: SLACK_LINK });
  const stored = h.store.database
    .prepare("SELECT event FROM intake_inbound_event ORDER BY rowid")
    .all() as { event: Uint8Array }[];
  const decoded = stored.map((row) =>
    decodeSlackLinkUpdate({
      resource_identity: SLACK_RESOURCE_IDENTITY,
      event: row.event,
      metadata: { event: SLACK_REPLY_LISTED_EVENT },
    }),
  );
  assert.deepEqual(
    decoded.map((update) => [update?.external_link, update?.update_key]),
    [
      [SLACK_LINK, SLACK_UPDATE_KEY],
      [SLACK_LINK, SLACK_SECOND_UPDATE_KEY],
    ],
  );
  assert.equal(decoded[FIRST_INDEX]?.actor_automated, false);
});

test("a Slack link read takes one release of the binding credential for the team of the binding", async (t) => {
  const h = harness(t, SLACK_BINDING);
  slackList(t);
  const inbound = createIdentity("inbound");
  h.addSlackInbound(inbound);
  await h.read({ external_link: SLACK_LINK });
  assert.equal(h.grants.length, SINGLE_CALL);
  const grant = h.grants[FIRST_INDEX]!;
  assert.ok(grant.kind === GrantKind.Inbound);
  assert.equal(grant.inbound.credential, CREDENTIAL);
  assert.equal(grant.inbound.platform, InboundPlatform.Slack);
  assert.equal(grant.inbound.inboundId, inbound);
  assert.equal(grant.inbound.resource, SLACK_TEAM_ID);
  assert.equal(grant.operation, InboundOperation.LinkRead);
});

test("a second Slack read stores no second row and answers the stored identities", async (t) => {
  const h = harness(t, SLACK_BINDING);
  slackList(t);
  h.addSlackInbound(createIdentity("inbound"));
  const first = await h.read({ external_link: SLACK_LINK });
  const second = await h.read({ external_link: SLACK_LINK });
  assert.equal(h.events().length, TWO_ITEMS);
  assert.deepEqual(second, first);
});

test("a Slack link with no inbound answers 409 and calls no platform", async (t) => {
  const h = harness(t, SLACK_BINDING);
  const fetched = slackList(t);
  await assert.rejects(
    h.read({ external_link: SLACK_LINK }),
    (error) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Conflict &&
      error.code === IntakeErrorCode.LinkInboundMissing,
  );
  assert.equal(fetched.requests.length, NO_CALLS);
});

test("a Slack answer with ok false answers 502 with the Slack result class, stores no row and drops the material", async (t) => {
  const h = harness(t, SLACK_BINDING);
  mockSlackFetch(t, () => slackErrorResponse("invalid_auth"));
  h.addSlackInbound(createIdentity("inbound"));
  await assert.rejects(h.read({ external_link: SLACK_LINK }), (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, BAD_GATEWAY_STATUS);
    assert.equal(
      error.code,
      `intake.platform.slack.${ResultClass.FinalRefusal}`,
    );
    assert.deepEqual(error.details, { status: null });
    return true;
  });
  assert.equal(h.events().length, NO_ROWS);
  assert.deepEqual(h.drops, [CREDENTIAL]);
});

const OTHER_JIRA_SITE = "other.atlassian.net";
const UPPER_CASE_JIRA_SITE = "ACME.atlassian.net";

test("a Jira link read with a credential of another site calls no Jira URL and answers the final refusal", async (t) => {
  const h = harness(t, JIRA_BINDING, {
    ...JIRA_METADATA,
    site: OTHER_JIRA_SITE,
  });
  const fetched = jiraList(t);
  h.addJiraInbound(createIdentity("inbound"));
  await assert.rejects(h.read({ external_link: JIRA_LINK }), (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, BAD_GATEWAY_STATUS);
    assert.equal(
      error.code,
      `intake.platform.jira.${ResultClass.FinalRefusal}`,
    );
    return true;
  });
  assert.equal(fetched.requests.length, NO_CALLS);
  assert.equal(h.events().length, NO_ROWS);
  assert.deepEqual(h.drops, [CREDENTIAL]);
});

test("a rate limit of Slack answers 502 retryable_refusal", async (t) => {
  const h = harness(t, SLACK_BINDING);
  h.addSlackInbound(createIdentity("inbound"));
  const answers = [
    () => slackResponse(SLACK_RATE_LIMITED_STATUS, {}),
    () => slackErrorResponse("ratelimited"),
  ];
  mockSlackFetch(t, () => answers.shift()!());
  for (let attempt = NO_CALLS; attempt < TWO_ITEMS; attempt += SINGLE_CALL) {
    await assert.rejects(
      h.read({ external_link: SLACK_LINK }),
      (error) =>
        error instanceof OperationError &&
        error.code === `intake.platform.slack.${ResultClass.RetryableRefusal}`,
    );
  }
  assert.equal(h.events().length, NO_ROWS);
});

test("a Jira link read with a credential of the same site in upper case reads", async (t) => {
  const h = harness(t, JIRA_BINDING, {
    ...JIRA_METADATA,
    site: UPPER_CASE_JIRA_SITE,
  });
  const fetched = jiraList(t);
  h.addJiraInbound(createIdentity("inbound"));
  const answer = await h.read({ external_link: JIRA_LINK });
  assert.equal(answer.items.length, TWO_ITEMS);
  assert.equal(fetched.requests.length, SINGLE_CALL);
});

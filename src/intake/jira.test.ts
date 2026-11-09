import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { background } from "../kernel/context.ts";
import { HttpMethod } from "../kernel/http.ts";
import {
  decodeJiraLinkUpdate,
  describeJiraEvent,
  type JiraCall,
  jiraCredentialsOf,
  listJiraComments,
  postJiraComment,
  readJiraAccount,
} from "./jira.ts";
import { ResultClass } from "./contract.ts";
import {
  adfDocument,
  adfParagraph,
  JIRA_ACCOUNT_ID,
  JIRA_APP_ACCOUNT_ID,
  JIRA_BASIC_AUTHORIZATION,
  JIRA_COMMENT_ID,
  JIRA_CREATED_MS,
  JIRA_DISPLAY_NAME,
  JIRA_ISSUE_KEY,
  JIRA_ISSUE_UPDATED_EVENT,
  JIRA_ISSUE_URL,
  JIRA_LIST_URL,
  JIRA_LISTED_EVENT,
  JIRA_METADATA,
  JIRA_MYSELF_URL,
  JIRA_POST_URL,
  JIRA_RESOURCE,
  JIRA_RESOURCE_IDENTITY,
  JIRA_SECOND_COMMENT_ID,
  JIRA_SITE,
  JIRA_TEXT_BODY,
  JIRA_TOKEN,
  JIRA_TOKEN_ACCOUNT_ID,
  JIRA_UPDATE_KEY,
  JIRA_WEBHOOK_EVENT,
  jiraAuthor,
  jiraBytes,
  jiraCommentFacts,
  jiraIssue,
  jiraListedComment,
  jiraListedPage,
  jiraWebhookComment,
  jsonResponse,
  mockJiraFetch,
  okResponse,
} from "./jira-test-support.ts";

const OTHER_PROJECT_IDENTITY = "conversation:jira:acme.atlassian.net/OPS";
const REPOSITORY_IDENTITY = "repository:github:acme/app";
const LONG_BODY_LENGTH = 70000;
const ADF_TEXT = "first line\none\ntwo\nbefore\nafter";

function decode(
  body: unknown,
  event: string = JIRA_WEBHOOK_EVENT,
  resource_identity: string = JIRA_RESOURCE_IDENTITY,
) {
  return decodeJiraLinkUpdate({
    resource_identity,
    event: jiraBytes(body),
    metadata: { event },
  });
}

function describe(body: unknown, event: string = JIRA_WEBHOOK_EVENT) {
  return describeJiraEvent({
    resource: JIRA_RESOURCE,
    event: jiraBytes(body),
    metadata: { event },
  });
}

test("a comment_created delivery decodes to its link, key and facts", () => {
  assert.deepEqual(decode(jiraWebhookComment()), {
    external_link: {
      kind: "jira_issue",
      resource_identity: JIRA_RESOURCE_IDENTITY,
      key: JIRA_ISSUE_KEY,
    },
    update_key: JIRA_UPDATE_KEY,
    actor_id: JIRA_ACCOUNT_ID,
    actor_automated: false,
    occurred_at: JIRA_CREATED_MS,
    mentions: [],
  });
});

test("a comment of an app account answers actor_automated true", () => {
  const update = decode(
    jiraWebhookComment({
      author: jiraAuthor({
        accountId: JIRA_APP_ACCOUNT_ID,
        accountType: "app",
      }),
    }),
  );
  assert.equal(update?.actor_automated, true);
  assert.equal(update?.actor_id, JIRA_APP_ACCOUNT_ID);
});

test("another event, another project and a broken body decode to null", () => {
  assert.equal(
    decode(
      jiraWebhookComment({}, { webhookEvent: JIRA_ISSUE_UPDATED_EVENT }),
      JIRA_ISSUE_UPDATED_EVENT,
    ),
    null,
  );
  assert.equal(decode(jiraWebhookComment(), JIRA_ISSUE_UPDATED_EVENT), null);
  assert.equal(
    decode(jiraWebhookComment({}, { webhookEvent: JIRA_ISSUE_UPDATED_EVENT })),
    null,
  );
  assert.equal(
    decode(jiraWebhookComment(), JIRA_WEBHOOK_EVENT, OTHER_PROJECT_IDENTITY),
    null,
  );
  assert.equal(
    decode(jiraWebhookComment({}, { issue: jiraIssue({ key: "OPS-1" }) })),
    null,
  );
  assert.equal(
    decode(
      jiraWebhookComment(
        {},
        {
          issue: jiraIssue({ fields: { project: { key: "OPS" } } }),
        },
      ),
    ),
    null,
  );
  assert.equal(
    decode(jiraWebhookComment(), JIRA_WEBHOOK_EVENT, REPOSITORY_IDENTITY),
    null,
  );
  for (const body of [
    {},
    [],
    "text",
    null,
    jiraWebhookComment({ id: undefined }),
    jiraWebhookComment({}, { issue: undefined }),
    jiraWebhookComment({}, { comment: undefined }),
  ])
    assert.equal(decode(body), null);
  assert.equal(
    decodeJiraLinkUpdate({
      resource_identity: JIRA_RESOURCE_IDENTITY,
      event: new Uint8Array(Buffer.from("{ broken")),
      metadata: { event: JIRA_WEBHOOK_EVENT },
    }),
    null,
  );
  assert.equal(
    decodeJiraLinkUpdate({
      resource_identity: JIRA_RESOURCE_IDENTITY,
      event: jiraBytes(jiraWebhookComment()),
      metadata: {},
    }),
    null,
  );
});

test("the description of a text body keeps the whole text", () => {
  const body = "x".repeat(LONG_BODY_LENGTH);
  assert.deepEqual(describe(jiraWebhookComment({ body })), {
    author: JIRA_DISPLAY_NAME,
    body,
    url: JIRA_ISSUE_URL,
    occurred_at: JIRA_CREATED_MS,
  });
  assert.equal(describe(jiraWebhookComment())?.body, JIRA_TEXT_BODY);
});

test("the description of an ADF body answers the text nodes with a newline between blocks", () => {
  const body = adfDocument(
    adfParagraph("first ", "line"),
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [adfParagraph("one")] },
        { type: "listItem", content: [adfParagraph("two")] },
      ],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "before" },
        { type: "hardBreak" },
        { type: "text", text: "after" },
      ],
    },
  );
  assert.equal(describe(jiraWebhookComment({ body }))?.body, ADF_TEXT);
});

const LISTED_ISSUE = { key: JIRA_ISSUE_KEY };
const ADF_REPLY = "first line\nsecond line";
const DEADLINE_MS = 30000;
const FIRST_INDEX = 0;
const ONE_REQUEST = 1;
const NO_REQUESTS = 0;
const TWO_COMMENTS = 2;
const UNAUTHORIZED = 401;
const BAD_REQUEST = 400;
const SERVER_ERROR = 503;
const RATE_LIMITED = 429;

function call(overrides: Partial<JiraCall> = {}): JiraCall {
  return {
    credentials: jiraCredentialsOf(JIRA_METADATA, { key: JIRA_TOKEN }),
    signal: background.signal,
    deadlineAt: Date.now() + DEADLINE_MS,
    ...overrides,
  };
}

function failure(answer: { ok: boolean }) {
  assert.ok(!answer.ok);
  return answer as unknown as {
    class: string;
    status: number | null;
    message: string;
  };
}

test("a listed comment decodes to the link update of its webhook and describes like it", () => {
  const listed = { issue: LISTED_ISSUE, comment: jiraCommentFacts() };
  assert.deepEqual(
    decode(listed, JIRA_LISTED_EVENT),
    decode(jiraWebhookComment()),
  );
  assert.deepEqual(
    describe(listed, JIRA_LISTED_EVENT),
    describe(jiraWebhookComment()),
  );
  assert.equal(
    decode({ comment: jiraCommentFacts() }, JIRA_LISTED_EVENT),
    null,
  );
});

test("the credentials of a call come from the metadata and the api key secret", () => {
  assert.deepEqual(jiraCredentialsOf(JIRA_METADATA, { key: JIRA_TOKEN }), {
    cloud_id: JIRA_METADATA.cloud_id,
    email: JIRA_METADATA.email,
    token: JIRA_TOKEN,
  });
  assert.throws(() => jiraCredentialsOf(null, { key: JIRA_TOKEN }));
  assert.throws(() => jiraCredentialsOf(JIRA_METADATA, {}));
});

test("the comment list reads one page newest first and answers one event for each comment", async (t) => {
  const fetched = mockJiraFetch(t, () =>
    okResponse(
      jiraListedPage(
        jiraListedComment(),
        jiraListedComment({ id: JIRA_SECOND_COMMENT_ID }),
      ),
    ),
  );
  const answer = await listJiraComments(call(), {
    site: JIRA_SITE,
    key: JIRA_ISSUE_KEY,
  });
  assert.ok(answer.ok);
  assert.deepEqual(fetched.requests, [
    {
      method: "GET",
      url: JIRA_LIST_URL,
      authorization: JIRA_BASIC_AUTHORIZATION,
      body: undefined,
    },
  ]);
  assert.deepEqual(
    answer.value.map(({ id, type }) => [id, type]),
    [
      [JIRA_UPDATE_KEY, JIRA_LISTED_EVENT],
      [
        `jira_comment:${JIRA_SITE}:${JIRA_SECOND_COMMENT_ID}`,
        JIRA_LISTED_EVENT,
      ],
    ],
  );
  assert.equal(answer.value.length, TWO_COMMENTS);
  const update = decodeJiraLinkUpdate({
    resource_identity: JIRA_RESOURCE_IDENTITY,
    event: answer.value[FIRST_INDEX]!.body,
    metadata: { event: JIRA_LISTED_EVENT },
  });
  assert.equal(update?.update_key, JIRA_UPDATE_KEY);
  assert.equal(update?.external_link.key, JIRA_ISSUE_KEY);
  assert.equal(update?.actor_id, JIRA_ACCOUNT_ID);
});

test("a failed read answers its result class and status", async (t: TestContext) => {
  for (const [status, expected] of [
    [UNAUTHORIZED, ResultClass.FinalRefusal],
    [SERVER_ERROR, ResultClass.RetryableRefusal],
    [RATE_LIMITED, ResultClass.RetryableRefusal],
  ] as const) {
    mockJiraFetch(t, () => jsonResponse(status, {}));
    const answer = failure(
      await listJiraComments(call(), { site: JIRA_SITE, key: JIRA_ISSUE_KEY }),
    );
    assert.equal(answer.class, expected);
    assert.equal(answer.status, status);
    t.mock.restoreAll();
  }
});

test("a read that cannot reach Jira or gets an unreadable body answers retryable_refusal with no status", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  const unreachable = failure(
    await listJiraComments(call(), { site: JIRA_SITE, key: JIRA_ISSUE_KEY }),
  );
  assert.equal(unreachable.class, ResultClass.RetryableRefusal);
  assert.equal(unreachable.status, null);
  t.mock.restoreAll();
  mockJiraFetch(t, () => okResponse({ comments: "none" }));
  const unreadable = failure(
    await listJiraComments(call(), { site: JIRA_SITE, key: JIRA_ISSUE_KEY }),
  );
  assert.equal(unreadable.class, ResultClass.RetryableRefusal);
});

test("a read after the deadline calls no platform", async (t) => {
  const fetched = mockJiraFetch(t, () => okResponse({}));
  const answer = failure(
    await listJiraComments(call({ deadlineAt: Date.now() - DEADLINE_MS }), {
      site: JIRA_SITE,
      key: JIRA_ISSUE_KEY,
    }),
  );
  assert.equal(answer.class, ResultClass.RetryableRefusal);
  assert.equal(fetched.requests.length, NO_REQUESTS);
});

test("the token account is the accountId of myself", async (t) => {
  const fetched = mockJiraFetch(t, () =>
    okResponse({ accountId: JIRA_TOKEN_ACCOUNT_ID }),
  );
  assert.deepEqual(await readJiraAccount(call()), {
    ok: true,
    value: JIRA_TOKEN_ACCOUNT_ID,
  });
  assert.deepEqual(
    fetched.requests.map(({ method, url }) => [method, url]),
    [["GET", JIRA_MYSELF_URL]],
  );
});

test("a post sends one ADF comment and answers the update key and the author", async (t) => {
  const fetched = mockJiraFetch(t, () =>
    jsonResponse(201, {
      id: JIRA_COMMENT_ID,
      author: { accountId: JIRA_TOKEN_ACCOUNT_ID },
    }),
  );
  assert.deepEqual(
    await postJiraComment(
      call(),
      { site: JIRA_SITE, key: JIRA_ISSUE_KEY },
      ADF_REPLY,
    ),
    {
      ok: true,
      value: { update_key: JIRA_UPDATE_KEY, actor_id: JIRA_TOKEN_ACCOUNT_ID },
    },
  );
  assert.equal(fetched.requests.length, ONE_REQUEST);
  const [sent] = fetched.requests;
  assert.equal(sent!.method, HttpMethod.Post);
  assert.equal(sent!.url, JIRA_POST_URL);
  assert.equal(sent!.authorization, JIRA_BASIC_AUTHORIZATION);
  assert.deepEqual(sent!.body, {
    body: {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "first line" }] },
        { type: "paragraph", content: [{ type: "text", text: "second line" }] },
      ],
    },
  });
});

test("a failed post answers unknown_outcome for a server error and a lost call, and final_refusal for a refusal", async (t) => {
  mockJiraFetch(t, () => jsonResponse(SERVER_ERROR, {}));
  const target = { site: JIRA_SITE, key: JIRA_ISSUE_KEY };
  const server = failure(await postJiraComment(call(), target, ADF_REPLY));
  assert.equal(server.class, ResultClass.UnknownOutcome);
  assert.equal(server.status, SERVER_ERROR);
  t.mock.restoreAll();
  mockJiraFetch(t, () => jsonResponse(BAD_REQUEST, {}));
  const refused = failure(await postJiraComment(call(), target, ADF_REPLY));
  assert.equal(refused.class, ResultClass.FinalRefusal);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  const lost = failure(await postJiraComment(call(), target, ADF_REPLY));
  assert.equal(lost.class, ResultClass.UnknownOutcome);
  assert.equal(lost.status, null);
  t.mock.restoreAll();
  const fetched = mockJiraFetch(t, () => okResponse({}));
  const late = failure(
    await postJiraComment(
      call({ deadlineAt: Date.now() - DEADLINE_MS }),
      target,
      ADF_REPLY,
    ),
  );
  assert.equal(late.class, ResultClass.ConfirmedFailure);
  assert.equal(fetched.requests.length, NO_REQUESTS);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeJiraLinkUpdate, describeJiraEvent } from "./jira.ts";
import {
  adfDocument,
  adfParagraph,
  JIRA_ACCOUNT_ID,
  JIRA_APP_ACCOUNT_ID,
  JIRA_CREATED_MS,
  JIRA_DISPLAY_NAME,
  JIRA_ISSUE_KEY,
  JIRA_ISSUE_UPDATED_EVENT,
  JIRA_ISSUE_URL,
  JIRA_RESOURCE,
  JIRA_RESOURCE_IDENTITY,
  JIRA_TEXT_BODY,
  JIRA_UPDATE_KEY,
  JIRA_WEBHOOK_EVENT,
  jiraAuthor,
  jiraBytes,
  jiraIssue,
  jiraWebhookComment,
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

test("the time of comment.created reads with an offset of the form +0000, +00:00 and Z", () => {
  for (const created of [
    "2026-10-15T03:57:51.123+0000",
    "2026-10-15T03:57:51.123+00:00",
    "2026-10-15T03:57:51.123Z",
    "2026-10-15T05:57:51.123+0200",
  ])
    assert.equal(
      decode(jiraWebhookComment({ created }))?.occurred_at,
      JIRA_CREATED_MS,
    );
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

test("a comment with no author answers a null actor", () => {
  const update = decode(jiraWebhookComment({ author: undefined }));
  assert.equal(update?.actor_id, null);
});

test("a comment without a valid comment.created decodes to null", () => {
  for (const created of [undefined, "", "yesterday", 17, null])
    assert.equal(decode(jiraWebhookComment({ created })), null);
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

test("the description answers null for another event, a missing author and a bad time", () => {
  assert.equal(
    describe(
      jiraWebhookComment({}, { webhookEvent: JIRA_ISSUE_UPDATED_EVENT }),
      JIRA_ISSUE_UPDATED_EVENT,
    ),
    null,
  );
  assert.equal(describe(jiraWebhookComment({ author: undefined })), null);
  assert.equal(describe(jiraWebhookComment({ created: "yesterday" })), null);
  assert.equal(describe(jiraWebhookComment({ body: 7 })), null);
  assert.equal(describe({}), null);
});

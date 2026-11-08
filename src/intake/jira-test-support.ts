import type { TestContext } from "node:test";
import { isString } from "../kernel/values.ts";

export const JIRA_SITE = "acme.atlassian.net";
export const JIRA_PROJECT_KEY = "KD";
export const JIRA_RESOURCE = `${JIRA_SITE}/${JIRA_PROJECT_KEY}`;
export const JIRA_RESOURCE_IDENTITY = `conversation:jira:${JIRA_RESOURCE}`;
export const JIRA_ISSUE_KEY = "KD-42";
export const JIRA_COMMENT_ID = "10042";
export const JIRA_ACCOUNT_ID = "712020:0a1b2c3d-4e5f";
export const JIRA_APP_ACCOUNT_ID = "5f0a1b2c3d4e5f6a7b8c9d0e";
export const JIRA_DISPLAY_NAME = "Ada Lovelace";
export const JIRA_CREATED = "2026-10-15T03:57:51.123+0000";
export const JIRA_CREATED_MS = Date.UTC(2026, 9, 15, 3, 57, 51, 123);
export const JIRA_WEBHOOK_EVENT = "comment_created";
export const JIRA_ISSUE_UPDATED_EVENT = "jira:issue_updated";
export const JIRA_UPDATE_KEY = `jira_comment:${JIRA_SITE}:${JIRA_COMMENT_ID}`;
export const JIRA_ISSUE_URL = `https://${JIRA_SITE}/browse/${JIRA_ISSUE_KEY}`;
export const JIRA_TEXT_BODY = "looks good to me";

export function jiraAuthor(overrides: object = {}): object {
  return {
    accountId: JIRA_ACCOUNT_ID,
    accountType: "atlassian",
    displayName: JIRA_DISPLAY_NAME,
    active: true,
    ...overrides,
  };
}

export function jiraCommentFacts(overrides: object = {}): object {
  return {
    id: JIRA_COMMENT_ID,
    author: jiraAuthor(),
    body: JIRA_TEXT_BODY,
    created: JIRA_CREATED,
    updated: JIRA_CREATED,
    ...overrides,
  };
}

export function jiraIssue(overrides: object = {}): object {
  return {
    id: "10001",
    key: JIRA_ISSUE_KEY,
    self: `https://${JIRA_SITE}/rest/api/2/issue/10001`,
    fields: { project: { key: JIRA_PROJECT_KEY } },
    ...overrides,
  };
}

export function jiraWebhookComment(
  comment: object = {},
  overrides: object = {},
): object {
  return {
    timestamp: JIRA_CREATED_MS,
    webhookEvent: JIRA_WEBHOOK_EVENT,
    issue: jiraIssue(),
    comment: jiraCommentFacts(comment),
    ...overrides,
  };
}

export function jiraCommentDelivery(accountType = "atlassian"): Buffer {
  return Buffer.from(
    JSON.stringify(jiraWebhookComment({ author: jiraAuthor({ accountType }) })),
  );
}

export const JIRA_COMMENT_DELIVERY_TEXT = JSON.stringify({
  webhookEvent: JIRA_WEBHOOK_EVENT,
  issue: { key: JIRA_ISSUE_KEY },
  comment: { id: JIRA_COMMENT_ID, created: JIRA_CREATED },
});

export const JIRA_ISSUE_UPDATED_DELIVERY_TEXT = JSON.stringify({
  webhookEvent: JIRA_ISSUE_UPDATED_EVENT,
});

export function adfDocument(...blocks: object[]): object {
  return { type: "doc", version: 1, content: blocks };
}

export function adfParagraph(...texts: string[]): object {
  return {
    type: "paragraph",
    content: texts.map((text) => ({ type: "text", text })),
  };
}

export function jiraBytes(value: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(value), "utf8"));
}

export const JIRA_LISTED_EVENT = "comment_listed";
export const JIRA_CLOUD_ID = "0b6e1f2c-7a41-4d6f-9b53-3c1f0a9d8e21";
export const JIRA_EMAIL = "bot@example.com";
export const JIRA_TOKEN = "test_private-jira-token";
export const JIRA_METADATA = {
  site: JIRA_SITE,
  cloud_id: JIRA_CLOUD_ID,
  email: JIRA_EMAIL,
};
export const JIRA_API_ORIGIN = `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}`;
export const JIRA_BASIC_AUTHORIZATION = `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64")}`;
export const JIRA_TOKEN_ACCOUNT_ID = "5b10ac8d82e05b22cc7d4ef5";
export const JIRA_SECOND_COMMENT_ID = "10043";
export const JIRA_COMMENTS_PATH = `/rest/api/3/issue/${JIRA_ISSUE_KEY}/comment`;
export const JIRA_LIST_URL = `${JIRA_API_ORIGIN}${JIRA_COMMENTS_PATH}?orderBy=-created&maxResults=100`;
export const JIRA_POST_URL = `${JIRA_API_ORIGIN}${JIRA_COMMENTS_PATH}`;
export const JIRA_MYSELF_URL = `${JIRA_API_ORIGIN}/rest/api/3/myself`;
const OK_STATUS = 200;

export interface JiraRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function okResponse(body: unknown): Response {
  return jsonResponse(OK_STATUS, body);
}

export function jiraListedPage(...comments: object[]): object {
  return {
    startAt: 0,
    maxResults: comments.length,
    total: comments.length,
    comments,
  };
}

export function jiraListedComment(overrides: object = {}): object {
  return {
    self: `https://${JIRA_SITE}/rest/api/3/issue/10001/comment/${JIRA_COMMENT_ID}`,
    ...jiraCommentFacts(overrides),
  };
}

export function mockJiraFetch(
  t: TestContext,
  answer: (request: JiraRequest) => Response | Promise<Response>,
): { requests: JiraRequest[] } {
  const requests: JiraRequest[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const request: JiraRequest = {
        method: init?.method ?? "GET",
        url: String(url),
        authorization: headers.get("authorization"),
        body: isString(init?.body) ? JSON.parse(init.body) : undefined,
      };
      requests.push(request);
      return answer(request);
    },
  );
  return { requests };
}

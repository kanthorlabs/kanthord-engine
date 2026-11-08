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

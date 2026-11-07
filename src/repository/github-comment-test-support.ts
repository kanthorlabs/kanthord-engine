export const COMMENT_REPOSITORY = "octo/widgets";
export const COMMENT_RESOURCE_IDENTITY = "conversation:github:octo/widgets";
export const COMMENT_ID = 1001;
export const COMMENT_NUMBER = 7;
export const COMMENT_CREATED_AT = "2026-10-15T03:57:51Z";
export const COMMENT_CREATED_AT_MS = Date.parse(COMMENT_CREATED_AT);
export const COMMENT_URL =
  "https://github.com/octo/widgets/issues/7#issuecomment-1001";
export const COMMENT_ISSUE_URL =
  "https://api.github.com/repos/octo/widgets/issues/7";
export const WEBHOOK_EVENT = "issue_comment";
export const LISTED_EVENT = "issue_comment_listed";
export const COMMENT_UPDATE_KEY = "issue_comment:1001";
export const COMMENT_USER_ID = 583231;
export const COMMENT_LOGIN = "octocat";

export function commentUser(overrides: object = {}): object {
  return {
    id: COMMENT_USER_ID,
    login: COMMENT_LOGIN,
    type: "User",
    ...overrides,
  };
}

export function commentFacts(overrides: object = {}): object {
  return {
    id: COMMENT_ID,
    user: commentUser(),
    body: "looks good",
    created_at: COMMENT_CREATED_AT,
    html_url: COMMENT_URL,
    performed_via_github_app: null,
    ...overrides,
  };
}

export function webhookComment(
  comment: object = {},
  overrides: object = {},
): object {
  return {
    action: "created",
    issue: { number: COMMENT_NUMBER },
    comment: commentFacts(comment),
    repository: { full_name: COMMENT_REPOSITORY },
    ...overrides,
  };
}

export function listedComment(overrides: object = {}): object {
  return commentFacts({ issue_url: COMMENT_ISSUE_URL, ...overrides });
}

export function commentBytes(value: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(value), "utf8"));
}

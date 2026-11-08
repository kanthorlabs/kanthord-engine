export const SLACK_TEAM_ID = "T01ABCDEF";
export const SLACK_RESOURCE_IDENTITY = `conversation:slack:${SLACK_TEAM_ID}`;
export const SLACK_USER_TOKEN = "test_private-slack-user-token";
export const SLACK_SIGNING_SECRET = "test_private-slack-signing-secret";
export const SLACK_AUTH_TEST_URL = "https://slack.com/api/auth.test";
export const SLACK_OK_ANSWER = JSON.stringify({ ok: true });
export const SLACK_NOT_OK_ANSWER = JSON.stringify({
  ok: false,
  error: "invalid_auth",
});
